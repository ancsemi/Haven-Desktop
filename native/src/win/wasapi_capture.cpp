// ═══════════════════════════════════════════════════════════
// Haven Desktop — Windows WASAPI Per-Process Audio Capture
//
// Captures audio from a single process using the Windows
// build 20348+ Process Loopback API.
//
// Flow:
//   1) ActivateAudioInterfaceAsync with process-loopback params
//   2) Initialize IAudioClient in shared mode, 48 kHz float32
//   3) Background thread reads capture buffer, converts to mono
//      float32, and pushes to the JS callback via AudioDataCb
//
// For app enumeration we use IAudioSessionEnumerator to list
// every active audio session and its owning PID.
// ═══════════════════════════════════════════════════════════
#ifdef PLATFORM_WINDOWS

#include "wasapi_capture.h"

// Windows headers — order matters
#include <initguid.h>
#include <windows.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <audiosessiontypes.h>
#include <functiondiscoverykeys_devpkey.h>
#include <Psapi.h>
#include <tlhelp32.h>
#include <combaseapi.h>

// Process Loopback API (Win10 2004+)
#include <audioclientactivationparams.h>

#include <vector>
#include <string>
#include <cstring>
#include <cmath>
#include <cstdint>
#include <algorithm>
#include <chrono>
#include <unordered_map>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "Avrt.lib")
#pragma comment(lib, "Psapi.lib")

constexpr uint32_t kOutputSampleRate = 48000;

enum class SampleEncoding {
    Float32,
    Pcm16,
    Pcm24,
    Pcm32,
};

struct CaptureFormat {
    SampleEncoding encoding = SampleEncoding::Float32;
    uint32_t channels = 0;
    uint32_t sampleRate = 0;
    uint16_t bytesPerSample = 0;
    uint16_t blockAlign = 0;
};

static_assert(sizeof(float) == 4, "WASAPI float32 requires 32-bit float");

static bool TryParseCaptureFormat(const WAVEFORMATEX* wave, CaptureFormat& result) {
    if (!wave || wave->nChannels == 0 || wave->nSamplesPerSec == 0) return false;
    const WORD bits = wave->wBitsPerSample;
    if (bits == 0 || bits % 8 != 0) return false;

    bool isFloat = false;
    bool isPcm = false;
    bool isExtensible = false;
    WORD validBits = bits;
    if (wave->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        isFloat = true;
    } else if (wave->wFormatTag == WAVE_FORMAT_PCM) {
        isPcm = true;
    } else if (wave->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        constexpr WORD kExtensibleExtraSize = 22;
        if (wave->cbSize < kExtensibleExtraSize) return false;
        isExtensible = true;
        const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wave);
        validBits = extensible->Samples.wValidBitsPerSample;
        if (IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
            isFloat = true;
        } else if (IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) {
            isPcm = true;
        } else {
            return false;
        }
    } else {
        return false;
    }

    CaptureFormat parsed;
    parsed.channels = wave->nChannels;
    parsed.sampleRate = wave->nSamplesPerSec;
    parsed.blockAlign = wave->nBlockAlign;
    if (isFloat) {
        if (bits != 32 || (isExtensible && validBits != 32)) return false;
        parsed.encoding = SampleEncoding::Float32;
        parsed.bytesPerSample = 4;
    } else if (isPcm) {
        if (isExtensible && (validBits == 0 || validBits > bits)) return false;
        if (bits == 16) {
            parsed.encoding = SampleEncoding::Pcm16;
            parsed.bytesPerSample = 2;
        } else if (bits == 24) {
            parsed.encoding = SampleEncoding::Pcm24;
            parsed.bytesPerSample = 3;
        } else if (bits == 32) {
            parsed.encoding = SampleEncoding::Pcm32;
            parsed.bytesPerSample = 4;
        } else {
            return false;
        }
    }

    const uint32_t expectedBlockAlign = parsed.channels * parsed.bytesPerSample;
    if (expectedBlockAlign == 0 || expectedBlockAlign > UINT16_MAX ||
        wave->nBlockAlign != expectedBlockAlign) {
        return false;
    }
    result = parsed;
    return true;
}

static float ReadCaptureSample(const BYTE* sample, SampleEncoding encoding) {
    if (encoding == SampleEncoding::Float32) {
        float value = 0.0f;
        std::memcpy(&value, sample, sizeof(value));
        return std::isfinite(value) ? value : 0.0f;
    }
    if (encoding == SampleEncoding::Pcm16) {
        int16_t value = 0;
        std::memcpy(&value, sample, sizeof(value));
        return static_cast<float>(value) / 32768.0f;
    }
    if (encoding == SampleEncoding::Pcm24) {
        const uint32_t raw = static_cast<uint32_t>(sample[0]) |
            (static_cast<uint32_t>(sample[1]) << 8) |
            (static_cast<uint32_t>(sample[2]) << 16);
        const int32_t value = (raw & 0x00800000u)
            ? static_cast<int32_t>(raw) - 0x01000000
            : static_cast<int32_t>(raw);
        return static_cast<float>(static_cast<double>(value) / 8388608.0);
    }

    int32_t value = 0;
    std::memcpy(&value, sample, sizeof(value));
    return static_cast<float>(static_cast<double>(value) / 2147483648.0);
}

static void DecodeToMono(const BYTE* data, UINT32 frames,
                         const CaptureFormat& format,
                         std::vector<float>& mono) {
    mono.resize(frames);
    for (UINT32 frameIndex = 0; frameIndex < frames; ++frameIndex) {
        const BYTE* frame = data + static_cast<size_t>(frameIndex) * format.blockAlign;
        double sum = 0.0;
        for (uint32_t channel = 0; channel < format.channels; ++channel) {
            sum += ReadCaptureSample(
                frame + static_cast<size_t>(channel) * format.bytesPerSample,
                format.encoding);
        }
        mono[frameIndex] = static_cast<float>(sum / format.channels);
    }
}

// The preferred format lets the Windows engine perform high-quality SRC. This
// fallback favors low CPU use when an endpoint only accepts its mix format.
class StreamingLinearResampler48k {
public:
    explicit StreamingLinearResampler48k(uint32_t inputRate)
        : m_inputRate(inputRate) {}

    void Reset() {
        m_inputFrames = 0;
        m_sourceIndex = 0;
        m_phase = 0;
        m_previousSample = 0.0f;
        m_hasPrevious = false;
    }

    void Process(const std::vector<float>& input, std::vector<float>& output) {
        output.clear();
        if (input.empty() || m_inputRate == 0) return;

        const uint64_t chunkStart = m_inputFrames;
        const uint64_t chunkEnd = chunkStart + input.size() - 1;
        const auto sampleAt = [&](uint64_t index) {
            if (index < chunkStart) {
                return m_hasPrevious ? m_previousSample : input.front();
            }
            return input[static_cast<size_t>(index - chunkStart)];
        };

        while (true) {
            const uint64_t rightIndex = m_sourceIndex + (m_phase == 0 ? 0u : 1u);
            if (rightIndex > chunkEnd) break;

            const float left = sampleAt(m_sourceIndex);
            float value = left;
            if (m_phase != 0) {
                const float right = sampleAt(m_sourceIndex + 1);
                const float fraction = static_cast<float>(m_phase) /
                    static_cast<float>(kOutputSampleRate);
                value = left + (right - left) * fraction;
            }
            output.push_back(value);

            const uint64_t advancedPhase = m_phase + m_inputRate;
            m_sourceIndex += advancedPhase / kOutputSampleRate;
            m_phase = advancedPhase % kOutputSampleRate;
        }

        m_previousSample = input.back();
        m_hasPrevious = true;
        m_inputFrames += input.size();
    }

private:
    uint32_t m_inputRate;
    uint64_t m_inputFrames = 0;
    uint64_t m_sourceIndex = 0;
    uint64_t m_phase = 0;
    float m_previousSample = 0.0f;
    bool m_hasPrevious = false;
};

// ── Helper: wide → UTF-8 ──────────────────────────────────
static std::string WideToUtf8(const wchar_t* wide) {
    if (!wide || !*wide) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
    std::string s(len - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, &s[0], len, nullptr, nullptr);
    return s;
}

// ── Helper: get process name from PID ─────────────────────
static std::string ProcessNameFromPid(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!h) return "Unknown";
    wchar_t buf[MAX_PATH] = {};
    DWORD sz = MAX_PATH;
    if (QueryFullProcessImageNameW(h, 0, buf, &sz)) {
        CloseHandle(h);
        std::wstring full(buf);
        auto pos = full.find_last_of(L"\\/");
        std::wstring fname = (pos != std::wstring::npos) ? full.substr(pos + 1) : full;
        // Strip .exe
        auto dot = fname.rfind(L".exe");
        if (dot != std::wstring::npos) fname = fname.substr(0, dot);
        return WideToUtf8(fname.c_str());
    }
    CloseHandle(h);
    return "Unknown";
}

static std::unordered_map<DWORD, DWORD> SnapshotProcessParents() {
    std::unordered_map<DWORD, DWORD> parents;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return parents;

    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            parents[entry.th32ProcessID] = entry.th32ParentProcessID;
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return parents;
}

static bool IsProcessInTree(DWORD pid, DWORD rootPid,
                            const std::unordered_map<DWORD, DWORD>& parents) {
    for (size_t depth = 0; pid != 0 && depth <= parents.size(); depth++) {
        if (pid == rootPid) return true;
        auto it = parents.find(pid);
        if (it == parents.end() || it->second == pid) break;
        pid = it->second;
    }
    return false;
}

// ── Completion handler for ActivateAudioInterfaceAsync ────
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    ActivateHandler() : m_refCount(1), m_hr(E_FAIL), m_client(nullptr), m_ftm(nullptr) {
        m_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        CoCreateFreeThreadedMarshaler(static_cast<IUnknown*>(static_cast<IActivateAudioInterfaceCompletionHandler*>(this)), &m_ftm);
    }
    ~ActivateHandler() {
        if (m_client) m_client->Release();
        if (m_ftm) m_ftm->Release();
        CloseHandle(m_event);
    }

    // IUnknown
    ULONG STDMETHODCALLTYPE AddRef()  override { return InterlockedIncrement(&m_refCount); }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG c = InterlockedDecrement(&m_refCount);
        if (c == 0) delete this;
        return c;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        if (riid == __uuidof(IAgileObject)) {
            *ppv = static_cast<IAgileObject*>(this);
            AddRef();
            return S_OK;
        }
        if (riid == __uuidof(IMarshal) && m_ftm) {
            return m_ftm->QueryInterface(riid, ppv);
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    // IActivateAudioInterfaceCompletionHandler
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hrActivate = E_FAIL;
        IUnknown* punk = nullptr;
        HRESULT hr = op->GetActivateResult(&hrActivate, &punk);
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && punk) {
            punk->QueryInterface(__uuidof(IAudioClient), (void**)&m_client);
            punk->Release();
            m_hr = S_OK;
        } else {
            m_hr = FAILED(hr) ? hr : hrActivate;
        }
        SetEvent(m_event);
        return S_OK;
    }

    HRESULT Wait(DWORD ms = 5000) {
        const DWORD waitResult = WaitForSingleObject(m_event, ms);
        if (waitResult == WAIT_TIMEOUT) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        if (waitResult != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(GetLastError());
        return m_hr;
    }

    IAudioClient* TakeClient() {
        IAudioClient* client = m_client;
        m_client = nullptr;
        return client;
    }

private:
    ULONG         m_refCount;
    HRESULT       m_hr;
    IAudioClient* m_client;
    IUnknown*     m_ftm;
    HANDLE        m_event;
};

static HRESULT ActivateProcessLoopbackClient(PROPVARIANT* activationParams,
                                              IAudioClient** result) {
    if (!activationParams || !result) return E_POINTER;
    *result = nullptr;

    auto* handler = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        activationParams,
        handler,
        &asyncOp);
    if (SUCCEEDED(hr)) hr = handler->Wait(5000);
    if (SUCCEEDED(hr)) {
        *result = handler->TakeClient();
        if (!*result) hr = E_FAIL;
    }
    if (asyncOp) asyncOp->Release();
    handler->Release();
    return hr;
}

static void ConfigureAudioClient(IAudioClient* client) {
    IAudioClient2* client2 = nullptr;
    if (client && SUCCEEDED(client->QueryInterface(
            __uuidof(IAudioClient2), reinterpret_cast<void**>(&client2)))) {
        AudioClientProperties props = {};
        props.cbSize = sizeof(AudioClientProperties);
        props.bIsOffload = FALSE;
        props.eCategory = AudioCategory_Other;
        props.Options = AUDCLNT_STREAMOPTIONS_NONE;
        client2->SetClientProperties(&props);
        client2->Release();
    }
}

namespace haven {

// ═══════════════════════════════════════════════════════════
// WasapiCapture
// ═══════════════════════════════════════════════════════════

WasapiCapture::WasapiCapture() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
}

WasapiCapture::~WasapiCapture() {
    StopCapture();
}

// ── IsSupported ────────────────────────────────────────────
// Process loopback activation is supported starting with build 20348.
bool WasapiCapture::IsSupported() const {
    OSVERSIONINFOEXW ovi = {};
    ovi.dwOSVersionInfoSize = sizeof(ovi);
    // Use RtlGetVersion (not deprecated like GetVersionEx)
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    auto RtlGetVersion = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    if (RtlGetVersion) {
        RtlGetVersion((PRTL_OSVERSIONINFOW)&ovi);
        // Windows Server 2022 / Windows 11 generation.
        return (ovi.dwMajorVersion > 10) ||
               (ovi.dwMajorVersion == 10 && ovi.dwBuildNumber >= 20348);
    }
    return false;
}

// ── GetAudioApplications ───────────────────────────────────
// Enumerates audio sessions via WASAPI session manager.
// Includes BOTH active AND inactive sessions so the picker can
// show apps that are paused/silent (a paused YouTube tab still
// has a session — users routinely want to resume + share it).
std::vector<AudioApp> WasapiCapture::GetAudioApplications() {
    std::vector<AudioApp> result;

    // Track PIDs we've already seen across all endpoints (avoid duplicates)
    std::vector<DWORD> seen;
    DWORD ourPid = GetCurrentProcessId();
    const auto processParents = SnapshotProcessParents();

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
        CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr)) return result;

    // Enumerate ALL active render endpoints, not just the default console one.
    // Some engines (MonoGame/XNA, FMOD, OpenAL) register audio sessions on a
    // non-default or non-console endpoint, so querying only eConsole misses them.
    IMMDeviceCollection* devices = nullptr;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices);
    if (FAILED(hr)) { enumerator->Release(); return result; }

    UINT numDevices = 0;
    devices->GetCount(&numDevices);

    for (UINT d = 0; d < numDevices; d++) {
        IMMDevice* device = nullptr;
        if (FAILED(devices->Item(d, &device))) continue;

        IAudioSessionManager2* mgr = nullptr;
        hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr);
        device->Release();
        if (FAILED(hr)) continue;

        IAudioSessionEnumerator* sessions = nullptr;
        hr = mgr->GetSessionEnumerator(&sessions);
        mgr->Release();
        if (FAILED(hr)) continue;

        int count = 0;
        sessions->GetCount(&count);

        for (int i = 0; i < count; i++) {
            IAudioSessionControl* ctrl = nullptr;
            if (FAILED(sessions->GetSession(i, &ctrl))) continue;

            IAudioSessionControl2* ctrl2 = nullptr;
            if (FAILED(ctrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctrl2))) {
                ctrl->Release(); continue;
            }

            // Skip system sounds and Haven Desktop itself (sharing our own
            // audio just creates a feedback loop — see issue #5305).
            if (ctrl2->IsSystemSoundsSession() == S_OK) {
                ctrl2->Release(); ctrl->Release(); continue;
            }

            DWORD pid = 0;
            ctrl2->GetProcessId(&pid);
            if (pid == 0 || IsProcessInTree(pid, ourPid, processParents) ||
                std::find(seen.begin(), seen.end(), pid) != seen.end()) {
                ctrl2->Release(); ctrl->Release(); continue;
            }
            seen.push_back(pid);

            AudioSessionState state = AudioSessionStateInactive;
            ctrl->GetState(&state);

            AudioApp app;
            app.pid    = pid;
            app.name   = ProcessNameFromPid(pid);
            app.active = (state == AudioSessionStateActive);
            // Skip sessions for processes we can't even name — usually short-lived
            // helpers that already exited.
            if (app.name == "Unknown") {
                ctrl2->Release(); ctrl->Release(); continue;
            }
            result.push_back(app);

            ctrl2->Release();
            ctrl->Release();
        }

        sessions->Release();
    }

    devices->Release();
    enumerator->Release();

    return result;
}

// ── emitStatus helper ──────────────────────────────────────
void WasapiCapture::emitStatus(CaptureStatusKind kind, const std::string& msg, int64_t code) {
    {
        char dbg[512];
        const char* kindStr = "?";
        switch (kind) {
            case CaptureStatusKind::Starting: kindStr = "STARTING"; break;
            case CaptureStatusKind::Started:  kindStr = "STARTED";  break;
            case CaptureStatusKind::Failed:   kindStr = "FAILED";   break;
            case CaptureStatusKind::Stopped:  kindStr = "STOPPED";  break;
        }
        _snprintf_s(dbg, sizeof(dbg), _TRUNCATE,
            "[Haven WASAPI] status=%s code=0x%llx msg=%s\n",
            kindStr, (long long)code, msg.c_str());
        OutputDebugStringA(dbg);
    }
    CaptureStatusCb cb;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        cb = m_statusCallback;
    }
    if (cb) {
        CaptureStatus s;
        s.kind = kind;
        s.message = msg;
        s.code = code;
        try { cb(s); } catch (...) {}
    }
}

// ── StartCapture ───────────────────────────────────────────
// Synchronously activates the audio interface so the caller
// gets an accurate true/false return based on actual init success.
// The background thread only runs the read loop after init succeeds.
bool WasapiCapture::StartCapture(uint32_t pid, CaptureMode mode,
                                 AudioDataCb dataCb, CaptureStatusCb statusCb) {
    StopCapture();

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_targetPid      = pid;
        m_mode           = mode;
        m_callback       = dataCb;
        m_statusCallback = statusCb;
    }

    {
        std::lock_guard<std::mutex> startLock(m_startMutex);
        m_startState = StartupState::Starting;
        m_startHr = E_PENDING;
    }

    // Pre-flight: verify PID is valid and accessible.
    {
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!h) {
            DWORD err = GetLastError();
            emitStatus(CaptureStatusKind::Failed,
                "OpenProcess failed for target PID — process may have exited or be protected",
                err);
            return false;
        }
        CloseHandle(h);
    }

    emitStatus(CaptureStatusKind::Starting,
        std::string("activating ") +
        (mode == CaptureMode::ExcludeProcess ? "EXCLUDE-mode" : "INCLUDE-mode") +
        " process loopback for PID " + std::to_string(pid));

    m_running = true;
    m_thread = std::thread([this]() { captureLoop(); });

    std::unique_lock<std::mutex> startLock(m_startMutex);
    bool signaled = m_startCv.wait_for(startLock, std::chrono::milliseconds(12000), [this]() {
        return m_startState != StartupState::Starting;
    });

    if (!signaled || m_startState == StartupState::Failed) {
        const bool timedOut = !signaled;
        const HRESULT timeoutHr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        if (timedOut) {
            m_startState = StartupState::Failed;
            m_startHr = timeoutHr;
        }
        m_running = false;
        startLock.unlock();
        if (timedOut) {
            emitStatus(CaptureStatusKind::Failed,
                "WASAPI activation timed out (>12s)", timeoutHr);
        }
        if (m_thread.joinable()) m_thread.join();
        return false;
    }

    return true;
}

// ── StopCapture ────────────────────────────────────────────
void WasapiCapture::StopCapture() {
    bool wasRunning = m_running.exchange(false);
    if (m_thread.joinable()) m_thread.join();
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_callback = nullptr;
    }
    {
        std::lock_guard<std::mutex> startLock(m_startMutex);
        m_startState = StartupState::Idle;
        m_startHr = S_OK;
    }
    if (wasRunning) {
        emitStatus(CaptureStatusKind::Stopped, "capture stopped");
    }
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_statusCallback = nullptr;
    }
}

void WasapiCapture::Cleanup() { StopCapture(); }

// ── Capture Loop ───────────────────────────────────────────
// Activation runs on this thread. We signal startup state via
// m_startCv as soon as init succeeds OR hard-fails so StartCapture
// can return synchronously with an accurate result. After init:
// just the read loop runs here.
void WasapiCapture::captureLoop() {
    auto failStart = [this](HRESULT hr, const std::string& msg) {
        bool shouldEmit = false;
        {
            std::lock_guard<std::mutex> startLock(m_startMutex);
            if (m_startState == StartupState::Starting) {
                m_startState = StartupState::Failed;
                m_startHr = hr;
                m_running = false;
                shouldEmit = true;
            }
        }
        m_startCv.notify_all();
        if (shouldEmit) emitStatus(CaptureStatusKind::Failed, msg, hr);
    };

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // ── Set up process-loopback activation params ──────────
    AUDIOCLIENT_ACTIVATION_PARAMS acParams = {};
    acParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    acParams.ProcessLoopbackParams.ProcessLoopbackMode =
        (m_mode == CaptureMode::ExcludeProcess)
            ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
            : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    acParams.ProcessLoopbackParams.TargetProcessId = m_targetPid;

    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize    = sizeof(acParams);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&acParams);

    // ── Activate the audio interface ───────────────────────
    IAudioClient* client = nullptr;
    HRESULT hr = ActivateProcessLoopbackClient(&pv, &client);

    if (FAILED(hr) || !client) {
        failStart(FAILED(hr) ? hr : E_FAIL,
            (hr == E_ACCESSDENIED)
                ? "Process loopback denied (target may be a protected/UWP process)"
                : "ActivateCompleted reported failure");
        CoUninitialize();
        return;
    }

    // ── Opt out of Windows communications ducking ──────────
    ConfigureAudioClient(client);

    // ── Configure format: 48 kHz, float32, stereo ─────────
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag      = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels       = 2;
    fmt.nSamplesPerSec  = kOutputSampleRate;
    fmt.wBitsPerSample  = 32;
    fmt.nBlockAlign     = fmt.nChannels * (fmt.wBitsPerSample / 8);
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    CaptureFormat captureFormat;
    captureFormat.encoding = SampleEncoding::Float32;
    captureFormat.channels = 2;
    captureFormat.sampleRate = kOutputSampleRate;
    captureFormat.bytesPerSample = 4;
    captureFormat.blockAlign = 8;

    hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0, 0, &fmt, nullptr
    );

    if (FAILED(hr)) {
        // The exact mix format is guaranteed to be accepted in shared mode.
        WAVEFORMATEX* mixFmt = nullptr;
        const HRESULT mixHr = client->GetMixFormat(&mixFmt);
        if (FAILED(mixHr) || !mixFmt) {
            if (mixFmt) CoTaskMemFree(mixFmt);
            failStart(FAILED(mixHr) ? mixHr : E_UNEXPECTED,
                "Initialize failed and GetMixFormat failed");
            client->Release();
            CoUninitialize();
            return;
        }

        CaptureFormat fallbackFormat;
        if (!TryParseCaptureFormat(mixFmt, fallbackFormat)) {
            CoTaskMemFree(mixFmt);
            failStart(AUDCLNT_E_UNSUPPORTED_FORMAT,
                "GetMixFormat returned an unsupported or malformed PCM/IEEE-float format");
            client->Release();
            CoUninitialize();
            return;
        }

        client->Release();
        client = nullptr;
        hr = ActivateProcessLoopbackClient(&pv, &client);
        if (FAILED(hr) || !client) {
            CoTaskMemFree(mixFmt);
            failStart(FAILED(hr) ? hr : E_FAIL,
                "Process loopback reactivation failed for the mix-format fallback");
            CoUninitialize();
            return;
        }
        ConfigureAudioClient(client);

        hr = client->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            0, 0, mixFmt, nullptr
        );
        CoTaskMemFree(mixFmt);
        if (FAILED(hr)) {
            failStart(hr,
                "IAudioClient::Initialize failed for both preferred and mix formats");
            client->Release();
            CoUninitialize();
            return;
        }
        captureFormat = fallbackFormat;
    }

    // ── Get capture client and start ──────────────────────
    IAudioCaptureClient* capture = nullptr;
    hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    if (FAILED(hr)) {
        failStart(hr,
            "GetService(IAudioCaptureClient) failed");
        client->Release();
        CoUninitialize();
        return;
    }

    hr = client->Start();
    if (FAILED(hr)) {
        failStart(hr, "IAudioClient::Start failed");
        capture->Release();
        client->Release();
        CoUninitialize();
        return;
    }

    bool startupAccepted = false;
    {
        std::lock_guard<std::mutex> startLock(m_startMutex);
        if (m_running && m_startState == StartupState::Starting) {
            m_startState = StartupState::Running;
            m_startHr = S_OK;
            startupAccepted = true;
        }
    }
    if (!startupAccepted) {
        client->Stop();
        capture->Release();
        client->Release();
        CoUninitialize();
        return;
    }
    m_startCv.notify_all();

    // Init succeeded — let StartCapture return true.
    {
        char dbg[320];
        _snprintf_s(dbg, sizeof(dbg), _TRUNCATE,
            "[Haven WASAPI] activation succeeded: mode=%s pid=%u rate=%u channels=%u bits=%u encoding=%s\n",
            (m_mode == CaptureMode::ExcludeProcess) ? "EXCLUDE" : "INCLUDE",
            m_targetPid,
            captureFormat.sampleRate,
            captureFormat.channels,
            captureFormat.bytesPerSample * 8u,
            captureFormat.encoding == SampleEncoding::Float32 ? "float32" : "pcm");
        OutputDebugStringA(dbg);
    }
    emitStatus(CaptureStatusKind::Started, "WASAPI process loopback active");

    // Emit one immediate silence packet so the renderer's "first packet
    // arrived" gate flips right away, even if the source app is silent.
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_callback) {
            std::vector<float> silence(480, 0.0f); // 10 ms at 48 kHz
            m_callback(silence.data(), silence.size());
        }
    }

    // ── Read loop ─────────────────────────────────────────
    std::vector<float> monoBuffer;
    monoBuffer.reserve(4800);
    std::vector<float> resampledBuffer;
    resampledBuffer.reserve(5200);
    StreamingLinearResampler48k resampler(captureFormat.sampleRate);

    DWORD lastPacketTickMs = GetTickCount();
    int   consecutiveErrors = 0;

    while (m_running) {
        Sleep(10);

        bool gotPacket = false;
        UINT32 packetLen = 0;
        while (m_running) {
            hr = capture->GetNextPacketSize(&packetLen);
            if (FAILED(hr)) {
                if (++consecutiveErrors >= 50) {
                    emitStatus(CaptureStatusKind::Failed,
                        "GetNextPacketSize repeatedly failed — aborting capture", hr);
                    m_running = false;
                }
                break;
            }
            if (packetLen == 0) break;
            consecutiveErrors = 0;

            BYTE*  data   = nullptr;
            UINT32 frames = 0;
            DWORD  flags  = 0;

            hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                if (++consecutiveErrors >= 50) {
                    emitStatus(CaptureStatusKind::Failed,
                        "GetBuffer repeatedly failed — aborting capture", hr);
                    m_running = false;
                }
                break;
            }

            if (frames > 0) {
                monoBuffer.clear();

                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
                    monoBuffer.assign(frames, 0.0f);
                } else {
                    DecodeToMono(data, frames, captureFormat, monoBuffer);
                }

                const std::vector<float>* outputBuffer = &monoBuffer;
                if (captureFormat.sampleRate != kOutputSampleRate) {
                    if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
                        resampler.Reset();
                    }
                    resampler.Process(monoBuffer, resampledBuffer);
                    outputBuffer = &resampledBuffer;
                }

                if (!outputBuffer->empty()) {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    if (m_callback) {
                        m_callback(outputBuffer->data(), outputBuffer->size());
                        gotPacket = true;
                        lastPacketTickMs = GetTickCount();
                    }
                }
            }

            capture->ReleaseBuffer(frames);
        }

        // Heartbeat: if the source app has been silent for >250 ms, push
        // a silence packet so the receive side keeps a live data stream
        // (and the renderer-side "first packet arrived" gate keeps firing
        // even for paused sources).
        if (!gotPacket && (GetTickCount() - lastPacketTickMs) > 250) {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_callback) {
                std::vector<float> silence(480, 0.0f);
                m_callback(silence.data(), silence.size());
                lastPacketTickMs = GetTickCount();
            }
        }
    }

    // ── Teardown ──────────────────────────────────────────
    client->Stop();
    capture->Release();
    client->Release();
    CoUninitialize();
}

// ── Factory ───────────────────────────────────────────────
IAudioCapture* CreateAudioCapture() {
    return new WasapiCapture();
}

} // namespace haven

#endif // PLATFORM_WINDOWS

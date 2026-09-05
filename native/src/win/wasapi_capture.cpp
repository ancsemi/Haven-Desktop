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
#include <algorithm>
#include <chrono>
#include <unordered_map>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "Avrt.lib")
#pragma comment(lib, "Psapi.lib")

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
        WaitForSingleObject(m_event, ms);
        return m_hr;
    }

    IAudioClient* GetClient() { return m_client; }

private:
    ULONG         m_refCount;
    HRESULT       m_hr;
    IAudioClient* m_client;
    IUnknown*     m_ftm;
    HANDLE        m_event;
};

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
        if (!signaled) {
            emitStatus(CaptureStatusKind::Failed,
                "WASAPI activation timed out (>12s)", 0);
        }
        m_running = false;
        startLock.unlock();
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
        emitStatus(CaptureStatusKind::Failed, msg, hr);
        {
            std::lock_guard<std::mutex> startLock(m_startMutex);
            m_startState = StartupState::Failed;
            m_startHr = hr;
        }
        m_startCv.notify_all();
        m_running = false;
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
    auto handler = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &pv,
        handler,
        &asyncOp
    );

    if (FAILED(hr)) {
        failStart(hr,
            "ActivateAudioInterfaceAsync returned failure (process loopback API may be unavailable)");
        handler->Release();
        CoUninitialize();
        return;
    }

    hr = handler->Wait(8000);
    IAudioClient* client = handler->GetClient();
    if (asyncOp) asyncOp->Release();
    handler->Release();

    if (FAILED(hr) || !client) {
        failStart(FAILED(hr) ? hr : E_FAIL,
            (hr == E_ACCESSDENIED)
                ? "Process loopback denied (target may be a protected/UWP process)"
                : "ActivateCompleted reported failure");
        CoUninitialize();
        return;
    }

    // ── Opt out of Windows communications ducking ──────────
    {
        IAudioClient2* client2 = nullptr;
        if (SUCCEEDED(client->QueryInterface(__uuidof(IAudioClient2), (void**)&client2))) {
            AudioClientProperties props = {};
            props.cbSize    = sizeof(AudioClientProperties);
            props.bIsOffload = FALSE;
            props.eCategory = AudioCategory_Other;
            props.Options   = AUDCLNT_STREAMOPTIONS_NONE;
            client2->SetClientProperties(&props);
            client2->Release();
        }
    }

    // ── Configure format: 48 kHz, float32, stereo ─────────
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag      = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels       = 2;
    fmt.nSamplesPerSec  = 48000;
    fmt.wBitsPerSample  = 32;
    fmt.nBlockAlign     = fmt.nChannels * (fmt.wBitsPerSample / 8);
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    int captureChannels    = 2;
    bool captureIsFloat    = true;
    int  captureBitsPerSample = 32;

    hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0, 0, &fmt, nullptr
    );

    if (FAILED(hr)) {
        // Fallback to mix format
        WAVEFORMATEX* mixFmt = nullptr;
        client->GetMixFormat(&mixFmt);
        if (mixFmt) {
            captureChannels       = mixFmt->nChannels;
            captureBitsPerSample  = mixFmt->wBitsPerSample;
            captureIsFloat        = (mixFmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) ||
                                    (mixFmt->wFormatTag == 0xFFFE
                                     && mixFmt->wBitsPerSample == 32);
            HRESULT hr2 = client->Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                0, 0, mixFmt, nullptr
            );
            CoTaskMemFree(mixFmt);
            if (FAILED(hr2)) {
                failStart(hr2,
                    "IAudioClient::Initialize failed for both preferred and mix formats");
                client->Release();
                CoUninitialize();
                return;
            }
        } else {
            failStart(hr,
                "Initialize failed and GetMixFormat returned no format");
            client->Release();
            CoUninitialize();
            return;
        }
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

    {
        std::lock_guard<std::mutex> startLock(m_startMutex);
        m_startState = StartupState::Running;
        m_startHr = S_OK;
    }
    m_startCv.notify_all();

    // Init succeeded — let StartCapture return true.
    {
        char dbg[256];
        _snprintf_s(dbg, sizeof(dbg), _TRUNCATE,
            "[Haven WASAPI] activation succeeded: mode=%s pid=%u channels=%d bits=%d isFloat=%d\n",
            (m_mode == CaptureMode::ExcludeProcess) ? "EXCLUDE" : "INCLUDE",
            m_targetPid, captureChannels, captureBitsPerSample, captureIsFloat ? 1 : 0);
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
                const float* fdata = reinterpret_cast<const float*>(data);
                monoBuffer.clear();

                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
                    monoBuffer.resize(frames, 0.0f);
                } else if (captureIsFloat && captureBitsPerSample == 32) {
                    for (UINT32 f = 0; f < frames; f++) {
                        float sum = 0.0f;
                        for (int ch = 0; ch < captureChannels; ch++) {
                            sum += fdata[f * captureChannels + ch];
                        }
                        monoBuffer.push_back(sum / (float)captureChannels);
                    }
                } else if (!captureIsFloat && captureBitsPerSample == 16) {
                    const int16_t* idata = reinterpret_cast<const int16_t*>(data);
                    for (UINT32 f = 0; f < frames; f++) {
                        float sum = 0.0f;
                        for (int ch = 0; ch < captureChannels; ch++) {
                            sum += idata[f * captureChannels + ch] / 32768.0f;
                        }
                        monoBuffer.push_back(sum / (float)captureChannels);
                    }
                } else {
                    for (UINT32 f = 0; f < frames; f++) {
                        float left  = fdata[f * 2];
                        float right = fdata[f * 2 + 1];
                        monoBuffer.push_back((left + right) * 0.5f);
                    }
                }

                std::lock_guard<std::mutex> lock(m_mutex);
                if (m_callback) {
                    m_callback(monoBuffer.data(), monoBuffer.size());
                    gotPacket = true;
                    lastPacketTickMs = GetTickCount();
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

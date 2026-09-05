// ═══════════════════════════════════════════════════════════
// Haven Desktop — N-API Addon Entry Point
//
// Exports:
//   isSupported()                → boolean
//   getAudioApplications()      → Array<{pid, name, icon}>
//   startCapture(pid, callback) → undefined
//   stopCapture()               → undefined
//   cleanup()                   → undefined
// ═══════════════════════════════════════════════════════════

#include <napi.h>
#include "audio_capture.h"
#include <memory>
#include <cstring>
#include <chrono>
#include <vector>

static std::unique_ptr<haven::IAudioCapture> g_capture;

// ── Ensure the platform-specific capture object exists ─────
static haven::IAudioCapture* Cap() {
    if (!g_capture) g_capture.reset(haven::CreateAudioCapture());
    return g_capture.get();
}

// ── isSupported() ──────────────────────────────────────────
static Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), Cap()->IsSupported());
}

// ── getAudioApplications() ─────────────────────────────────
static Napi::Value GetAudioApplications(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto apps = Cap()->GetAudioApplications();

    Napi::Array arr = Napi::Array::New(env, apps.size());
    for (size_t i = 0; i < apps.size(); i++) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("pid",    Napi::Number::New(env, apps[i].pid));
        obj.Set("name",   Napi::String::New(env, apps[i].name));
        obj.Set("icon",   Napi::String::New(env, apps[i].icon));
        obj.Set("active", Napi::Boolean::New(env, apps[i].active));
        arr[i] = obj;
    }
    return arr;
}

// ── Threadsafe callback wrapper ────────────────────────────
// The native capture thread calls our lambda; we marshal PCM
// data to the JS thread via Napi::ThreadSafeFunction.
static Napi::ThreadSafeFunction g_tsfn;
static Napi::ThreadSafeFunction g_statusTsfn;

struct PendingAudioChunk {
    std::vector<float> samples;
    int64_t capturedAtMs;
};

static Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Accept either:
    //   startCapture(pid, dataCb)                         (legacy, INCLUDE)
    //   startCapture(pid, mode, dataCb [, statusCb])      (new)
    // mode is a string: "include", "exclude", or "system"
    if (info.Length() < 2 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "startCapture(pid, [mode], dataCb, [statusCb])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
    haven::CaptureMode mode = haven::CaptureMode::IncludeProcess;
    Napi::Function jsCb;
    Napi::Function jsStatusCb;
    bool haveStatusCb = false;

    if (info[1].IsString()) {
        std::string m = info[1].As<Napi::String>().Utf8Value();
        if (m == "exclude") mode = haven::CaptureMode::ExcludeProcess;
        if (m == "system") mode = haven::CaptureMode::SystemLoopback;
        if (info.Length() < 3 || !info[2].IsFunction()) {
            Napi::TypeError::New(env, "startCapture(pid, mode, dataCb, [statusCb])")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        jsCb = info[2].As<Napi::Function>();
        if (info.Length() >= 4 && info[3].IsFunction()) {
            jsStatusCb = info[3].As<Napi::Function>();
            haveStatusCb = true;
        }
    } else if (info[1].IsFunction()) {
        jsCb = info[1].As<Napi::Function>();
        if (info.Length() >= 3 && info[2].IsFunction()) {
            jsStatusCb = info[2].As<Napi::Function>();
            haveStatusCb = true;
        }
    } else {
        Napi::TypeError::New(env, "startCapture: dataCb must be a function")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // At 10 ms per chunk, four pending calls cap native-to-JS backlog at
    // roughly 40 ms. NonBlockingCall drops new chunks if JS falls behind.
    g_tsfn = Napi::ThreadSafeFunction::New(env, jsCb, "HavenAudioCapture", 4, 1);
    if (haveStatusCb) {
        g_statusTsfn = Napi::ThreadSafeFunction::New(env, jsStatusCb, "HavenAudioStatus", 8, 1);
    }

    haven::AudioDataCb nativeCb = [](const float* data, size_t count) {
        if (!data || count == 0) {
            return;
        }

        auto* chunk = new PendingAudioChunk();
        chunk->samples.assign(data, data + count);
        chunk->capturedAtMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();

        napi_status status = g_tsfn.NonBlockingCall(chunk,
            [](Napi::Env env, Napi::Function fn, PendingAudioChunk* pending) {
            // Use JS-owned backing memory to avoid external buffer lifetime issues.
            const size_t count = pending->samples.size();
            Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, count * sizeof(float));
            std::memcpy(ab.Data(), pending->samples.data(), count * sizeof(float));
            Napi::Float32Array f32 = Napi::Float32Array::New(env, count, ab, 0);
            fn.Call({ f32, Napi::Number::New(env, static_cast<double>(pending->capturedAtMs)) });
            delete pending;
        });

        if (status != napi_ok) {
            delete chunk;
        }
    };

    haven::CaptureStatusCb nativeStatusCb;
    if (haveStatusCb) {
        nativeStatusCb = [](const haven::CaptureStatus& s) {
            // Box on heap so we can ferry across threads.
            auto* boxed = new haven::CaptureStatus(s);
            const napi_status status = g_statusTsfn.NonBlockingCall(boxed,
                [](Napi::Env env, Napi::Function fn, haven::CaptureStatus* st) {
                    Napi::Object obj = Napi::Object::New(env);
                    const char* k = "?";
                    switch (st->kind) {
                        case haven::CaptureStatusKind::Starting: k = "starting"; break;
                        case haven::CaptureStatusKind::Started:  k = "started";  break;
                        case haven::CaptureStatusKind::Failed:   k = "failed";   break;
                        case haven::CaptureStatusKind::Stopped:  k = "stopped";  break;
                    }
                    obj.Set("kind",    Napi::String::New(env, k));
                    obj.Set("message", Napi::String::New(env, st->message));
                    obj.Set("code",    Napi::Number::New(env, (double)st->code));
                    fn.Call({ obj });
                    delete st;
                });
            if (status != napi_ok) delete boxed;
        };
    }

    bool ok = Cap()->StartCapture(pid, mode, nativeCb, nativeStatusCb);
    if (!ok) {
        if (g_tsfn)        { g_tsfn.Release();        g_tsfn = {}; }
        if (g_statusTsfn)  { g_statusTsfn.Release();  g_statusTsfn = {}; }
        // Don't throw — the status callback (if provided) already reported
        // the reason. Returning false is sufficient and lets JS act on it.
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, true);
}

// ── stopCapture() ──────────────────────────────────────────
static Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Cap()->StopCapture();
    if (g_tsfn)       { g_tsfn.Release();       g_tsfn = {}; }
    if (g_statusTsfn) { g_statusTsfn.Release(); g_statusTsfn = {}; }
    return info.Env().Undefined();
}

// ── cleanup() ──────────────────────────────────────────────
static Napi::Value Cleanup(const Napi::CallbackInfo& info) {
    Cap()->Cleanup();
    if (g_tsfn)       { g_tsfn.Release();       g_tsfn = {}; }
    if (g_statusTsfn) { g_statusTsfn.Release(); g_statusTsfn = {}; }
    return info.Env().Undefined();
}

// ── optOutOfDucking() ──────────────────────────────────────
// Finds audio sessions belonging to our own process and calls
// SetDuckingPreference(TRUE) to prevent Windows from lowering
// Haven Desktop's volume when WebRTC voice calls are active.
#ifdef _WIN32
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>

static Napi::Value OptOutOfDucking(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    DWORD myPid = GetCurrentProcessId();
    int opted = 0;

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
        CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr)) return Napi::Number::New(env, 0);

    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr)) { enumerator->Release(); return Napi::Number::New(env, 0); }

    IAudioSessionManager2* mgr = nullptr;
    hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr);
    if (FAILED(hr)) { device->Release(); enumerator->Release(); return Napi::Number::New(env, 0); }

    IAudioSessionEnumerator* sessions = nullptr;
    hr = mgr->GetSessionEnumerator(&sessions);
    if (FAILED(hr)) { mgr->Release(); device->Release(); enumerator->Release(); return Napi::Number::New(env, 0); }

    int count = 0;
    sessions->GetCount(&count);

    for (int i = 0; i < count; i++) {
        IAudioSessionControl* ctrl = nullptr;
        if (FAILED(sessions->GetSession(i, &ctrl))) continue;

        IAudioSessionControl2* ctrl2 = nullptr;
        if (FAILED(ctrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctrl2))) {
            ctrl->Release(); continue;
        }

        DWORD pid = 0;
        ctrl2->GetProcessId(&pid);
        if (pid == myPid) {
            hr = ctrl2->SetDuckingPreference(TRUE);
            if (SUCCEEDED(hr)) opted++;
        }

        ctrl2->Release();
        ctrl->Release();
    }

    sessions->Release();
    mgr->Release();
    device->Release();
    enumerator->Release();

    return Napi::Number::New(env, opted);
}
#else
static Napi::Value OptOutOfDucking(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), 0);
}
#endif

// ── Module init ────────────────────────────────────────────
static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isSupported",           Napi::Function::New(env, IsSupported));
    exports.Set("getAudioApplications",  Napi::Function::New(env, GetAudioApplications));
    exports.Set("startCapture",          Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture",           Napi::Function::New(env, StopCapture));
    exports.Set("cleanup",              Napi::Function::New(env, Cleanup));
    exports.Set("optOutOfDucking",       Napi::Function::New(env, OptOutOfDucking));
    return exports;
}

NODE_API_MODULE(haven_audio, Init)

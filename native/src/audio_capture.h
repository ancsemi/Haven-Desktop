// ═══════════════════════════════════════════════════════════
// Haven Desktop — Cross-platform Audio Capture Interface
// ═══════════════════════════════════════════════════════════
#pragma once

#include <string>
#include <vector>
#include <functional>
#include <cstdint>

namespace haven {

// Represents an application currently producing audio
struct AudioApp {
    uint32_t    pid;
    std::string name;
    std::string icon;   // base64 data-URL, or empty
    bool        active = true; // false = the session exists but is currently silent
};

// Callback: receives mono float32 PCM samples at 48 kHz
//   data       – pointer to sample buffer
//   frameCount – number of samples
using AudioDataCb = std::function<void(const float* data, size_t frameCount)>;

// Status events emitted by the native capture path so JS can
// distinguish "init failed" from "init succeeded but app is silent".
enum class CaptureStatusKind {
    Starting,   // about to attempt activation
    Started,    // activation + Start() succeeded; PCM may follow
    Failed,     // hard failure (init or runtime). Capture stopped.
    Stopped,    // clean shutdown
};

struct CaptureStatus {
    CaptureStatusKind kind;
    std::string       message;   // human-readable detail
    int64_t           code = 0;  // platform error code (HRESULT on Win, errno on Linux)
};

using CaptureStatusCb = std::function<void(const CaptureStatus&)>;

// What kind of capture do we want?
//   IncludeProcess: capture audio FROM the given PID (and its children)
//   ExcludeProcess: capture ALL system audio EXCEPT the given PID tree
//                   (Windows process loopback; Linux isolated routing.)
//   SystemLoopback: raw default-output monitor (internal Linux fallback only).
enum class CaptureMode {
    IncludeProcess,
    ExcludeProcess,
    SystemLoopback,
};

// Abstract per-platform audio capture
class IAudioCapture {
public:
    virtual ~IAudioCapture() = default;

    virtual bool                  IsSupported()          const = 0;
    virtual std::vector<AudioApp> GetAudioApplications()       = 0;

    // New 4-arg API. The pre-existing 2-arg startCapture is implemented
    // in terms of this for backwards compatibility.
    virtual bool StartCapture(uint32_t        pid,
                              CaptureMode     mode,
                              AudioDataCb     dataCb,
                              CaptureStatusCb statusCb) = 0;

    // Backwards-compatible shim — IncludeProcess, no status callback.
    bool StartCapture(uint32_t pid, AudioDataCb cb) {
        return StartCapture(pid, CaptureMode::IncludeProcess, std::move(cb), nullptr);
    }

    virtual void                  StopCapture()                = 0;
    virtual void                  Cleanup()                    = 0;
};

// Factory — returns the right implementation per OS
IAudioCapture* CreateAudioCapture();

} // namespace haven

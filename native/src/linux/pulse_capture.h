// ═══════════════════════════════════════════════════════════
// Haven Desktop — Linux PulseAudio Per-App Audio Capture
//
// Isolates audio from a single application by:
//   1) Creating a virtual null sink
//   2) Moving the target app's playback stream to it
//   3) Recording from the null sink's monitor source
//   4) Also connecting the null sink back to the real output
//      so the user still hears the application
//
// PipeWire-safe mode (auto-detected):
//   Uses module-combine-sink instead of directly moving sink
//   inputs, avoiding the destabilizing stream disconnection
//   that crashes Chromium-based apps on PipeWire hosts.
//
// Works on PulseAudio and PipeWire (via pipewire-pulse compat)
// ═══════════════════════════════════════════════════════════
#pragma once
#ifdef PLATFORM_LINUX

#include "../audio_capture.h"
#include <thread>
#include <atomic>
#include <mutex>

namespace haven {

class PulseCapture : public IAudioCapture {
public:
    PulseCapture();
    ~PulseCapture() override;

    bool                  IsSupported()          const override;
    std::vector<AudioApp> GetAudioApplications()       override;
    bool                  StartCapture(uint32_t pid,
                                       CaptureMode mode,
                                       AudioDataCb dataCb,
                                       CaptureStatusCb statusCb) override;
    void                  StopCapture()                override;
    void                  Cleanup()                    override;

private:
    void captureLoop();
    void emitStatus(CaptureStatusKind kind, const std::string& msg, int64_t code = 0);

    std::atomic<bool> m_running{false};
    std::thread       m_thread;
    AudioDataCb       m_callback;
    CaptureStatusCb   m_statusCallback;
    uint32_t          m_targetPid = 0;
    CaptureMode       m_mode = CaptureMode::IncludeProcess;
    std::mutex        m_mutex;
    uint32_t          m_nullSinkModule = UINT32_MAX; // PulseAudio module index
    uint32_t          m_loopbackModule = UINT32_MAX; // loopback/combine module index
};

} // namespace haven

#endif // PLATFORM_LINUX

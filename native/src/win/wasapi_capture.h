// ═══════════════════════════════════════════════════════════
// Haven Desktop: Windows WASAPI Per-Process Audio Capture
//
// Uses the Windows build 19041+ Process Loopback API
// to capture audio exclusively from a single process tree.
//
// Key API:
//   ActivateAudioInterfaceAsync()
//     + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
//     + PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
//
// This is the same mechanism Discord uses for per-app audio.
// ═══════════════════════════════════════════════════════════
#pragma once
#ifdef PLATFORM_WINDOWS

#include "../audio_capture.h"
#include <windows.h>
#include <thread>
#include <atomic>
#include <mutex>
#include <condition_variable>

namespace haven {

// The process that owns a window, for offering a shared window's own audio.
struct WindowProcess {
    uint64_t    hwnd;
    uint32_t    pid;
    std::string name;
    std::string identity;
};

std::vector<WindowProcess> GetWindowProcesses(const std::vector<uint64_t>& hwnds);

class WasapiCapture : public IAudioCapture {
public:
    WasapiCapture();
    ~WasapiCapture() override;

    bool                  IsSupported()          const override;
    std::vector<AudioApp> GetAudioApplications()       override;
    bool                  StartCapture(uint32_t pid,
                                       CaptureMode mode,
                                       const std::string& expectedIdentity,
                                       AudioDataCb dataCb,
                                       CaptureStatusCb statusCb) override;
    void                  StopCapture()                override;
    void                  Cleanup()                    override;

private:
    enum class StartupState {
        Idle,
        Starting,
        Running,
        Failed
    };

    void captureLoop();
    void emitStatus(CaptureStatusKind kind, const std::string& msg, int64_t code = 0);

    std::atomic<bool> m_running{false};
    std::thread       m_thread;
    AudioDataCb       m_callback;
    CaptureStatusCb   m_statusCallback;
    uint32_t          m_targetPid = 0;
    CaptureMode       m_mode = CaptureMode::IncludeProcess;
    std::mutex        m_mutex;

    std::mutex              m_startMutex;
    std::condition_variable m_startCv;
    StartupState            m_startState{StartupState::Idle};
    HRESULT                 m_startHr{S_OK};
};

} // namespace haven

#endif // PLATFORM_WINDOWS

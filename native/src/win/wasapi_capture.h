// ═══════════════════════════════════════════════════════════
// Haven Desktop — Windows WASAPI Per-Process Audio Capture
//
// Uses the Windows 10 2004+ (build 19041) Process Loopback API
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

class WasapiCapture : public IAudioCapture {
public:
    WasapiCapture();
    ~WasapiCapture() override;

    bool                  IsSupported()          const override;
    std::vector<AudioApp> GetAudioApplications()       override;
    bool                  StartCapture(uint32_t pid, AudioDataCb cb) override;
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

    std::atomic<bool> m_running{false};
    std::thread       m_thread;
    AudioDataCb       m_callback;
    uint32_t          m_targetPid = 0;
    std::mutex        m_mutex;

    std::mutex              m_startMutex;
    std::condition_variable m_startCv;
    StartupState            m_startState{StartupState::Idle};
    HRESULT                 m_startHr{S_OK};
};

} // namespace haven

#endif // PLATFORM_WINDOWS

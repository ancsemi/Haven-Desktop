#if !defined(PLATFORM_WINDOWS) && !defined(PLATFORM_LINUX)

#include "audio_capture.h"

namespace haven {

class UnsupportedCapture final : public IAudioCapture {
public:
    bool IsSupported() const override { return false; }
    std::vector<AudioApp> GetAudioApplications() override { return {}; }

    bool StartCapture(uint32_t, CaptureMode, AudioDataCb, CaptureStatusCb statusCb) override {
        if (statusCb) {
            statusCb({ CaptureStatusKind::Failed,
                       "Per-application audio capture is unavailable on this platform", 0 });
        }
        return false;
    }

    void StopCapture() override {}
    void Cleanup() override {}
};

IAudioCapture* CreateAudioCapture() {
    return new UnsupportedCapture();
}

} // namespace haven

#endif

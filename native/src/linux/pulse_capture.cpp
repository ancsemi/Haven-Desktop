// ═══════════════════════════════════════════════════════════
// Haven Desktop — Linux PulseAudio Per-App Audio Capture
//
// Strategy:
//   1. Enumerate sink inputs → each has a PID + app name
//   2. Load module-null-sink (virtual sink "HavenCapture")
//   3. Move the target app's sink input to the null sink
//   4. Load module-loopback from null sink → default output
//      (so the user still hears the app)
//   5. Record from the null sink's monitor source at 48 kHz
//   6. On stop, unload modules and restore the app's original sink
//
// Requires: libpulse-dev  (or pipewire-pulse on modern distros)
// ═══════════════════════════════════════════════════════════
#ifdef PLATFORM_LINUX

#include "pulse_capture.h"

#include <pulse/pulseaudio.h>
#include <pulse/simple.h>
#include <pulse/error.h>

#include <cstring>
#include <cstdlib>
#include <vector>
#include <string>
#include <unistd.h>
#include <dirent.h>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <utility>

namespace haven {

// ── Helpers ───────────────────────────────────────────────

// Get process name from /proc/<pid>/comm
static std::string procName(uint32_t pid) {
    std::string path = "/proc/" + std::to_string(pid) + "/comm";
    std::ifstream f(path);
    std::string name;
    if (f.is_open() && std::getline(f, name)) {
        // Strip trailing newline
        while (!name.empty() && (name.back() == '\n' || name.back() == '\r'))
            name.pop_back();
        return name;
    }
    return "Unknown";
}

static uint32_t procParentPid(uint32_t pid) {
    std::ifstream f("/proc/" + std::to_string(pid) + "/stat");
    std::string line;
    if (!f.is_open() || !std::getline(f, line)) return 0;

    // The command is parenthesized and may contain spaces. Fields after the
    // final ')' start with state, then parent PID.
    const size_t commandEnd = line.rfind(')');
    if (commandEnd == std::string::npos || commandEnd + 2 >= line.size()) return 0;
    std::istringstream fields(line.substr(commandEnd + 2));
    char state = 0;
    uint32_t parent = 0;
    fields >> state >> parent;
    return parent;
}

static bool isProcessInTree(uint32_t pid, uint32_t rootPid) {
    for (int depth = 0; pid != 0 && depth < 64; depth++) {
        if (pid == rootPid) return true;
        const uint32_t parent = procParentPid(pid);
        if (parent == pid) break;
        pid = parent;
    }
    return false;
}

// Synchronous PulseAudio helper — runs main loop until callback signals done
struct PaSync {
    pa_mainloop*     ml  = nullptr;
    pa_mainloop_api* api = nullptr;
    pa_context*      ctx = nullptr;
    bool             ready = false;
    bool             done  = false;

    PaSync() {
        ml  = pa_mainloop_new();
        api = pa_mainloop_get_api(ml);
        ctx = pa_context_new(api, "HavenDesktop");
    }

    bool connect() {
        if (pa_context_connect(ctx, nullptr, PA_CONTEXT_NOFLAGS, nullptr) < 0)
            return false;

        // Wait for context to be ready
        for (;;) {
            pa_mainloop_iterate(ml, 1, nullptr);
            auto state = pa_context_get_state(ctx);
            if (state == PA_CONTEXT_READY) return true;
            if (!PA_CONTEXT_IS_GOOD(state)) return false;
        }
    }

    void iterate() { pa_mainloop_iterate(ml, 0, nullptr); }
    void iterateBlock() { pa_mainloop_iterate(ml, 1, nullptr); }

    ~PaSync() {
        if (ctx) { pa_context_disconnect(ctx); pa_context_unref(ctx); }
        if (ml)  pa_mainloop_free(ml);
    }
};

// ── Sink input enumeration callback data ──────────────────
struct SinkInputInfo {
    uint32_t    index;
    uint32_t    pid;
    uint32_t    sinkIndex;
    uint32_t    ownerModule;
    std::string name;
};

// File-scope struct used by the sink-input enumeration callback.
// Replaces an old trick of manual pointer arithmetic to reach the
// "done" flag — that relied on the compiler placing no padding after
// the vector, which is UB-adjacent and crashed on some PipeWire hosts.
struct SinkInputEnumData {
    std::vector<SinkInputInfo> inputs;
    bool done = false;
};

static void sinkInputCb(pa_context*, const pa_sink_input_info* info, int eol, void* ud) {
    auto* data = static_cast<SinkInputEnumData*>(ud);
    if (eol > 0 || !info) { data->done = true; return; }

    SinkInputInfo si;
    si.index     = info->index;
    si.sinkIndex = info->sink;
    si.ownerModule = info->owner_module;
    si.name      = info->name ? info->name : "Unknown";

    const char* pidStr = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_PROCESS_ID);
    si.pid = pidStr ? (uint32_t)atoi(pidStr) : 0;

    const char* appName = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_NAME);
    if (appName && strlen(appName) > 0) si.name = appName;

    data->inputs.push_back(si);
}

// Module load callback
struct ModuleLoadResult {
    uint32_t index = PA_INVALID_INDEX;
    bool     done  = false;
};

static void moduleLoadCb(pa_context*, uint32_t idx, void* ud) {
    auto* r = (ModuleLoadResult*)ud;
    r->index = idx;
    r->done  = true;
}

// Success callback
struct OpDone {
    bool done = false;
    bool success = false;
};
static void successCb(pa_context*, int success, void* ud) {
    auto* result = static_cast<OpDone*>(ud);
    result->success = success != 0;
    result->done = true;
}

static pa_buffer_attr lowLatencyRecordBuffer(const pa_sample_spec& spec) {
    pa_buffer_attr attr;
    attr.maxlength = static_cast<uint32_t>(pa_usec_to_bytes(100000, &spec));
    attr.tlength = static_cast<uint32_t>(-1);
    attr.prebuf = static_cast<uint32_t>(-1);
    attr.minreq = static_cast<uint32_t>(-1);
    attr.fragsize = static_cast<uint32_t>(pa_usec_to_bytes(10000, &spec));
    return attr;
}

struct ServerSinkResult {
    std::string name;
    bool done = false;
};

static void serverSinkCb(pa_context*, const pa_server_info* info, void* ud) {
    auto* result = static_cast<ServerSinkResult*>(ud);
    if (info && info->default_sink_name) result->name = info->default_sink_name;
    result->done = true;
}

static std::string defaultSinkName(PaSync& pa) {
    ServerSinkResult result;
    pa_operation* op = pa_context_get_server_info(pa.ctx, serverSinkCb, &result);
    if (!op) return {};
    while (!result.done) pa.iterateBlock();
    pa_operation_unref(op);
    return result.name;
}

struct NamedSinkResult {
    std::string name;
    uint32_t index = PA_INVALID_INDEX;
    bool done = false;
};

static void namedSinkCb(pa_context*, const pa_sink_info* info, int eol, void* ud) {
    auto* result = static_cast<NamedSinkResult*>(ud);
    if (eol > 0 || !info) {
        result->done = true;
        return;
    }
    if (info->name && result->name == info->name) result->index = info->index;
}

static uint32_t sinkIndexByName(PaSync& pa, const std::string& name) {
    NamedSinkResult result;
    result.name = name;
    pa_operation* op = pa_context_get_sink_info_by_name(pa.ctx, name.c_str(), namedSinkCb, &result);
    if (!op) return PA_INVALID_INDEX;
    while (!result.done) pa.iterateBlock();
    pa_operation_unref(op);
    return result.index;
}

static bool moveSinkInput(PaSync& pa, uint32_t inputIndex, uint32_t sinkIndex) {
    OpDone result;
    pa_operation* op = pa_context_move_sink_input_by_index(
        pa.ctx, inputIndex, sinkIndex, successCb, &result);
    if (!op) return false;
    while (!result.done) pa.iterateBlock();
    pa_operation_unref(op);
    return result.success;
}

static bool unloadModule(PaSync& pa, uint32_t& moduleIndex) {
    if (moduleIndex == PA_INVALID_INDEX) return true;
    OpDone result;
    pa_operation* op = pa_context_unload_module(pa.ctx, moduleIndex, successCb, &result);
    if (!op) return false;
    while (!result.done) pa.iterateBlock();
    pa_operation_unref(op);
    if (!result.success) return false;
    moduleIndex = PA_INVALID_INDEX;
    return true;
}

// ═══════════════════════════════════════════════════════════
// PulseCapture
// ═══════════════════════════════════════════════════════════

PulseCapture::PulseCapture() {}
PulseCapture::~PulseCapture() { StopCapture(); }

void PulseCapture::emitStatus(CaptureStatusKind kind, const std::string& msg, int64_t code) {
    const char* kindStr = "?";
    switch (kind) {
        case CaptureStatusKind::Starting: kindStr = "STARTING"; break;
        case CaptureStatusKind::Started:  kindStr = "STARTED";  break;
        case CaptureStatusKind::Failed:   kindStr = "FAILED";   break;
        case CaptureStatusKind::Stopped:  kindStr = "STOPPED";  break;
    }
    fprintf(stderr, "[Haven Pulse] status=%s code=%lld msg=%s\n",
            kindStr, (long long)code, msg.c_str());
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

bool PulseCapture::IsSupported() const {
    // Capability checks must not open the default recording source (usually
    // the microphone). A control connection is enough for both capture modes.
    PaSync pa;
    return pa.connect();
}

std::vector<AudioApp> PulseCapture::GetAudioApplications() {
    std::vector<AudioApp> result;

    PaSync pa;
    if (!pa.connect()) return result;

    // Enumerate sink inputs
    SinkInputEnumData ed;

    pa_operation* op = pa_context_get_sink_input_info_list(pa.ctx, sinkInputCb, &ed);
    if (!op) return result;

    while (!ed.done) pa.iterateBlock();
    pa_operation_unref(op);

    // Deduplicate by PID
    std::vector<uint32_t> seen;
    const uint32_t ourPid = static_cast<uint32_t>(getpid());
    for (auto& si : ed.inputs) {
        if (si.pid == 0) continue;
        if (isProcessInTree(si.pid, ourPid)) continue;
        if (std::find(seen.begin(), seen.end(), si.pid) != seen.end()) continue;
        seen.push_back(si.pid);

        AudioApp app;
        app.pid  = si.pid;
        app.name = si.name.empty() ? procName(si.pid) : si.name;
        result.push_back(app);
    }

    return result;
}

bool PulseCapture::StartCapture(uint32_t pid, CaptureMode mode,
                                 AudioDataCb dataCb, CaptureStatusCb statusCb) {
    StopCapture();
    if (m_nullSinkModule != PA_INVALID_INDEX || m_loopbackModule != PA_INVALID_INDEX) {
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_targetPid      = pid;
        m_mode           = mode;
        m_callback       = dataCb;
        m_statusCallback = statusCb;
        m_running        = true;
    }

    std::string startingMessage;
    if (mode == CaptureMode::ExcludeProcess) {
        startingMessage = "preparing system capture without PID tree " + std::to_string(pid);
    } else if (mode == CaptureMode::SystemLoopback) {
        startingMessage = "preparing pulse system capture";
    } else {
        startingMessage = "preparing pulse capture for PID " + std::to_string(pid);
    }
    emitStatus(CaptureStatusKind::Starting, startingMessage);

    m_thread = std::thread([this]() { captureLoop(); });
    return true;
}

void PulseCapture::StopCapture() {
    bool wasRunning = m_running.exchange(false);
    if (m_thread.joinable()) m_thread.join();
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_callback = nullptr;
    }

    // Clean up PulseAudio modules
    if (m_nullSinkModule != PA_INVALID_INDEX || m_loopbackModule != PA_INVALID_INDEX) {
        PaSync pa;
        if (pa.connect()) {
            if (!unloadModule(pa, m_loopbackModule))
                fprintf(stderr, "[Haven Pulse] failed to unload routing module\n");
            if (!unloadModule(pa, m_nullSinkModule))
                fprintf(stderr, "[Haven Pulse] failed to unload capture module\n");
        } else {
            fprintf(stderr, "[Haven Pulse] cleanup deferred: server unavailable\n");
        }
    }
    if (wasRunning) emitStatus(CaptureStatusKind::Stopped, "pulse capture stopped");
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_statusCallback = nullptr;
    }
}

void PulseCapture::Cleanup() { StopCapture(); }

void PulseCapture::captureLoop() {
    PaSync pa;
    if (!pa.connect()) {
        emitStatus(CaptureStatusKind::Failed,
            "pa_context_connect failed (PulseAudio/PipeWire daemon not reachable)");
        m_running = false;
        return;
    }

    if (m_mode == CaptureMode::ExcludeProcess) {
        const std::string outputName = defaultSinkName(pa);
        const uint32_t outputIndex = sinkIndexByName(pa, outputName);
        if (outputName.empty() || outputIndex == PA_INVALID_INDEX) {
            emitStatus(CaptureStatusKind::Failed, "PulseAudio has no default output");
            m_running = false;
            return;
        }

        const std::string suffix = std::to_string(getpid());
        const std::string captureSinkName = "HavenCapture_" + suffix;
        const std::string combinedSinkName = "HavenCombined_" + suffix;

        ModuleLoadResult nullResult;
        std::string nullArgs = "sink_name=" + captureSinkName +
            " sink_properties=device.description=\"Haven\\ Clean\\ System\\ Capture\"" +
            " rate=48000 channels=1 format=float32le";
        pa_operation* op = pa_context_load_module(
            pa.ctx, "module-null-sink", nullArgs.c_str(), moduleLoadCb, &nullResult);
        if (op) {
            while (!nullResult.done) pa.iterateBlock();
            pa_operation_unref(op);
        }
        if (nullResult.index == PA_INVALID_INDEX) {
            emitStatus(CaptureStatusKind::Failed, "PulseAudio could not create the clean capture output");
            m_running = false;
            return;
        }
        m_nullSinkModule = nullResult.index;

        ModuleLoadResult combinedResult;
        std::string combinedArgs = "sink_name=" + combinedSinkName +
            " sink_properties=device.description=\"Haven\\ System\\ Without\\ Haven\"" +
            " slaves=" + outputName + "," + captureSinkName + " adjust_time=0";
        op = pa_context_load_module(
            pa.ctx, "module-combine-sink", combinedArgs.c_str(), moduleLoadCb, &combinedResult);
        if (op) {
            while (!combinedResult.done) pa.iterateBlock();
            pa_operation_unref(op);
        }
        if (combinedResult.index == PA_INVALID_INDEX) {
            unloadModule(pa, m_nullSinkModule);
            emitStatus(CaptureStatusKind::Failed,
                "PipeWire could not create the clean system audio route");
            m_running = false;
            return;
        }
        m_loopbackModule = combinedResult.index;

        usleep(50000);
        const uint32_t captureSinkIndex = sinkIndexByName(pa, captureSinkName);
        const uint32_t combinedSinkIndex = sinkIndexByName(pa, combinedSinkName);
        if (captureSinkIndex == PA_INVALID_INDEX || combinedSinkIndex == PA_INVALID_INDEX) {
            unloadModule(pa, m_loopbackModule);
            unloadModule(pa, m_nullSinkModule);
            emitStatus(CaptureStatusKind::Failed,
                "PipeWire could not activate the clean system audio route");
            m_running = false;
            return;
        }

        std::vector<std::pair<uint32_t, uint32_t>> movedInputs;
        auto routeNewInputs = [&]() {
            SinkInputEnumData inputs;
            pa_operation* listOp = pa_context_get_sink_input_info_list(
                pa.ctx, sinkInputCb, &inputs);
            if (!listOp) return;
            while (!inputs.done) pa.iterateBlock();
            pa_operation_unref(listOp);

            for (const auto& input : inputs.inputs) {
                if (input.ownerModule != PA_INVALID_INDEX || input.pid == 0 ||
                    input.sinkIndex != outputIndex) continue;
                if (isProcessInTree(input.pid, m_targetPid)) continue;
                const bool alreadyMoved = std::any_of(
                    movedInputs.begin(), movedInputs.end(),
                    [&](const auto& moved) { return moved.first == input.index; });
                if (alreadyMoved) continue;
                if (moveSinkInput(pa, input.index, combinedSinkIndex)) {
                    movedInputs.emplace_back(input.index, input.sinkIndex);
                }
            }
        };
        auto restoreWith = [&](PaSync& context) {
            bool restored = true;
            for (const auto& moved : movedInputs) {
                if (!moveSinkInput(context, moved.first, moved.second)) restored = false;
            }
            return restored;
        };
        auto restoreInputs = [&]() {
            if (restoreWith(pa)) return true;
            PaSync retry;
            return retry.connect() && restoreWith(retry);
        };

        routeNewInputs();

        pa_sample_spec ss = { PA_SAMPLE_FLOAT32LE, 48000, 1 };
        const pa_buffer_attr bufferAttr = lowLatencyRecordBuffer(ss);
        const std::string monitorName = captureSinkName + ".monitor";
        int err = 0;
        pa_simple* rec = pa_simple_new(
            nullptr, "HavenDesktop", PA_STREAM_RECORD,
            monitorName.c_str(), "System Audio Without Haven",
            &ss, nullptr, &bufferAttr, &err
        );
        if (!rec) {
            if (!restoreInputs())
                fprintf(stderr, "[Haven Pulse] failed to restore one or more audio streams\n");
            unloadModule(pa, m_loopbackModule);
            unloadModule(pa, m_nullSinkModule);
            emitStatus(CaptureStatusKind::Failed,
                std::string("pa_simple_new failed: ") + pa_strerror(err), err);
            m_running = false;
            return;
        }

        emitStatus(CaptureStatusKind::Started, "system capture active without Haven audio");
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_callback) {
                std::vector<float> silence(480, 0.0f);
                m_callback(silence.data(), silence.size());
            }
        }

        const size_t chunkFrames = 480;
        std::vector<float> buf(chunkFrames);
        unsigned int chunksSinceRouteScan = 0;
        while (m_running) {
            if (pa_simple_read(rec, buf.data(), chunkFrames * sizeof(float), &err) < 0) {
                emitStatus(CaptureStatusKind::Failed,
                    std::string("PulseAudio clean system capture failed: ") + pa_strerror(err), err);
                m_running = false;
                break;
            }
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (m_callback) m_callback(buf.data(), chunkFrames);
            }
            if (++chunksSinceRouteScan >= 25) {
                routeNewInputs();
                chunksSinceRouteScan = 0;
            }
        }

        pa_simple_free(rec);
        if (!restoreInputs())
            fprintf(stderr, "[Haven Pulse] failed to restore one or more audio streams\n");
        return;
    }

    if (m_mode == CaptureMode::SystemLoopback) {
        struct DefaultSinkInfo {
            std::string name;
            bool done = false;
        } sink;
        auto serverInfoCb = [](pa_context*, const pa_server_info* info, void* ud) {
            auto* result = static_cast<DefaultSinkInfo*>(ud);
            if (info && info->default_sink_name) result->name = info->default_sink_name;
            result->done = true;
        };

        pa_operation* op = pa_context_get_server_info(pa.ctx, serverInfoCb, &sink);
        if (!op) {
            emitStatus(CaptureStatusKind::Failed, "PulseAudio could not read the default output");
            m_running = false;
            return;
        }
        while (!sink.done) pa.iterateBlock();
        pa_operation_unref(op);
        if (sink.name.empty()) {
            emitStatus(CaptureStatusKind::Failed, "PulseAudio has no default output");
            m_running = false;
            return;
        }

        const std::string monitor = sink.name + ".monitor";
        pa_sample_spec ss = { PA_SAMPLE_FLOAT32LE, 48000, 1 };
        const pa_buffer_attr bufferAttr = lowLatencyRecordBuffer(ss);
        int err = 0;
        pa_simple* rec = pa_simple_new(
            nullptr, "HavenDesktop", PA_STREAM_RECORD,
            monitor.c_str(), "System Audio Capture",
            &ss, nullptr, &bufferAttr, &err
        );
        if (!rec) {
            emitStatus(CaptureStatusKind::Failed,
                std::string("pa_simple_new failed: ") + pa_strerror(err), err);
            m_running = false;
            return;
        }

        emitStatus(CaptureStatusKind::Started, "pulse system capture active");
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_callback) {
                std::vector<float> silence(480, 0.0f);
                m_callback(silence.data(), silence.size());
            }
        }

        const size_t chunkFrames = 480;
        std::vector<float> buf(chunkFrames);
        while (m_running) {
            if (pa_simple_read(rec, buf.data(), chunkFrames * sizeof(float), &err) < 0) {
                emitStatus(CaptureStatusKind::Failed,
                    std::string("PulseAudio system capture failed: ") + pa_strerror(err), err);
                m_running = false;
                break;
            }
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_callback) m_callback(buf.data(), chunkFrames);
        }
        pa_simple_free(rec);
        return;
    }

    // ── Step 1: Find the target process's sink input ──────
    SinkInputEnumData ed;

    pa_operation* op = pa_context_get_sink_input_info_list(pa.ctx, sinkInputCb, &ed);
    if (!op) {
        emitStatus(CaptureStatusKind::Failed, "pa_context_get_sink_input_info_list returned NULL");
        m_running = false;
        return;
    }
    while (!ed.done) pa.iterateBlock();
    pa_operation_unref(op);

    uint32_t targetSinkInput = PA_INVALID_INDEX;
    uint32_t originalSink    = PA_INVALID_INDEX;

    for (auto& si : ed.inputs) {
        if (si.pid == m_targetPid) {
            targetSinkInput = si.index;
            originalSink    = si.sinkIndex;
            break;
        }
    }

    if (targetSinkInput == PA_INVALID_INDEX) {
        emitStatus(CaptureStatusKind::Failed,
            "No PulseAudio sink input found for PID " + std::to_string(m_targetPid) +
            " (the app may have stopped producing audio)");
        m_running = false;
        return;
    }

    // ── Detect PipeWire ───────────────────────────────────
    // PipeWire's pipewire-pulse adds "pipewire" to server info.
    // On PipeWire, moving a sink input can crash Chromium-based
    // apps, so we use module-combine-sink instead (keeps the
    // original output alive while teeing audio to our capture).
    struct ServerInfo { std::string name; bool done = false; };
    ServerInfo si;
    auto serverInfoCb = [](pa_context*, const pa_server_info* info, void* ud) {
        auto* s = (ServerInfo*)ud;
        if (info && info->server_name) s->name = info->server_name;
        s->done = true;
    };
    op = pa_context_get_server_info(pa.ctx, serverInfoCb, &si);
    if (op) { while (!si.done) pa.iterateBlock(); pa_operation_unref(op); }

    bool isPipeWire = (si.name.find("PipeWire") != std::string::npos) ||
                      (si.name.find("pipewire") != std::string::npos);

    // ── Step 2: Create a null sink for recording ──────────
    ModuleLoadResult nullRes;
    op = pa_context_load_module(pa.ctx, "module-null-sink",
        "sink_name=HavenCapture "
        "sink_properties=device.description=\"Haven\\ Per-App\\ Capture\" "
        "rate=48000 channels=1 format=float32le",
        moduleLoadCb, &nullRes);
    if (!op) {
        emitStatus(CaptureStatusKind::Failed, "PulseAudio could not create the capture output");
        m_running = false;
        return;
    }
    while (!nullRes.done) pa.iterateBlock();
    pa_operation_unref(op);

    if (nullRes.index == PA_INVALID_INDEX) {
        emitStatus(CaptureStatusKind::Failed, "PulseAudio rejected the capture output");
        m_running = false;
        return;
    }
    m_nullSinkModule = nullRes.index;

    // ── Look up the null sink index ───────────────────────
    struct SinkLookup { uint32_t idx = PA_INVALID_INDEX; bool done = false; };
    SinkLookup sl;

    auto sinkInfoCb = [](pa_context*, const pa_sink_info* info, int eol, void* ud) {
        auto* s = (SinkLookup*)ud;
        if (eol > 0 || !info) { s->done = true; return; }
        if (info->name && std::string(info->name) == "HavenCapture") {
            s->idx = info->index;
        }
    };

    op = pa_context_get_sink_info_by_name(pa.ctx, "HavenCapture", sinkInfoCb, &sl);
    if (op) { while (!sl.done) pa.iterateBlock(); pa_operation_unref(op); }

    if (sl.idx == PA_INVALID_INDEX) {
        unloadModule(pa, m_nullSinkModule);
        emitStatus(CaptureStatusKind::Failed, "PulseAudio could not find the capture output");
        m_running = false;
        return;
    }

    // ── Look up the original sink name (needed for combine-sink) ──
    struct SinkNameLookup { std::string name; bool done = false; };
    SinkNameLookup origSinkLookup;
    auto sinkNameCb = [](pa_context*, const pa_sink_info* info, int eol, void* ud) {
        auto* s = (SinkNameLookup*)ud;
        if (eol > 0 || !info) { s->done = true; return; }
        if (info->name) s->name = info->name;
    };

    op = pa_context_get_sink_info_by_index(pa.ctx, originalSink, sinkNameCb, &origSinkLookup);
    if (op) { while (!origSinkLookup.done) pa.iterateBlock(); pa_operation_unref(op); }

    if (isPipeWire && origSinkLookup.name.empty()) {
        unloadModule(pa, m_nullSinkModule);
        emitStatus(CaptureStatusKind::Failed,
            "PipeWire could not identify the selected application's output");
        m_running = false;
        return;
    }

    // ── Step 3: Route audio ───────────────────────────────
    //
    // PipeWire path: create a combine-sink that sends audio to
    // both the original output AND our null sink. Then gently
    // move the app to the combined sink. The app never loses
    // its audio output so Chromium/etc. stay stable.
    //
    // PulseAudio path: move the app to the null sink directly
    // (the old approach) and use a loopback for monitoring.
    //
    if (isPipeWire && !origSinkLookup.name.empty()) {
        // PipeWire path: Try module-combine-sink to keep the app's original
        // output alive while teeing audio to our capture sink.
        // If combine-sink fails (some PipeWire versions have incomplete
        // support), fall back to a loopback from the original sink's monitor.
        bool combineSinkOk = false;

        std::string combineArgs = "sink_name=HavenCombined "
            "sink_properties=device.description=\"Haven\\ Combined\\ Capture\" "
            "slaves=" + origSinkLookup.name + ",HavenCapture";

        ModuleLoadResult combRes;
        op = pa_context_load_module(pa.ctx, "module-combine-sink",
            combineArgs.c_str(), moduleLoadCb, &combRes);
        if (op) { while (!combRes.done) pa.iterateBlock(); pa_operation_unref(op); }

        if (combRes.index != PA_INVALID_INDEX) {
            m_loopbackModule = combRes.index;

            // Look up HavenCombined sink index
            SinkLookup csl;
            auto combineSinkCb = [](pa_context*, const pa_sink_info* info, int eol, void* ud) {
                auto* s = (SinkLookup*)ud;
                if (eol > 0 || !info) { s->done = true; return; }
                if (info->name && std::string(info->name) == "HavenCombined") {
                    s->idx = info->index;
                }
            };
            op = pa_context_get_sink_info_by_name(pa.ctx, "HavenCombined", combineSinkCb, &csl);
            if (op) { while (!csl.done) pa.iterateBlock(); pa_operation_unref(op); }

            if (csl.idx != PA_INVALID_INDEX) {
                // Small delay to let PipeWire finish setting up the combined sink
                usleep(150000);
                OpDone od;
                op = pa_context_move_sink_input_by_index(pa.ctx, targetSinkInput, csl.idx, successCb, &od);
                if (op) { while (!od.done) pa.iterateBlock(); pa_operation_unref(op); }
                combineSinkOk = od.success;
            }
        }

        if (!combineSinkOk) {
            // Never fall back to the output monitor here: that would turn an
            // application-only choice into a capture of every app, including
            // Haven voice output.
            unloadModule(pa, m_loopbackModule);
            unloadModule(pa, m_nullSinkModule);
            emitStatus(CaptureStatusKind::Failed,
                "PipeWire could not isolate the selected application audio");
            m_running = false;
            return;
        }
    } else {
        // Classic PulseAudio: move sink input to null sink directly
        {
            OpDone od;
            op = pa_context_move_sink_input_by_index(pa.ctx, targetSinkInput, sl.idx, successCb, &od);
            if (op) { while (!od.done) pa.iterateBlock(); pa_operation_unref(op); }
            if (!od.success) {
                unloadModule(pa, m_nullSinkModule);
                emitStatus(CaptureStatusKind::Failed,
                    "PulseAudio could not isolate the selected application audio");
                m_running = false;
                return;
            }
        }

        // Loopback null sink → default output so user still hears the app
        {
            ModuleLoadResult lbRes;
            std::string args = "source=HavenCapture.monitor sink_dont_move=true";
            op = pa_context_load_module(pa.ctx, "module-loopback", args.c_str(), moduleLoadCb, &lbRes);
            if (op) { while (!lbRes.done) pa.iterateBlock(); pa_operation_unref(op); }
            m_loopbackModule = lbRes.index;
        }
    }

    // ── Step 5: Record from the null sink's monitor ───────
    // Small delay lets PipeWire (pipewire-pulse) finish creating the
    // monitor source after module-null-sink was loaded.
    usleep(100000); // 100 ms

    pa_sample_spec ss;
    ss.format   = PA_SAMPLE_FLOAT32LE;
    ss.rate     = 48000;
    ss.channels = 1;
    const pa_buffer_attr bufferAttr = lowLatencyRecordBuffer(ss);

    int err = 0;
    pa_simple* rec = pa_simple_new(
        nullptr, "HavenDesktop", PA_STREAM_RECORD,
        "HavenCapture.monitor", "Per-App Capture",
        &ss, nullptr, &bufferAttr, &err
    );

    if (!rec) {
        emitStatus(CaptureStatusKind::Failed,
            std::string("pa_simple_new failed: ") + pa_strerror(err), err);
        // Clean up modules before returning
        unloadModule(pa, m_loopbackModule);
        unloadModule(pa, m_nullSinkModule);
        // Restore original sink
        if (originalSink != PA_INVALID_INDEX &&
            !moveSinkInput(pa, targetSinkInput, originalSink))
            fprintf(stderr, "[Haven Pulse] failed to restore application output\n");
        m_running = false;
        return;
    }

    emitStatus(CaptureStatusKind::Started, "pulse capture active");
    // Prime the renderer-side first-packet gate.
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_callback) {
            std::vector<float> silence(480, 0.0f);
            m_callback(silence.data(), silence.size());
        }
    }

    // Read PCM data in ~10 ms chunks
    const size_t chunkFrames = 480; // 10 ms at 48 kHz
    std::vector<float> buf(chunkFrames);

    while (m_running) {
        if (pa_simple_read(rec, buf.data(), chunkFrames * sizeof(float), &err) < 0) {
            break;
        }

        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_callback) {
            m_callback(buf.data(), chunkFrames);
        }
    }

    pa_simple_free(rec);

    // ── Step 6: Restore original sink ─────────────────────
    {
        PaSync pa2;
        if (pa2.connect()) {
            if (originalSink != PA_INVALID_INDEX &&
                !moveSinkInput(pa2, targetSinkInput, originalSink))
                fprintf(stderr, "[Haven Pulse] failed to restore application output\n");
        }
    }
    // Module cleanup happens in StopCapture()
}

// ── Factory ───────────────────────────────────────────────
IAudioCapture* CreateAudioCapture() {
    return new PulseCapture();
}

} // namespace haven

#endif // PLATFORM_LINUX

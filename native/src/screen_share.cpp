#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <gst/sdp/sdp.h>

#define GST_USE_UNSTABLE_API
#include <gst/webrtc/webrtc.h>

#ifndef G_OS_WIN32
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <unistd.h>
#else
#include <io.h>
#include <windows.h>
#endif

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr int kProtocolVersion = 3;
constexpr size_t kMaxActivePeers = 32;
constexpr guint64 kMaxPeerGenerations = 256;

struct App;

struct Peer {
  App* app = nullptr;
  std::string id;
  GstElement* videoQueue = nullptr;
  GstElement* videoCapsFilter = nullptr;
  GstElement* audioQueue = nullptr;
  GstElement* audioCapsFilter = nullptr;
  GstElement* webrtc = nullptr;
  GstPad* videoTeePad = nullptr;
  GstPad* audioTeePad = nullptr;
  guint64 generation = 0;
  std::atomic<bool> active{true};
};

struct TurnServer {
  std::string url;
  std::string username;
  std::string credential;
};

struct CaptureConfig {
  std::string sourceKind;
  std::string sourceHandle;
  int x = 0;
  int y = 0;
  int sourceWidth = 0;
  int sourceHeight = 0;
  int outputHeight = 0;
  int frameRate = 30;
  int bitrate = 8000000;
  std::string codec = "H264";
  bool hasAudio = false;
  std::string icePolicy = "all";
  std::string stunUrl;
  std::vector<TurnServer> turnServers;
};

struct App {
  GMainLoop* loop = nullptr;
  GstElement* pipeline = nullptr;
  GstElement* videoRtpTee = nullptr;
  GstElement* audioRtpTee = nullptr;
  GstElement* audioSource = nullptr;
  guint busWatch = 0;
  std::string sessionId;
  CaptureConfig config;
  std::unordered_map<std::string, std::unique_ptr<Peer>> peers;
  std::vector<std::unique_ptr<Peer>> retiredPeers;
  std::mutex outputMutex;
  std::mutex audioMutex;
  std::atomic<bool> stopping{false};
  bool starting = false;
  bool cancelStartup = false;
  std::atomic<bool> terminalQueued{false};
  guint64 nextPeerGeneration = 1;
#ifndef G_OS_WIN32
  GDBusConnection* portalBus = nullptr;
  std::string portalSession;
  guint portalClosedSubscription = 0;
  GMainLoop* portalRequestLoop = nullptr;
  int pipewireFd = -1;
#endif
};

bool factory_exists(const char* name) {
  GstElementFactory* factory = gst_element_factory_find(name);
  if (!factory) return false;
  gst_object_unref(factory);
  return true;
}

bool factory_has_property(const char* factoryName, const char* propertyName) {
  GstElement* element = gst_element_factory_make(factoryName, nullptr);
  if (!element) return false;
  const bool found = g_object_class_find_property(
      G_OBJECT_GET_CLASS(element), propertyName) != nullptr;
  gst_object_unref(element);
  return found;
}

struct CodecSpec {
  const char* name;
  const char* parser;
  const char* payloader;
  const char* encodedCaps;
  const char* rtpEncoding;
};

const CodecSpec* codec_spec(const std::string& name) {
  static const CodecSpec specs[] = {
      {"H264", "h264parse", "rtph264pay", "video/x-h264,profile=baseline", "H264"},
      {"AV1", "av1parse", "rtpav1pay", "video/x-av1", "AV1"},
      {"H265", "h265parse", "rtph265pay", "video/x-h265", "H265"},
  };
  for (const auto& spec : specs) {
    if (name == spec.name) return &spec;
  }
  return nullptr;
}

std::vector<std::string> encoder_candidates(const std::string& codec) {
#ifdef G_OS_WIN32
  if (codec == "H264") return {
      "nvd3d11h264enc", "amfh264enc", "qsvh264enc", "mfh264enc", "nvh264enc",
  };
  if (codec == "AV1") return {"amfav1enc", "qsvav1enc", "nvav1enc"};
  if (codec == "H265") return {
      "nvd3d11h265enc", "amfh265enc", "qsvh265enc", "mfh265enc", "nvh265enc",
  };
#else
  if (codec == "H264") return {
      "nvh264enc", "qsvh264enc", "vah264enc", "vaapih264enc",
  };
  if (codec == "AV1") return {"nvav1enc", "qsvav1enc", "vaav1enc"};
  if (codec == "H265") return {
      "nvh265enc", "qsvh265enc", "vah265enc", "vaapih265enc",
  };
#endif
  return {};
}

bool encoder_is_usable(const std::string& name) {
  GstElement* encoder = gst_element_factory_make(name.c_str(), nullptr);
  if (!encoder) return false;
  GstStateChangeReturn state = gst_element_set_state(encoder, GST_STATE_READY);
  if (state == GST_STATE_CHANGE_ASYNC) {
    state = gst_element_get_state(encoder, nullptr, nullptr, 3 * GST_SECOND);
  }
  const bool usable = state == GST_STATE_CHANGE_SUCCESS ||
      state == GST_STATE_CHANGE_NO_PREROLL;
  gst_element_set_state(encoder, GST_STATE_NULL);
  gst_object_unref(encoder);
  return usable;
}

std::vector<std::string> available_encoders(const std::string& codec) {
  const CodecSpec* spec = codec_spec(codec);
  std::vector<std::string> available;
  if (!spec || !factory_exists(spec->parser) || !factory_exists(spec->payloader)) {
    return available;
  }
  for (const auto& encoder : encoder_candidates(codec)) {
    if (encoder_is_usable(encoder)) available.push_back(encoder);
  }
  return available;
}

std::string first_available_encoder(const std::string& codec) {
  const auto available = available_encoders(codec);
  return available.empty() ? std::string() : available.front();
}

bool encoder_accepts_d3d11(const std::string& encoder) {
  return encoder.rfind("nvd3d11", 0) == 0 || encoder.rfind("amf", 0) == 0 ||
      encoder.rfind("qsv", 0) == 0 || encoder.rfind("mf", 0) == 0;
}

void append_encoder_properties(std::ostringstream* pipeline,
                               const std::string& encoder,
                               int bitrateKbps, int keyInterval) {
  *pipeline << ' ' << encoder;
  if (factory_has_property(encoder.c_str(), "bitrate")) {
    *pipeline << " bitrate=" << bitrateKbps;
  }
  if (factory_has_property(encoder.c_str(), "max-bitrate")) {
    *pipeline << " max-bitrate=" << bitrateKbps;
  }
  if (factory_has_property(encoder.c_str(), "rate-control")) {
    *pipeline << " rate-control=cbr";
  } else if (factory_has_property(encoder.c_str(), "rc-mode")) {
    *pipeline << " rc-mode=cbr";
  }
  if (factory_has_property(encoder.c_str(), "gop-size")) {
    *pipeline << " gop-size=" << keyInterval;
  } else if (factory_has_property(encoder.c_str(), "key-int-max")) {
    *pipeline << " key-int-max=" << keyInterval;
  } else if (factory_has_property(encoder.c_str(), "keyframe-period")) {
    *pipeline << " keyframe-period=" << keyInterval;
  }
  if (factory_has_property(encoder.c_str(), "b-frames")) {
    *pipeline << " b-frames=0";
  } else if (factory_has_property(encoder.c_str(), "max-bframes")) {
    *pipeline << " max-bframes=0";
  }
  if (factory_has_property(encoder.c_str(), "low-latency")) {
    *pipeline << " low-latency=true";
  }
  if (factory_has_property(encoder.c_str(), "zerolatency")) {
    *pipeline << " zerolatency=true";
  }
}

std::string base64_encode(const std::string& value) {
  gchar* encoded = g_base64_encode(
      reinterpret_cast<const guchar*>(value.data()), value.size());
  std::string result = encoded ? encoded : "";
  g_free(encoded);
  return result;
}

std::string base64_decode(const std::string& value) {
  gsize length = 0;
  guchar* decoded = g_base64_decode(value.c_str(), &length);
  std::string result;
  if (decoded) result.assign(reinterpret_cast<const char*>(decoded), length);
  g_free(decoded);
  return result;
}

std::vector<std::string> split(const std::string& value, char delimiter) {
  std::vector<std::string> fields;
  std::stringstream stream(value);
  std::string field;
  while (std::getline(stream, field, delimiter)) fields.push_back(field);
  if (!value.empty() && value.back() == delimiter) fields.emplace_back();
  return fields;
}

std::vector<std::string> decode_command_fields(const std::string& line) {
  auto fields = split(line, '\t');
  for (size_t i = 1; i < fields.size(); ++i) fields[i] = base64_decode(fields[i]);
  return fields;
}

void emit_event(App* app, const std::string& event,
                const std::vector<std::string>& fields) {
  std::lock_guard<std::mutex> lock(app->outputMutex);
  std::cout << event;
  for (const auto& field : fields) std::cout << '\t' << base64_encode(field);
  std::cout << std::endl;
}

void emit_error(App* app, const std::string& peerId,
                const std::string& message, bool fatal) {
  if (app->sessionId.empty()) return;
  emit_event(app, "ERROR", {
      app->sessionId, peerId, message, fatal ? "1" : "0",
  });
}

bool valid_session_id(const std::string& value) {
  if (value.size() < 8 || value.size() > 64) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return std::isalnum(character) || character == '_' || character == '-';
  });
}

bool parse_int(const std::string& value, int minimum, int maximum, int* output) {
  try {
    size_t consumed = 0;
    long parsed = std::stol(value, &consumed, 10);
    if (consumed != value.size() || parsed < minimum || parsed > maximum) return false;
    *output = static_cast<int>(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

bool parse_u64(const std::string& value, guint64* output) {
  try {
    size_t consumed = 0;
    unsigned long long parsed = std::stoull(value, &consumed, 0);
    if (consumed != value.size()) return false;
    *output = static_cast<guint64>(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

std::string normalize_ice_url(const std::string& url) {
  const size_t colon = url.find(':');
  if (colon == std::string::npos || url.compare(colon, 3, "://") == 0) return url;
  return url.substr(0, colon) + "://" + url.substr(colon + 1);
}

std::string build_turn_url(const TurnServer& server) {
  if (server.url.empty()) return {};
  std::string normalized = normalize_ice_url(server.url);
  if (server.username.empty()) return normalized;
  const size_t schemeEnd = normalized.find("://");
  if (schemeEnd == std::string::npos) return normalized;
  gchar* user = g_uri_escape_string(server.username.c_str(), nullptr, FALSE);
  gchar* password = g_uri_escape_string(server.credential.c_str(), nullptr, FALSE);
  std::string result = normalized.substr(0, schemeEnd + 3) +
      (user ? user : "") + ":" + (password ? password : "") + "@" +
      normalized.substr(schemeEnd + 3);
  g_free(user);
  g_free(password);
  return result;
}

std::vector<TurnServer> parse_turn_servers(const std::string& encoded) {
  std::vector<TurnServer> servers;
  for (const auto& record : split(encoded, ';')) {
    const auto fields = split(record, ',');
    if (fields.size() != 3) continue;
    TurnServer server{
        base64_decode(fields[0]), base64_decode(fields[1]), base64_decode(fields[2]),
    };
    if (!server.url.empty()) servers.push_back(std::move(server));
    if (servers.size() >= 16) break;
  }
  return servers;
}

std::string output_caps(const CaptureConfig& config, bool d3d11Memory) {
  std::ostringstream caps;
  caps << (d3d11Memory ? "video/x-raw(memory:D3D11Memory)" : "video/x-raw")
       << ",format=NV12,framerate=" << config.frameRate << "/1";
  if (config.outputHeight > 0) {
    if (config.sourceWidth > 0 && config.sourceHeight > 0) {
      int width = static_cast<int>(
          static_cast<int64_t>(config.sourceWidth) * config.outputHeight /
          config.sourceHeight);
      width = std::max(2, width & ~1);
      caps << ",width=" << width;
    }
    caps << ",height=" << (config.outputHeight & ~1);
  }
  return caps.str();
}

#ifndef G_OS_WIN32
void queue_terminal_stop(App* app);

constexpr const char* kPortalBusName = "org.freedesktop.portal.Desktop";
constexpr const char* kPortalObjectPath = "/org/freedesktop/portal/desktop";

struct PortalResponse {
  GMainLoop* loop = nullptr;
  std::string path;
  GVariant* results = nullptr;
  guint response = 2;
  bool received = false;
  bool timedOut = false;
};

std::string portal_token(const char* prefix) {
  gchar* uuid = g_uuid_string_random();
  std::string token = std::string(prefix) + (uuid ? uuid : "request");
  g_free(uuid);
  std::replace(token.begin(), token.end(), '-', '_');
  return token;
}

void on_portal_response(GDBusConnection*, const gchar*, const gchar* objectPath,
                        const gchar*, const gchar*, GVariant* parameters,
                        gpointer userData) {
  auto* pending = static_cast<PortalResponse*>(userData);
  if (pending->received || pending->path != objectPath) return;
  g_variant_get(parameters, "(u@a{sv})", &pending->response, &pending->results);
  pending->received = true;
  g_main_loop_quit(pending->loop);
}

gboolean on_portal_timeout(gpointer userData) {
  auto* pending = static_cast<PortalResponse*>(userData);
  pending->timedOut = true;
  g_main_loop_quit(pending->loop);
  return G_SOURCE_REMOVE;
}

bool portal_request(App* app, const char* method,
                     GVariant* parameters, GVariant** results,
                     std::string* error) {
  GDBusConnection* bus = app->portalBus;
  PortalResponse pending;
  pending.loop = g_main_loop_new(nullptr, FALSE);
  const guint subscription = g_dbus_connection_signal_subscribe(
      bus, kPortalBusName, "org.freedesktop.portal.Request", "Response",
      nullptr, nullptr, G_DBUS_SIGNAL_FLAGS_NONE, on_portal_response,
      &pending, nullptr);

  GError* callError = nullptr;
  GVariant* reply = g_dbus_connection_call_sync(
      bus, kPortalBusName, kPortalObjectPath,
      "org.freedesktop.portal.ScreenCast", method, parameters,
      G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 10000, nullptr,
      &callError);
  if (!reply) {
    *error = callError ? callError->message : "Desktop portal request failed";
    g_clear_error(&callError);
    g_dbus_connection_signal_unsubscribe(bus, subscription);
    g_main_loop_unref(pending.loop);
    return false;
  }

  const gchar* requestPath = nullptr;
  g_variant_get(reply, "(&o)", &requestPath);
  pending.path = requestPath ? requestPath : "";
  g_variant_unref(reply);

  const guint timeout = g_timeout_add_seconds(120, on_portal_timeout, &pending);
  app->portalRequestLoop = pending.loop;
  g_main_loop_run(pending.loop);
  app->portalRequestLoop = nullptr;
  if (!pending.timedOut) g_source_remove(timeout);
  g_dbus_connection_signal_unsubscribe(bus, subscription);
  g_main_loop_unref(pending.loop);

  if (pending.timedOut) {
    *error = "Desktop portal screen selection timed out";
    return false;
  }
  if (!pending.received || pending.response != 0 || !pending.results) {
    if (pending.results) g_variant_unref(pending.results);
    *error = pending.response == 1
        ? "Desktop portal screen selection was cancelled"
        : "Desktop portal rejected the screen capture request";
    return false;
  }
  *results = pending.results;
  return true;
}

void on_portal_session_closed(GDBusConnection*, const gchar*, const gchar*,
                              const gchar*, const gchar*, GVariant*,
                              gpointer userData) {
  App* app = static_cast<App*>(userData);
  if (app->stopping) return;
  emit_error(app, "", "Desktop portal screen capture session closed", true);
  if (app->starting) {
    app->cancelStartup = true;
    if (app->portalRequestLoop) g_main_loop_quit(app->portalRequestLoop);
    return;
  }
  queue_terminal_stop(app);
}

void close_portal_capture(App* app) {
  if (app->portalBus && app->portalClosedSubscription) {
    g_dbus_connection_signal_unsubscribe(
        app->portalBus, app->portalClosedSubscription);
    app->portalClosedSubscription = 0;
  }
  if (app->portalBus && !app->portalSession.empty()) {
    GError* error = nullptr;
    GVariant* reply = g_dbus_connection_call_sync(
        app->portalBus, kPortalBusName, app->portalSession.c_str(),
        "org.freedesktop.portal.Session", "Close", nullptr,
        G_VARIANT_TYPE_UNIT, G_DBUS_CALL_FLAGS_NONE, 2000, nullptr, &error);
    if (reply) g_variant_unref(reply);
    g_clear_error(&error);
  }
  if (app->pipewireFd >= 0) {
    close(app->pipewireFd);
    app->pipewireFd = -1;
  }
  app->portalSession.clear();
  g_clear_object(&app->portalBus);
}

guint portal_cursor_mode(GDBusConnection* bus) {
  GError* error = nullptr;
  GVariant* reply = g_dbus_connection_call_sync(
      bus, kPortalBusName, kPortalObjectPath,
      "org.freedesktop.DBus.Properties", "Get",
      g_variant_new("(ss)", "org.freedesktop.portal.ScreenCast",
                    "AvailableCursorModes"),
      G_VARIANT_TYPE("(v)"), G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, &error);
  g_clear_error(&error);
  if (!reply) return 1;
  GVariant* value = nullptr;
  g_variant_get(reply, "(@v)", &value);
  GVariant* modes = g_variant_get_variant(value);
  const guint available = g_variant_get_uint32(modes);
  g_variant_unref(modes);
  g_variant_unref(value);
  g_variant_unref(reply);
  return (available & 2U) ? 2U : 1U;
}

bool open_pipewire_portal(App* app, CaptureConfig* config,
                          std::ostringstream* source, std::string* error) {
  GError* busError = nullptr;
  app->portalBus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &busError);
  if (!app->portalBus) {
    *error = busError ? busError->message : "Could not connect to the session bus";
    g_clear_error(&busError);
    return false;
  }

  const std::string createToken = portal_token("haven_create_");
  const std::string sessionToken = portal_token("haven_session_");
  GVariantBuilder createOptions;
  g_variant_builder_init(&createOptions, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&createOptions, "{sv}", "handle_token",
                        g_variant_new_string(createToken.c_str()));
  g_variant_builder_add(&createOptions, "{sv}", "session_handle_token",
                        g_variant_new_string(sessionToken.c_str()));
  GVariant* results = nullptr;
  if (!portal_request(app, "CreateSession",
                      g_variant_new("(@a{sv})", g_variant_builder_end(&createOptions)),
                      &results, error)) {
    close_portal_capture(app);
    return false;
  }

  GVariant* session = g_variant_lookup_value(
      results, "session_handle", G_VARIANT_TYPE_STRING);
  if (session) app->portalSession = g_variant_get_string(session, nullptr);
  if (session) g_variant_unref(session);
  g_variant_unref(results);
  if (app->portalSession.empty()) {
    *error = "Desktop portal returned no screen capture session";
    close_portal_capture(app);
    return false;
  }

  app->portalClosedSubscription = g_dbus_connection_signal_subscribe(
      app->portalBus, kPortalBusName, "org.freedesktop.portal.Session",
      "Closed", app->portalSession.c_str(), nullptr,
      G_DBUS_SIGNAL_FLAGS_NONE, on_portal_session_closed, app, nullptr);

  const std::string selectToken = portal_token("haven_select_");
  GVariantBuilder selectOptions;
  g_variant_builder_init(&selectOptions, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&selectOptions, "{sv}", "handle_token",
                        g_variant_new_string(selectToken.c_str()));
  g_variant_builder_add(&selectOptions, "{sv}", "types",
                        g_variant_new_uint32(3));
  g_variant_builder_add(&selectOptions, "{sv}", "multiple",
                        g_variant_new_boolean(FALSE));
  g_variant_builder_add(&selectOptions, "{sv}", "cursor_mode",
                        g_variant_new_uint32(portal_cursor_mode(app->portalBus)));
  if (!portal_request(app, "SelectSources",
                      g_variant_new("(o@a{sv})", app->portalSession.c_str(),
                                    g_variant_builder_end(&selectOptions)),
                      &results, error)) {
    close_portal_capture(app);
    return false;
  }
  g_variant_unref(results);

  const std::string startToken = portal_token("haven_start_");
  GVariantBuilder startOptions;
  g_variant_builder_init(&startOptions, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&startOptions, "{sv}", "handle_token",
                        g_variant_new_string(startToken.c_str()));
  if (!portal_request(app, "Start",
                      g_variant_new("(os@a{sv})", app->portalSession.c_str(), "",
                                    g_variant_builder_end(&startOptions)),
                      &results, error)) {
    close_portal_capture(app);
    return false;
  }

  GVariant* streams = g_variant_lookup_value(
      results, "streams", G_VARIANT_TYPE("a(ua{sv})"));
  if (!streams || g_variant_n_children(streams) == 0) {
    if (streams) g_variant_unref(streams);
    g_variant_unref(results);
    *error = "Desktop portal returned no PipeWire stream";
    close_portal_capture(app);
    return false;
  }

  guint nodeId = 0;
  GVariant* properties = nullptr;
  GVariant* firstStream = g_variant_get_child_value(streams, 0);
  g_variant_get(firstStream, "(u@a{sv})", &nodeId, &properties);
  guint64 serial = 0;
  g_variant_lookup(properties, "pipewire-serial", "t", &serial);
  GVariant* size = g_variant_lookup_value(properties, "size", G_VARIANT_TYPE("(ii)"));
  if (size) {
    g_variant_get(size, "(ii)", &config->sourceWidth, &config->sourceHeight);
    g_variant_unref(size);
  }
  g_variant_unref(properties);
  g_variant_unref(firstStream);
  g_variant_unref(streams);
  g_variant_unref(results);

  GUnixFDList* descriptors = nullptr;
  GError* remoteError = nullptr;
  GVariantBuilder remoteOptions;
  g_variant_builder_init(&remoteOptions, G_VARIANT_TYPE_VARDICT);
  GVariant* remote = g_dbus_connection_call_with_unix_fd_list_sync(
      app->portalBus, kPortalBusName, kPortalObjectPath,
      "org.freedesktop.portal.ScreenCast", "OpenPipeWireRemote",
      g_variant_new("(o@a{sv})", app->portalSession.c_str(),
                    g_variant_builder_end(&remoteOptions)),
      G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE, 10000, nullptr,
      &descriptors, nullptr, &remoteError);
  if (!remote) {
    *error = remoteError ? remoteError->message : "Could not open the PipeWire remote";
    g_clear_error(&remoteError);
    if (descriptors) g_object_unref(descriptors);
    close_portal_capture(app);
    return false;
  }

  gint descriptorIndex = -1;
  g_variant_get(remote, "(h)", &descriptorIndex);
  g_variant_unref(remote);
  app->pipewireFd = g_unix_fd_list_get(descriptors, descriptorIndex, &remoteError);
  g_object_unref(descriptors);
  if (app->pipewireFd < 0) {
    *error = remoteError ? remoteError->message : "Desktop portal returned no PipeWire descriptor";
    g_clear_error(&remoteError);
    close_portal_capture(app);
    return false;
  }

  *source << "pipewiresrc fd=" << app->pipewireFd;
  if (serial > 0 && factory_has_property("pipewiresrc", "target-object")) {
    *source << " target-object=" << serial;
  } else {
    *source << " path=" << nodeId;
  }
  if (factory_has_property("pipewiresrc", "on-disconnect")) {
    *source << " on-disconnect=error";
  }
  *source << " do-timestamp=true";
  return true;
}
#endif

bool build_pipeline_description(App* app, CaptureConfig config,
                                 const std::string& encoderName,
                                 std::string* description,
                                 std::string* error) {
  std::ostringstream source;
  bool d3d11 = false;

#ifdef G_OS_WIN32
  (void)app;
  guint64 handle = 0;
  if (config.sourceKind == "test") {
    source << "videotestsrc is-live=true pattern=ball";
  } else if (config.sourceKind == "windows-window") {
    if (!parse_u64(config.sourceHandle, &handle)) {
      *error = "Invalid Windows capture handle";
      return false;
    }
    d3d11 = true;
    source << "d3d11screencapturesrc capture-api=wgc window-handle=" << handle
           << " show-cursor=true";
  } else if (config.sourceKind == "windows-monitor") {
    const POINT point{config.x, config.y};
    const HMONITOR monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONULL);
    if (!monitor) {
      *error = "Selected Windows monitor is no longer available";
      return false;
    }
    d3d11 = true;
    source << "d3d11screencapturesrc monitor-handle="
           << reinterpret_cast<uintptr_t>(monitor)
           << " show-cursor=true";
  } else {
    *error = "Unsupported Windows capture source";
    return false;
  }
#else
  guint64 handle = 0;
  if (config.sourceKind == "linux-pipewire") {
    if (!open_pipewire_portal(app, &config, &source, error)) return false;
  } else if (config.sourceKind == "linux-x11-window") {
    if (!parse_u64(config.sourceHandle, &handle)) {
      *error = "Invalid X11 window identifier";
      return false;
    }
    source << "ximagesrc xid=" << handle << " show-pointer=true use-damage=false";
  } else if (config.sourceKind == "linux-x11-screen") {
    source << "ximagesrc xid=0 show-pointer=true use-damage=false";
    if (config.sourceWidth > 0 && config.sourceHeight > 0) {
      source << " startx=" << std::max(0, config.x)
             << " starty=" << std::max(0, config.y)
             << " endx=" << std::max(0, config.x) + config.sourceWidth - 1
             << " endy=" << std::max(0, config.y) + config.sourceHeight - 1;
    }
  } else if (config.sourceKind == "test") {
    source << "videotestsrc is-live=true pattern=ball";
  } else {
    *error = "Unsupported Linux capture source";
    return false;
  }
#endif

  const CodecSpec* codec = codec_spec(config.codec);
  if (!codec || encoderName.empty()) {
    *error = "No compatible native encoder is available for " + config.codec;
    return false;
  }

  const int bitrateKbps = std::max(250, config.bitrate / 1000);
  const int keyInterval = std::max(1, config.frameRate * 2);
  std::ostringstream pipeline;
  pipeline << source.str()
           << " ! queue max-size-buffers=2 leaky=downstream"
           << " ! videorate drop-only=true";

  if (d3d11) {
    pipeline << " ! d3d11convert ! " << output_caps(config, true);
    if (!encoder_accepts_d3d11(encoderName)) {
      pipeline << " ! d3d11download ! videoconvert ! videoscale add-borders=false ! "
               << output_caps(config, false);
    }
  } else {
    pipeline << " ! videoscale add-borders=false ! videoconvert ! "
             << output_caps(config, false);
  }

  pipeline << " !";
  append_encoder_properties(&pipeline, encoderName, bitrateKbps, keyInterval);
  pipeline << " ! " << codec->encodedCaps
           << " ! " << codec->parser;
  if (config.codec == "H264" || config.codec == "H265") {
    pipeline << " config-interval=-1";
  }
  pipeline << " ! " << codec->payloader << " pt=96";
  if (config.codec == "H264") {
    pipeline << " config-interval=-1 aggregate-mode=zero-latency";
  } else if (config.codec == "H265") {
    pipeline << " config-interval=-1";
  }
  pipeline << " ! application/x-rtp,media=video,encoding-name="
           << codec->rtpEncoding << ",payload=96,clock-rate=90000"
           << " ! tee name=videortptee videortptee. ! queue ! fakesink sync=false";
  if (config.hasAudio) {
    pipeline << " appsrc name=audiosrc is-live=true format=time do-timestamp=true"
              << " block=true max-bytes=19200"
             << " caps=audio/x-raw,format=F32LE,rate=48000,channels=1,layout=interleaved"
             << " ! queue max-size-time=100000000 leaky=downstream"
             << " ! audioconvert ! audioresample ! opusenc bitrate=128000"
             << " ! rtpopuspay pt=97"
             << " ! application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000,encoding-params=1"
             << " ! tee name=audiortptee audiortptee. ! queue ! fakesink sync=false";
  }
  *description = pipeline.str();
  return true;
}

void stop_pipeline(App* app);

gboolean stop_after_terminal_message(gpointer userData) {
  App* app = static_cast<App*>(userData);
  if (!app->stopping) {
    app->stopping = true;
    stop_pipeline(app);
    g_main_loop_quit(app->loop);
  }
  return G_SOURCE_REMOVE;
}

void queue_terminal_stop(App* app) {
  if (app->stopping) return;
  bool expected = false;
  if (!app->terminalQueued.compare_exchange_strong(expected, true)) return;
  g_idle_add(stop_after_terminal_message, app);
}

gboolean bus_watch_cb(GstBus*, GstMessage* message, gpointer userData) {
  App* app = static_cast<App*>(userData);
  if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
    GError* error = nullptr;
    gchar* debug = nullptr;
    gst_message_parse_error(message, &error, &debug);
    const std::string text = error ? error->message : "Unknown GStreamer error";
    std::cerr << "[NativeScreen] " << text;
    if (debug) std::cerr << " (" << debug << ")";
    std::cerr << std::endl;
    emit_error(app, "", text, true);
    queue_terminal_stop(app);
    g_clear_error(&error);
    g_free(debug);
  } else if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_EOS) {
    emit_error(app, "", "Screen capture ended", true);
    queue_terminal_stop(app);
  } else if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_WARNING) {
    GError* warning = nullptr;
    gchar* debug = nullptr;
    gst_message_parse_warning(message, &warning, &debug);
    std::cerr << "[NativeScreen] warning: "
              << (warning ? warning->message : "unknown") << std::endl;
    g_clear_error(&warning);
    g_free(debug);
  }
  return G_SOURCE_CONTINUE;
}

struct PendingOffer {
  App* app;
  std::string peerId;
  guint64 generation;
  GstWebRTCSessionDescription* offer;
};

gboolean dispatch_offer(gpointer userData) {
  std::unique_ptr<PendingOffer> pending(static_cast<PendingOffer*>(userData));
  auto found = pending->app->peers.find(pending->peerId);
  if (found != pending->app->peers.end() &&
      found->second->generation == pending->generation &&
      found->second->active.load() &&
      found->second->webrtc) {
    Peer* peer = found->second.get();
    GstPromise* localPromise = gst_promise_new();
    g_signal_emit_by_name(peer->webrtc, "set-local-description",
                          pending->offer, localPromise);
    gst_promise_interrupt(localPromise);
    gst_promise_unref(localPromise);

    gchar* sdp = gst_sdp_message_as_text(pending->offer->sdp);
    if (sdp) emit_event(pending->app, "OFFER", {
        pending->app->sessionId, pending->peerId, sdp,
    });
    g_free(sdp);
  }
  gst_webrtc_session_description_free(pending->offer);
  return G_SOURCE_REMOVE;
}

struct OfferRequest {
  App* app;
  std::string peerId;
  guint64 generation;
};

void on_offer_created(GstPromise* promise, gpointer userData) {
  std::unique_ptr<OfferRequest> request(static_cast<OfferRequest*>(userData));

  const GstStructure* reply = gst_promise_get_reply(promise);
  GstWebRTCSessionDescription* offer = nullptr;
  if (!reply || !gst_structure_get(reply, "offer",
                                    GST_TYPE_WEBRTC_SESSION_DESCRIPTION,
                                    &offer, nullptr) || !offer) {
    gst_promise_unref(promise);
    emit_error(request->app, request->peerId,
               "Failed to create WebRTC offer", false);
    return;
  }
  gst_promise_unref(promise);
  auto* pending = new PendingOffer{
      request->app, request->peerId, request->generation, offer,
  };
  g_main_context_invoke(nullptr, dispatch_offer, pending);
}

void on_negotiation_needed(GstElement* webrtc, gpointer userData) {
  Peer* peer = static_cast<Peer*>(userData);
  if (!peer->active.load()) return;
  auto* request = new OfferRequest{peer->app, peer->id, peer->generation};
  GstPromise* promise = gst_promise_new_with_change_func(
      on_offer_created, request, nullptr);
  g_signal_emit_by_name(webrtc, "create-offer", nullptr, promise);
}

struct PendingIce {
  App* app;
  std::string peerId;
  guint64 generation;
  guint mlineIndex;
  std::string candidate;
  bool end;
};

gboolean dispatch_ice(gpointer userData) {
  std::unique_ptr<PendingIce> pending(static_cast<PendingIce*>(userData));
  auto found = pending->app->peers.find(pending->peerId);
  if (found == pending->app->peers.end() ||
      found->second->generation != pending->generation ||
      !found->second->active.load()) {
    return G_SOURCE_REMOVE;
  }
  emit_event(pending->app, "ICE", {
      pending->app->sessionId,
      pending->peerId,
      pending->candidate,
      "",
      std::to_string(pending->mlineIndex),
      "",
      pending->end ? "1" : "0",
  });
  return G_SOURCE_REMOVE;
}

void on_ice_candidate(GstElement*, guint mlineIndex, gchar* candidate,
                       gpointer userData) {
  Peer* peer = static_cast<Peer*>(userData);
  if (!peer->active.load()) return;
  auto* pending = new PendingIce{
      peer->app, peer->id, peer->generation, mlineIndex,
      candidate ? candidate : "", !candidate,
  };
  g_main_context_invoke(nullptr, dispatch_ice, pending);
}

void configure_ice(Peer* peer) {
  const CaptureConfig& config = peer->app->config;
  const std::string stun = normalize_ice_url(config.stunUrl);
  if (!stun.empty()) g_object_set(peer->webrtc, "stun-server", stun.c_str(), nullptr);
  const guint addTurnSignal = g_signal_lookup(
      "add-turn-server", G_OBJECT_TYPE(peer->webrtc));
  bool configuredTurn = false;
  for (const auto& server : config.turnServers) {
    const std::string turn = build_turn_url(server);
    if (turn.empty()) continue;
    if (addTurnSignal) {
      gboolean added = FALSE;
      g_signal_emit_by_name(peer->webrtc, "add-turn-server", turn.c_str(), &added);
      configuredTurn = configuredTurn || added;
    } else if (!configuredTurn) {
      g_object_set(peer->webrtc, "turn-server", turn.c_str(), nullptr);
      configuredTurn = true;
    }
  }
  g_object_set(peer->webrtc,
               "bundle-policy", GST_WEBRTC_BUNDLE_POLICY_MAX_BUNDLE,
               "ice-transport-policy",
               config.icePolicy == "relay" ? GST_WEBRTC_ICE_TRANSPORT_POLICY_RELAY
                                            : GST_WEBRTC_ICE_TRANSPORT_POLICY_ALL,
               nullptr);
}

bool add_peer(App* app, const std::string& peerId, std::string* error) {
  if (peerId.empty() || app->peers.count(peerId)) return true;
  if (app->peers.size() >= kMaxActivePeers) {
    *error = "Native screen peer limit reached";
    return false;
  }
  if (app->nextPeerGeneration > kMaxPeerGenerations) {
    *error = "Native screen peer generation limit reached";
    return false;
  }
  auto peer = std::make_unique<Peer>();
  peer->app = app;
  peer->id = peerId;
  peer->generation = app->nextPeerGeneration++;
  peer->videoQueue = gst_element_factory_make("queue", nullptr);
  peer->videoCapsFilter = gst_element_factory_make("capsfilter", nullptr);
  if (app->config.hasAudio) {
    peer->audioQueue = gst_element_factory_make("queue", nullptr);
    peer->audioCapsFilter = gst_element_factory_make("capsfilter", nullptr);
  }
  peer->webrtc = gst_element_factory_make("webrtcbin", nullptr);
  if (!peer->videoQueue || !peer->videoCapsFilter || !peer->webrtc ||
      (app->config.hasAudio && (!peer->audioQueue || !peer->audioCapsFilter))) {
    *error = "Could not create per-viewer WebRTC elements";
    if (peer->videoQueue) gst_object_unref(peer->videoQueue);
    if (peer->videoCapsFilter) gst_object_unref(peer->videoCapsFilter);
    if (peer->audioQueue) gst_object_unref(peer->audioQueue);
    if (peer->audioCapsFilter) gst_object_unref(peer->audioCapsFilter);
    if (peer->webrtc) gst_object_unref(peer->webrtc);
    return false;
  }

  g_object_set(peer->videoQueue,
               "max-size-buffers", 4,
               "max-size-bytes", 0,
               "max-size-time", static_cast<guint64>(0),
               "leaky", 2,
               nullptr);
  GstCaps* rtpCaps = gst_caps_from_string(
      ("application/x-rtp,media=video,encoding-name=" + app->config.codec +
       ",payload=96,clock-rate=90000").c_str());
  g_object_set(peer->videoCapsFilter, "caps", rtpCaps, nullptr);
  gst_caps_unref(rtpCaps);
  if (app->config.hasAudio) {
    g_object_set(peer->audioQueue,
                 "max-size-buffers", 8,
                 "max-size-bytes", 0,
                 "max-size-time", static_cast<guint64>(100 * GST_MSECOND),
                 "leaky", 2,
                 nullptr);
    GstCaps* audioCaps = gst_caps_from_string(
        "application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000,encoding-params=1");
    g_object_set(peer->audioCapsFilter, "caps", audioCaps, nullptr);
    gst_caps_unref(audioCaps);
  }
  configure_ice(peer.get());
  g_signal_connect(peer->webrtc, "on-negotiation-needed",
                   G_CALLBACK(on_negotiation_needed), peer.get());
  g_signal_connect(peer->webrtc, "on-ice-candidate",
                   G_CALLBACK(on_ice_candidate), peer.get());

  gst_bin_add_many(GST_BIN(app->pipeline), peer->videoQueue, peer->videoCapsFilter,
                   peer->webrtc, nullptr);
  if (app->config.hasAudio) {
    gst_bin_add_many(GST_BIN(app->pipeline), peer->audioQueue,
                     peer->audioCapsFilter, nullptr);
  }
  if (!gst_element_link_many(peer->videoQueue, peer->videoCapsFilter,
                             peer->webrtc, nullptr) ||
      (app->config.hasAudio &&
       !gst_element_link_many(peer->audioQueue, peer->audioCapsFilter,
                              peer->webrtc, nullptr))) {
    *error = "Could not link viewer queue to webrtcbin";
    peer->active = false;
    gst_element_set_state(peer->videoQueue, GST_STATE_NULL);
    gst_element_set_state(peer->videoCapsFilter, GST_STATE_NULL);
    gst_element_set_state(peer->webrtc, GST_STATE_NULL);
    if (peer->audioQueue) gst_element_set_state(peer->audioQueue, GST_STATE_NULL);
    if (peer->audioCapsFilter) gst_element_set_state(peer->audioCapsFilter, GST_STATE_NULL);
    if (peer->audioQueue && peer->audioCapsFilter) {
      gst_bin_remove_many(GST_BIN(app->pipeline), peer->audioQueue,
                          peer->audioCapsFilter, nullptr);
    }
    gst_bin_remove_many(GST_BIN(app->pipeline), peer->videoQueue,
                        peer->videoCapsFilter, peer->webrtc, nullptr);
    peer->videoQueue = nullptr;
    peer->videoCapsFilter = nullptr;
    peer->audioQueue = nullptr;
    peer->audioCapsFilter = nullptr;
    peer->webrtc = nullptr;
    return false;
  }

  peer->videoTeePad = gst_element_request_pad_simple(app->videoRtpTee, "src_%u");
  GstPad* queueSink = gst_element_get_static_pad(peer->videoQueue, "sink");
  const GstPadLinkReturn linkResult = peer->videoTeePad && queueSink
      ? gst_pad_link(peer->videoTeePad, queueSink)
      : GST_PAD_LINK_REFUSED;
  if (queueSink) gst_object_unref(queueSink);
  GstPadLinkReturn audioLinkResult = GST_PAD_LINK_OK;
  if (app->config.hasAudio) {
    peer->audioTeePad = gst_element_request_pad_simple(app->audioRtpTee, "src_%u");
    GstPad* audioQueueSink = gst_element_get_static_pad(peer->audioQueue, "sink");
    audioLinkResult = peer->audioTeePad && audioQueueSink
        ? gst_pad_link(peer->audioTeePad, audioQueueSink)
        : GST_PAD_LINK_REFUSED;
    if (audioQueueSink) gst_object_unref(audioQueueSink);
  }
  if (linkResult != GST_PAD_LINK_OK || audioLinkResult != GST_PAD_LINK_OK) {
    *error = "Could not attach viewer to encoded RTP stream";
    peer->active = false;
    if (peer->videoTeePad) {
      gst_element_release_request_pad(app->videoRtpTee, peer->videoTeePad);
      gst_object_unref(peer->videoTeePad);
      peer->videoTeePad = nullptr;
    }
    if (peer->audioTeePad) {
      gst_element_release_request_pad(app->audioRtpTee, peer->audioTeePad);
      gst_object_unref(peer->audioTeePad);
      peer->audioTeePad = nullptr;
    }
    gst_element_set_state(peer->videoQueue, GST_STATE_NULL);
    gst_element_set_state(peer->videoCapsFilter, GST_STATE_NULL);
    if (peer->audioQueue) gst_element_set_state(peer->audioQueue, GST_STATE_NULL);
    if (peer->audioCapsFilter) gst_element_set_state(peer->audioCapsFilter, GST_STATE_NULL);
    gst_element_set_state(peer->webrtc, GST_STATE_NULL);
    if (peer->audioQueue && peer->audioCapsFilter) {
      gst_bin_remove_many(GST_BIN(app->pipeline), peer->audioQueue,
                          peer->audioCapsFilter, nullptr);
    }
    gst_bin_remove_many(GST_BIN(app->pipeline), peer->videoQueue,
                        peer->videoCapsFilter, peer->webrtc, nullptr);
    peer->videoQueue = nullptr;
    peer->videoCapsFilter = nullptr;
    peer->audioQueue = nullptr;
    peer->audioCapsFilter = nullptr;
    peer->webrtc = nullptr;
    return false;
  }

  gst_element_sync_state_with_parent(peer->videoQueue);
  gst_element_sync_state_with_parent(peer->videoCapsFilter);
  if (peer->audioQueue) gst_element_sync_state_with_parent(peer->audioQueue);
  if (peer->audioCapsFilter) gst_element_sync_state_with_parent(peer->audioCapsFilter);
  gst_element_sync_state_with_parent(peer->webrtc);

  GArray* transceivers = nullptr;
  g_signal_emit_by_name(peer->webrtc, "get-transceivers", &transceivers);
  if (transceivers) {
    for (guint index = 0; index < transceivers->len; ++index) {
      auto* transceiver = g_array_index(
          transceivers, GstWebRTCRTPTransceiver*, index);
      g_object_set(transceiver, "direction",
                   GST_WEBRTC_RTP_TRANSCEIVER_DIRECTION_SENDONLY, nullptr);
    }
    g_array_unref(transceivers);
  }

  app->peers.emplace(peerId, std::move(peer));
  return true;
}

void remove_peer(App* app, const std::string& peerId) {
  auto found = app->peers.find(peerId);
  if (found == app->peers.end()) return;
  std::unique_ptr<Peer> peer = std::move(found->second);
  app->peers.erase(found);
  peer->active = false;

  if (peer->webrtc) g_signal_handlers_disconnect_by_data(peer->webrtc, peer.get());
  if (peer->videoTeePad && peer->videoQueue) {
    gst_pad_set_active(peer->videoTeePad, FALSE);
    GstPad* queueSink = gst_element_get_static_pad(peer->videoQueue, "sink");
    if (queueSink) {
      gst_pad_unlink(peer->videoTeePad, queueSink);
      gst_object_unref(queueSink);
    }
  }
  if (peer->audioTeePad && peer->audioQueue) {
    gst_pad_set_active(peer->audioTeePad, FALSE);
    GstPad* queueSink = gst_element_get_static_pad(peer->audioQueue, "sink");
    if (queueSink) {
      gst_pad_unlink(peer->audioTeePad, queueSink);
      gst_object_unref(queueSink);
    }
  }
  if (peer->videoTeePad) {
    gst_element_release_request_pad(app->videoRtpTee, peer->videoTeePad);
    gst_object_unref(peer->videoTeePad);
    peer->videoTeePad = nullptr;
  }
  if (peer->audioTeePad) {
    gst_element_release_request_pad(app->audioRtpTee, peer->audioTeePad);
    gst_object_unref(peer->audioTeePad);
    peer->audioTeePad = nullptr;
  }
  if (peer->videoQueue) gst_element_set_state(peer->videoQueue, GST_STATE_NULL);
  if (peer->videoCapsFilter) gst_element_set_state(peer->videoCapsFilter, GST_STATE_NULL);
  if (peer->audioQueue) gst_element_set_state(peer->audioQueue, GST_STATE_NULL);
  if (peer->audioCapsFilter) gst_element_set_state(peer->audioCapsFilter, GST_STATE_NULL);
  if (peer->webrtc) gst_element_set_state(peer->webrtc, GST_STATE_NULL);
  if (peer->audioQueue && peer->audioCapsFilter) {
    gst_bin_remove_many(GST_BIN(app->pipeline), peer->audioQueue,
                        peer->audioCapsFilter, nullptr);
  }
  if (peer->videoQueue && peer->videoCapsFilter && peer->webrtc) {
    gst_bin_remove_many(GST_BIN(app->pipeline), peer->videoQueue, peer->videoCapsFilter,
                        peer->webrtc, nullptr);
  }
  peer->videoQueue = nullptr;
  peer->videoCapsFilter = nullptr;
  peer->audioQueue = nullptr;
  peer->audioCapsFilter = nullptr;
  peer->webrtc = nullptr;
  app->retiredPeers.push_back(std::move(peer));
}

void stop_pipeline(App* app) {
  for (auto& entry : app->peers) {
    Peer* peer = entry.second.get();
    peer->active = false;
    if (peer->webrtc) g_signal_handlers_disconnect_by_data(peer->webrtc, peer);
  }

  if (app->busWatch) {
    g_source_remove(app->busWatch);
    app->busWatch = 0;
  }
  if (app->pipeline) {
    {
      std::lock_guard<std::mutex> lock(app->audioMutex);
      if (app->audioSource) {
        gst_object_unref(app->audioSource);
        app->audioSource = nullptr;
      }
    }
    gst_element_set_state(app->pipeline, GST_STATE_NULL);
    for (auto& entry : app->peers) {
      Peer* peer = entry.second.get();
      if (peer->videoTeePad) {
        gst_element_release_request_pad(app->videoRtpTee, peer->videoTeePad);
        gst_object_unref(peer->videoTeePad);
        peer->videoTeePad = nullptr;
      }
      if (peer->audioTeePad) {
        gst_element_release_request_pad(app->audioRtpTee, peer->audioTeePad);
        gst_object_unref(peer->audioTeePad);
        peer->audioTeePad = nullptr;
      }
      peer->videoQueue = nullptr;
      peer->videoCapsFilter = nullptr;
      peer->audioQueue = nullptr;
      peer->audioCapsFilter = nullptr;
      peer->webrtc = nullptr;
    }
    gst_object_unref(app->pipeline);
    app->pipeline = nullptr;
    app->videoRtpTee = nullptr;
    app->audioRtpTee = nullptr;
  }
  for (auto& entry : app->peers) {
    app->retiredPeers.push_back(std::move(entry.second));
  }
  app->peers.clear();
#ifndef G_OS_WIN32
  close_portal_capture(app);
#endif
}

bool start_pipeline_with_encoder(App* app, const CaptureConfig& config,
                                 const std::string& encoder,
                                 std::string* error) {
  std::string pipelineDescription;
  if (!build_pipeline_description(
          app, config, encoder, &pipelineDescription, error)) {
    return false;
  }
  const CodecSpec* codec = codec_spec(config.codec);
  const bool commonTransport = factory_exists("webrtcbin") &&
      factory_exists("nicesrc") && factory_exists("nicesink") &&
      factory_exists("dtlsenc") && factory_exists("srtpenc");
  const bool videoTransport = codec && factory_exists(codec->payloader) &&
      factory_exists(codec->parser) && factory_exists(encoder.c_str());
  const bool audioTransport = !config.hasAudio ||
      (factory_exists("appsrc") && factory_exists("audioconvert") &&
       factory_exists("audioresample") && factory_exists("opusenc") &&
       factory_exists("rtpopuspay"));
  if (!commonTransport || !videoTransport || !audioTransport) {
    *error = "Required GStreamer native media plugins are unavailable";
    return false;
  }

  GError* parseError = nullptr;
  app->pipeline = gst_parse_launch(pipelineDescription.c_str(), &parseError);
  if (!app->pipeline || parseError) {
    *error = parseError ? parseError->message : "Could not create capture pipeline";
    g_clear_error(&parseError);
    if (app->pipeline) {
      gst_object_unref(app->pipeline);
      app->pipeline = nullptr;
    }
    return false;
  }
  app->videoRtpTee = gst_bin_get_by_name(GST_BIN(app->pipeline), "videortptee");
  app->audioRtpTee = config.hasAudio
      ? gst_bin_get_by_name(GST_BIN(app->pipeline), "audiortptee")
      : nullptr;
  if (!app->videoRtpTee || (config.hasAudio && !app->audioRtpTee)) {
    *error = "Encoded media RTP tee was not created";
    stop_pipeline(app);
    return false;
  }
  gst_object_unref(app->videoRtpTee);
  if (app->audioRtpTee) gst_object_unref(app->audioRtpTee);
  if (config.hasAudio) {
    GstElement* audioSource = gst_bin_get_by_name(GST_BIN(app->pipeline), "audiosrc");
    if (!audioSource) {
      *error = "Native audio input was not created";
      stop_pipeline(app);
      return false;
    }
    std::lock_guard<std::mutex> lock(app->audioMutex);
    app->audioSource = audioSource;
  }

  GstBus* bus = gst_element_get_bus(app->pipeline);
  app->busWatch = gst_bus_add_watch(bus, bus_watch_cb, app);
  gst_object_unref(bus);
  const GstStateChangeReturn state = gst_element_set_state(
      app->pipeline, GST_STATE_PLAYING);
  if (state == GST_STATE_CHANGE_FAILURE) {
    *error = "GStreamer capture pipeline failed to start";
    stop_pipeline(app);
    return false;
  }
  if (state == GST_STATE_CHANGE_ASYNC) {
    const GstStateChangeReturn settled = gst_element_get_state(
        app->pipeline, nullptr, nullptr, 5 * GST_SECOND);
    if (settled != GST_STATE_CHANGE_SUCCESS &&
        settled != GST_STATE_CHANGE_NO_PREROLL) {
      *error = "GStreamer capture pipeline did not reach PLAYING";
      stop_pipeline(app);
      return false;
    }
  }
  return true;
}

bool preflight_encoder_pipeline(App* app, const CaptureConfig& config,
                                const std::string& encoder,
                                std::string* error) {
  CaptureConfig testConfig = config;
  testConfig.sourceKind = "test";
  testConfig.sourceHandle.clear();
  testConfig.sourceWidth = 1280;
  testConfig.sourceHeight = 720;
  testConfig.outputHeight = config.outputHeight > 0 ? config.outputHeight : 720;
  testConfig.hasAudio = false;

  std::string description;
  if (!build_pipeline_description(
          app, testConfig, encoder, &description, error)) {
    return false;
  }
  GError* parseError = nullptr;
  GstElement* pipeline = gst_parse_launch(description.c_str(), &parseError);
  if (!pipeline || parseError) {
    *error = parseError ? parseError->message : "Could not create encoder preflight pipeline";
    g_clear_error(&parseError);
    if (pipeline) gst_object_unref(pipeline);
    return false;
  }

  GstStateChangeReturn state = gst_element_set_state(pipeline, GST_STATE_PLAYING);
  if (state == GST_STATE_CHANGE_ASYNC) {
    state = gst_element_get_state(pipeline, nullptr, nullptr, 5 * GST_SECOND);
  }
  const bool usable = state == GST_STATE_CHANGE_SUCCESS ||
      state == GST_STATE_CHANGE_NO_PREROLL;
  if (!usable) *error = "Encoder preflight pipeline did not reach PLAYING";
  gst_element_set_state(pipeline, GST_STATE_NULL);
  gst_object_unref(pipeline);
  return usable;
}

bool start_pipeline(App* app, const CaptureConfig& config, std::string* error) {
  const auto encoders = available_encoders(config.codec);
  if (encoders.empty()) {
    *error = "No usable native encoder is available for " + config.codec;
    return false;
  }

  std::string lastError;
  if (config.sourceKind == "linux-pipewire") {
    for (const auto& encoder : encoders) {
      std::string preflightError;
      if (!preflight_encoder_pipeline(app, config, encoder, &preflightError)) {
        lastError = encoder + ": " + preflightError;
        std::cerr << "[NativeScreen] encoder preflight failed: "
                  << lastError << std::endl;
        continue;
      }
      if (start_pipeline_with_encoder(app, config, encoder, error)) return true;
      stop_pipeline(app);
      return false;
    }
    *error = "No native encoder pipeline could start for " + config.codec;
    if (!lastError.empty()) *error += " (" + lastError + ")";
    return false;
  }

  for (const auto& encoder : encoders) {
    std::string attemptError;
    if (start_pipeline_with_encoder(app, config, encoder, &attemptError)) return true;
    stop_pipeline(app);
    lastError = encoder + ": " + attemptError;
    std::cerr << "[NativeScreen] encoder attempt failed: " << lastError << std::endl;
  }
  *error = "No native encoder pipeline could start for " + config.codec;
  if (!lastError.empty()) *error += " (" + lastError + ")";
  return false;
}

void apply_remote_description(App* app, const std::vector<std::string>& fields) {
  if (fields.size() != 5 || fields[1] != app->sessionId || fields[3] != "answer") return;
  auto found = app->peers.find(fields[2]);
  if (found == app->peers.end() || !found->second->webrtc) return;

  GstSDPMessage* sdp = nullptr;
  if (gst_sdp_message_new(&sdp) != GST_SDP_OK ||
      gst_sdp_message_parse_buffer(
          reinterpret_cast<const guint8*>(fields[4].data()), fields[4].size(), sdp) != GST_SDP_OK) {
    if (sdp) gst_sdp_message_free(sdp);
    emit_error(app, fields[2], "Could not parse WebRTC answer", false);
    return;
  }
  GstWebRTCSessionDescription* answer = gst_webrtc_session_description_new(
      GST_WEBRTC_SDP_TYPE_ANSWER, sdp);
  GstPromise* promise = gst_promise_new();
  g_signal_emit_by_name(found->second->webrtc, "set-remote-description",
                        answer, promise);
  gst_promise_interrupt(promise);
  gst_promise_unref(promise);
  gst_webrtc_session_description_free(answer);
}

void apply_ice_candidate(App* app, const std::vector<std::string>& fields) {
  if (fields.size() != 8 || fields[1] != app->sessionId) return;
  auto found = app->peers.find(fields[2]);
  if (found == app->peers.end() || !found->second->webrtc) return;
  int mlineIndex = 0;
  if (!fields[5].empty() && !parse_int(fields[5], 0, 128, &mlineIndex)) return;
  const gchar* candidate = fields[7] == "1" ? nullptr : fields[3].c_str();
  g_signal_emit_by_name(found->second->webrtc, "add-ice-candidate",
                        static_cast<guint>(mlineIndex), candidate);
}

void handle_start(App* app, const std::vector<std::string>& fields) {
  if (fields.size() < 2 || !valid_session_id(fields[1])) return;
  app->sessionId = fields[1];
  if (fields.size() != 16) {
    emit_error(app, "", "Malformed START command", true);
    return;
  }
  if (app->pipeline) {
    emit_error(app, "", "Native screen session is already running", true);
    return;
  }
  CaptureConfig config;
  config.sourceKind = fields[2];
  config.sourceHandle = fields[3];
  if (!parse_int(fields[4], -100000, 100000, &config.x) ||
      !parse_int(fields[5], -100000, 100000, &config.y) ||
      !parse_int(fields[6], 0, 16384, &config.sourceWidth) ||
      !parse_int(fields[7], 0, 16384, &config.sourceHeight) ||
      !parse_int(fields[8], 0, 4320, &config.outputHeight) ||
      !parse_int(fields[9], 1, 120, &config.frameRate) ||
      !parse_int(fields[10], 250000, 50000000, &config.bitrate)) {
    emit_error(app, "", "Invalid numeric START field", true);
    return;
  }
  config.icePolicy = fields[11] == "relay" ? "relay" : "all";
  config.stunUrl = fields[12];
  config.turnServers = parse_turn_servers(fields[13]);
  config.codec = fields[14];
  if (fields[15] != "0" && fields[15] != "1") {
    emit_error(app, "", "Invalid START audio flag", true);
    return;
  }
  config.hasAudio = fields[15] == "1";
  if (!codec_spec(config.codec)) {
    emit_error(app, "", "Unsupported START codec", true);
    return;
  }
  app->config = config;
  app->starting = true;
  app->cancelStartup = false;

  std::string error;
  const bool started = start_pipeline(app, config, &error);
  app->starting = false;
  if (app->cancelStartup) {
    app->stopping = true;
    stop_pipeline(app);
    emit_event(app, "STOPPED", {app->sessionId});
    g_main_loop_quit(app->loop);
    return;
  }
  if (!started) {
    emit_error(app, "", error, true);
    return;
  }
  emit_event(app, "READY", {app->sessionId});
}

void handle_command(App* app, const std::string& line) {
  const auto fields = decode_command_fields(line);
  if (fields.empty()) return;
  const std::string& command = fields[0];
  if (command == "START") {
    handle_start(app, fields);
  } else if (command == "ADD_PEER" && fields.size() == 3 &&
             fields[1] == app->sessionId) {
    std::string error;
    if (!add_peer(app, fields[2], &error)) emit_error(app, fields[2], error, false);
  } else if (command == "REMOVE_PEER" && fields.size() == 3 &&
             fields[1] == app->sessionId) {
    remove_peer(app, fields[2]);
  } else if (command == "REMOTE_DESCRIPTION") {
    apply_remote_description(app, fields);
  } else if (command == "ICE") {
    apply_ice_candidate(app, fields);
  } else if (command == "STOP" && fields.size() == 2 &&
              fields[1] == app->sessionId) {
    if (app->starting) {
      app->cancelStartup = true;
#ifndef G_OS_WIN32
      if (app->portalRequestLoop) g_main_loop_quit(app->portalRequestLoop);
#endif
      return;
    }
    app->stopping = true;
    stop_pipeline(app);
    emit_event(app, "STOPPED", {app->sessionId});
    g_main_loop_quit(app->loop);
  }
}

struct PendingCommand {
  App* app;
  std::string line;
};

gboolean dispatch_command(gpointer data) {
  std::unique_ptr<PendingCommand> pending(static_cast<PendingCommand*>(data));
  handle_command(pending->app, pending->line);
  return G_SOURCE_REMOVE;
}

gboolean dispatch_eof(gpointer data) {
  App* app = static_cast<App*>(data);
  if (!app->stopping) {
    app->stopping = true;
    stop_pipeline(app);
    g_main_loop_quit(app->loop);
  }
  return G_SOURCE_REMOVE;
}

void read_commands(App* app) {
  std::string line;
  while (std::getline(std::cin, line)) {
    auto* pending = new PendingCommand{app, std::move(line)};
    g_main_context_invoke(nullptr, dispatch_command, pending);
  }
  g_main_context_invoke(nullptr, dispatch_eof, app);
}

void read_audio(App* app) {
  std::vector<guint8> pending;
  pending.reserve(8192);
  guint8 chunk[8192];
  while (true) {
#ifdef G_OS_WIN32
    const int received = _read(3, chunk, sizeof(chunk));
#else
    const ssize_t received = read(3, chunk, sizeof(chunk));
#endif
    if (received <= 0) return;
    pending.insert(pending.end(), chunk, chunk + received);
    const size_t aligned = pending.size() - (pending.size() % sizeof(float));
    if (aligned == 0) continue;

    GstElement* source = nullptr;
    {
      std::lock_guard<std::mutex> lock(app->audioMutex);
      if (app->audioSource) source = GST_ELEMENT(gst_object_ref(app->audioSource));
    }
    if (source) {
      GstBuffer* buffer = gst_buffer_new_allocate(nullptr, aligned, nullptr);
      gst_buffer_fill(buffer, 0, pending.data(), aligned);
      GST_BUFFER_DURATION(buffer) = gst_util_uint64_scale(
          aligned / sizeof(float), GST_SECOND, 48000);
      const GstFlowReturn flow = gst_app_src_push_buffer(GST_APP_SRC(source), buffer);
      gst_object_unref(source);
      if (flow != GST_FLOW_OK && flow != GST_FLOW_FLUSHING && !app->stopping) {
        emit_error(app, "", "Native audio encoder stopped accepting PCM", true);
        queue_terminal_stop(app);
        return;
      }
    }
    pending.erase(pending.begin(), pending.begin() + aligned);
  }
}

int probe() {
#ifdef G_OS_WIN32
  const bool capture = factory_exists("d3d11screencapturesrc");
#else
  const bool x11Capture = factory_exists("ximagesrc");
  const bool pipewireCapture = factory_exists("pipewiresrc");
  const bool capture = x11Capture || pipewireCapture;
#endif
  const bool transport = factory_exists("webrtcbin") && factory_exists("nicesrc") &&
      factory_exists("nicesink") && factory_exists("dtlsenc") &&
      factory_exists("srtpenc");
  const bool audio = factory_exists("appsrc") && factory_exists("audioconvert") &&
      factory_exists("audioresample") && factory_exists("opusenc") &&
      factory_exists("rtpopuspay");
  const std::string h264Encoder = first_available_encoder("H264");
  const std::string av1Encoder = first_available_encoder("AV1");
  const std::string h265Encoder = first_available_encoder("H265");
  const bool encoder = !h264Encoder.empty();
  const bool supported = capture && encoder && transport;
  std::cout << "{\"protocolVersion\":" << kProtocolVersion
            << ",\"supported\":" << (supported ? "true" : "false")
            << ",\"captureBackends\":[";
#ifdef G_OS_WIN32
  if (capture) std::cout << "\"d3d11\"";
#else
  bool hasBackend = false;
  if (x11Capture) {
    std::cout << "\"x11\"";
    hasBackend = true;
  }
  if (pipewireCapture) {
    if (hasBackend) std::cout << ',';
    std::cout << "\"pipewire-portal\"";
  }
#endif
  std::cout << "],\"codecs\":[";
  bool wroteCodec = false;
  const auto writeCodec = [&](const char* name, const std::string& selected) {
    if (selected.empty()) return;
    if (wroteCodec) std::cout << ',';
    wroteCodec = true;
    std::cout << "{\"name\":\"" << name << "\",\"encoder\":\""
              << selected << "\",\"hardware\":true}";
  };
  writeCodec("H264", h264Encoder);
  writeCodec("AV1", av1Encoder);
  writeCodec("H265", h265Encoder);
  std::cout << "]"
            << ",\"audio\":{\"supported\":" << (audio ? "true" : "false")
            << ",\"codec\":\"OPUS\",\"sampleRate\":48000,\"channels\":1}"
            << ",\"components\":{"
            << "\"capture\":" << (capture ? "true" : "false") << ','
            << "\"encoder\":" << (encoder ? "true" : "false") << ','
            << "\"audio\":" << (audio ? "true" : "false") << ','
            << "\"transport\":" << (transport ? "true" : "false") << '}';
  if (!supported) {
    std::cout << ",\"reason\":\"gstreamer-plugins-unavailable\"";
  }
  std::cout << "}" << std::endl;
  return supported ? 0 : 2;
}

}  // namespace

int main(int argc, char** argv) {
  gst_init(&argc, &argv);
  if (argc == 2 && std::string(argv[1]) == "--probe") return probe();

  App* app = new App();
  app->loop = g_main_loop_new(nullptr, FALSE);
  std::thread inputThread(read_commands, app);
  inputThread.detach();
  std::thread audioThread(read_audio, app);
  audioThread.detach();
  g_main_loop_run(app->loop);
  stop_pipeline(app);
  std::_Exit(0);
}

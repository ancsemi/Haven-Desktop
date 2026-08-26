#include <gst/gst.h>
#include <gst/sdp/sdp.h>

#define GST_USE_UNSTABLE_API
#include <gst/webrtc/webrtc.h>

#ifndef G_OS_WIN32
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <unistd.h>
#else
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

constexpr int kProtocolVersion = 2;

struct App;

struct Peer {
  App* app = nullptr;
  std::string id;
  GstElement* queue = nullptr;
  GstElement* capsFilter = nullptr;
  GstElement* webrtc = nullptr;
  GstPad* teePad = nullptr;
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
  std::string icePolicy = "all";
  std::string stunUrl;
  std::vector<TurnServer> turnServers;
};

struct App {
  GMainLoop* loop = nullptr;
  GstElement* pipeline = nullptr;
  GstElement* rtpTee = nullptr;
  guint busWatch = 0;
  std::string sessionId;
  CaptureConfig config;
  std::unordered_map<std::string, std::unique_ptr<Peer>> peers;
  std::vector<std::unique_ptr<Peer>> retiredPeers;
  std::mutex outputMutex;
  bool stopping = false;
  bool starting = false;
  bool cancelStartup = false;
  bool terminalQueued = false;
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
                                 std::string* description,
                                std::string* encoderName,
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
  *encoderName = "mfh264enc";
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
  if (factory_exists("vah264enc")) {
    *encoderName = "vah264enc";
  } else if (factory_exists("vaapih264enc")) {
    *encoderName = "vaapih264enc";
  } else {
    *error = "No VA-API H.264 encoder is available";
    return false;
  }
#endif

  const int bitrateKbps = std::max(250, config.bitrate / 1000);
  const int keyInterval = std::max(1, config.frameRate * 2);
  std::ostringstream pipeline;
  pipeline << source.str()
           << " ! queue max-size-buffers=2 leaky=downstream"
           << " ! videorate drop-only=true";

  if (d3d11) {
    pipeline << " ! d3d11convert ! " << output_caps(config, true)
             << " ! mfh264enc bitrate=" << bitrateKbps
             << " max-bitrate=" << bitrateKbps
             << " rc-mode=cbr low-latency=true bframes=0 gop-size=" << keyInterval;
  } else if (*encoderName == "mfh264enc") {
    pipeline << " ! videoscale add-borders=false ! videoconvert ! "
             << output_caps(config, false)
             << " ! mfh264enc bitrate=" << bitrateKbps
             << " max-bitrate=" << bitrateKbps
             << " rc-mode=cbr low-latency=true bframes=0 gop-size=" << keyInterval;
  } else {
    pipeline << " ! videoscale add-borders=false ! videoconvert ! "
             << output_caps(config, false) << " ! " << *encoderName
             << " bitrate=" << bitrateKbps << " rate-control=cbr";
    if (*encoderName == "vah264enc") {
      pipeline << " target-usage=7 b-frames=0 key-int-max=" << keyInterval;
    } else {
      pipeline << " quality-level=7 max-bframes=0 keyframe-period=" << keyInterval;
    }
  }

  pipeline << " ! video/x-h264,profile=constrained-baseline"
           << " ! h264parse config-interval=-1"
           << " ! rtph264pay pt=96 config-interval=-1 aggregate-mode=zero-latency"
           << " ! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000"
           << " ! tee name=rtptee rtptee. ! queue ! fakesink sync=false";
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
  if (app->terminalQueued || app->stopping) return;
  app->terminalQueued = true;
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
  auto peer = std::make_unique<Peer>();
  peer->app = app;
  peer->id = peerId;
  peer->generation = app->nextPeerGeneration++;
  peer->queue = gst_element_factory_make("queue", nullptr);
  peer->capsFilter = gst_element_factory_make("capsfilter", nullptr);
  peer->webrtc = gst_element_factory_make("webrtcbin", nullptr);
  if (!peer->queue || !peer->capsFilter || !peer->webrtc) {
    *error = "Could not create per-viewer WebRTC elements";
    if (peer->queue) gst_object_unref(peer->queue);
    if (peer->capsFilter) gst_object_unref(peer->capsFilter);
    if (peer->webrtc) gst_object_unref(peer->webrtc);
    return false;
  }

  g_object_set(peer->queue,
               "max-size-buffers", 4,
               "max-size-bytes", 0,
               "max-size-time", static_cast<guint64>(0),
               "leaky", 2,
               nullptr);
  GstCaps* rtpCaps = gst_caps_from_string(
      "application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000");
  g_object_set(peer->capsFilter, "caps", rtpCaps, nullptr);
  gst_caps_unref(rtpCaps);
  configure_ice(peer.get());
  g_signal_connect(peer->webrtc, "on-negotiation-needed",
                   G_CALLBACK(on_negotiation_needed), peer.get());
  g_signal_connect(peer->webrtc, "on-ice-candidate",
                   G_CALLBACK(on_ice_candidate), peer.get());

  gst_bin_add_many(GST_BIN(app->pipeline), peer->queue, peer->capsFilter,
                   peer->webrtc, nullptr);
  if (!gst_element_link_many(peer->queue, peer->capsFilter, peer->webrtc, nullptr)) {
    *error = "Could not link viewer queue to webrtcbin";
    peer->active = false;
    gst_bin_remove_many(GST_BIN(app->pipeline), peer->queue, peer->capsFilter,
                        peer->webrtc, nullptr);
    peer->queue = nullptr;
    peer->capsFilter = nullptr;
    peer->webrtc = nullptr;
    return false;
  }

  peer->teePad = gst_element_request_pad_simple(app->rtpTee, "src_%u");
  GstPad* queueSink = gst_element_get_static_pad(peer->queue, "sink");
  const GstPadLinkReturn linkResult = peer->teePad && queueSink
      ? gst_pad_link(peer->teePad, queueSink)
      : GST_PAD_LINK_REFUSED;
  if (queueSink) gst_object_unref(queueSink);
  if (linkResult != GST_PAD_LINK_OK) {
    *error = "Could not attach viewer to encoded RTP stream";
    peer->active = false;
    if (peer->teePad) {
      gst_element_release_request_pad(app->rtpTee, peer->teePad);
      gst_object_unref(peer->teePad);
      peer->teePad = nullptr;
    }
    gst_element_set_state(peer->queue, GST_STATE_NULL);
    gst_element_set_state(peer->capsFilter, GST_STATE_NULL);
    gst_element_set_state(peer->webrtc, GST_STATE_NULL);
    gst_bin_remove_many(GST_BIN(app->pipeline), peer->queue, peer->capsFilter,
                        peer->webrtc, nullptr);
    peer->queue = nullptr;
    peer->capsFilter = nullptr;
    peer->webrtc = nullptr;
    return false;
  }

  gst_element_sync_state_with_parent(peer->queue);
  gst_element_sync_state_with_parent(peer->capsFilter);
  gst_element_sync_state_with_parent(peer->webrtc);

  GArray* transceivers = nullptr;
  g_signal_emit_by_name(peer->webrtc, "get-transceivers", &transceivers);
  if (transceivers && transceivers->len > 0) {
    auto* transceiver = g_array_index(
        transceivers, GstWebRTCRTPTransceiver*, 0);
    g_object_set(transceiver, "direction",
                 GST_WEBRTC_RTP_TRANSCEIVER_DIRECTION_SENDONLY, nullptr);
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
  if (peer->teePad && peer->queue) {
    gst_pad_set_active(peer->teePad, FALSE);
    GstPad* queueSink = gst_element_get_static_pad(peer->queue, "sink");
    if (queueSink) {
      gst_pad_unlink(peer->teePad, queueSink);
      gst_object_unref(queueSink);
    }
  }
  if (peer->teePad) {
    gst_element_release_request_pad(app->rtpTee, peer->teePad);
    gst_object_unref(peer->teePad);
    peer->teePad = nullptr;
  }
  if (peer->queue) gst_element_set_state(peer->queue, GST_STATE_NULL);
  if (peer->capsFilter) gst_element_set_state(peer->capsFilter, GST_STATE_NULL);
  if (peer->webrtc) gst_element_set_state(peer->webrtc, GST_STATE_NULL);
  if (peer->queue && peer->capsFilter && peer->webrtc) {
    gst_bin_remove_many(GST_BIN(app->pipeline), peer->queue, peer->capsFilter,
                        peer->webrtc, nullptr);
  }
  peer->queue = nullptr;
  peer->capsFilter = nullptr;
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
    gst_element_set_state(app->pipeline, GST_STATE_NULL);
    for (auto& entry : app->peers) {
      Peer* peer = entry.second.get();
      if (peer->teePad) {
        gst_element_release_request_pad(app->rtpTee, peer->teePad);
        gst_object_unref(peer->teePad);
        peer->teePad = nullptr;
      }
      peer->queue = nullptr;
      peer->capsFilter = nullptr;
      peer->webrtc = nullptr;
    }
    gst_object_unref(app->pipeline);
    app->pipeline = nullptr;
    app->rtpTee = nullptr;
  }
  for (auto& entry : app->peers) {
    app->retiredPeers.push_back(std::move(entry.second));
  }
  app->peers.clear();
#ifndef G_OS_WIN32
  close_portal_capture(app);
#endif
}

bool start_pipeline(App* app, const CaptureConfig& config, std::string* error) {
  std::string pipelineDescription;
  std::string encoder;
  if (!build_pipeline_description(app, config, &pipelineDescription, &encoder, error)) {
    return false;
  }
  if (!factory_exists("webrtcbin") || !factory_exists("rtph264pay") ||
      !factory_exists("h264parse") || !factory_exists(encoder.c_str())) {
    *error = "Required GStreamer WebRTC/H.264 plugins are unavailable";
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
  app->rtpTee = gst_bin_get_by_name(GST_BIN(app->pipeline), "rtptee");
  if (!app->rtpTee) {
    *error = "Encoded RTP tee was not created";
    stop_pipeline(app);
    return false;
  }
  gst_object_unref(app->rtpTee);

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
  if (fields.size() != 14 || app->pipeline || !valid_session_id(fields[1])) return;
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
    return;
  }
  config.icePolicy = fields[11] == "relay" ? "relay" : "all";
  config.stunUrl = fields[12];
  config.turnServers = parse_turn_servers(fields[13]);
  app->sessionId = fields[1];
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

int probe() {
#ifdef G_OS_WIN32
  const bool capture = factory_exists("d3d11screencapturesrc");
  const bool encoder = factory_exists("mfh264enc");
  const char* encoderName = "mfh264enc";
#else
  const bool x11Capture = factory_exists("ximagesrc");
  const bool pipewireCapture = factory_exists("pipewiresrc");
  const bool capture = x11Capture || pipewireCapture;
  const bool modernEncoder = factory_exists("vah264enc");
  const bool legacyEncoder = factory_exists("vaapih264enc");
  const bool encoder = modernEncoder || legacyEncoder;
  const char* encoderName = modernEncoder ? "vah264enc" : "vaapih264enc";
#endif
  const bool transport = factory_exists("webrtcbin") &&
      factory_exists("rtph264pay") && factory_exists("h264parse") &&
      factory_exists("nicesrc") && factory_exists("nicesink") &&
      factory_exists("dtlsenc") && factory_exists("srtpenc");
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
  std::cout << "]"
             << ",\"encoder\":\"" << encoderName << "\""
             << ",\"codec\":\"H264\""
             << ",\"components\":{"
             << "\"capture\":" << (capture ? "true" : "false") << ','
             << "\"encoder\":" << (encoder ? "true" : "false") << ','
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
  g_main_loop_run(app->loop);
  stop_pipeline(app);
  std::_Exit(0);
}

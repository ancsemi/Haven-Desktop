{
  "targets": [
    {
      "target_name": "haven_audio",
      "cflags!":    ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources":    ["src/addon.cpp", "src/unsupported_capture.cpp"],
      "include_dirs": [
        "../node_modules/node-addon-api"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/win/wasapi_capture.cpp"],
          "libraries": [
            "-lole32.lib",
            "-lmmdevapi.lib",
            "-luuid.lib",
            "-lAvrt.lib",
            "-lPsapi.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          },
          "defines": ["PLATFORM_WINDOWS"]
        }],
        ["OS=='linux'", {
          "sources": ["src/linux/pulse_capture.cpp"],
          "cflags_cc": [
            "<!@(pkg-config --cflags libpulse libpulse-simple 2>/dev/null || echo '')",
            "-std=c++17",
            "-fexceptions"
          ],
          "libraries": [
            "<!@(pkg-config --libs libpulse libpulse-simple 2>/dev/null || echo '-lpulse -lpulse-simple')"
          ],
          "defines": ["PLATFORM_LINUX"]
        }]
      ]
    },
    {
      "target_name": "haven_screen_share",
      "type": "executable",
      "sources": ["src/screen_share.cpp"],
      "conditions": [
        ["OS=='linux'", {
          "cflags": [
            "<!@(pkg-config --cflags gstreamer-1.0 gstreamer-app-1.0 gstreamer-sdp-1.0 gstreamer-webrtc-1.0 gio-2.0 gio-unix-2.0)"
          ],
          "cflags_cc": ["-std=c++17", "-fexceptions"],
          "libraries": [
            "<!@(pkg-config --libs gstreamer-1.0 gstreamer-app-1.0 gstreamer-sdp-1.0 gstreamer-webrtc-1.0 gio-2.0 gio-unix-2.0)"
          ]
        }],
        ["OS=='win'", {
          "include_dirs": [
            "<(gstreamer_root)/include/gstreamer-1.0",
            "<(gstreamer_root)/include/glib-2.0",
            "<(gstreamer_root)/lib/glib-2.0/include"
          ],
          "libraries": [
            "<(gstreamer_root)/lib/gstreamer-1.0.lib",
            "<(gstreamer_root)/lib/gstapp-1.0.lib",
            "<(gstreamer_root)/lib/gstsdp-1.0.lib",
            "<(gstreamer_root)/lib/gstwebrtc-1.0.lib",
            "<(gstreamer_root)/lib/gobject-2.0.lib",
            "<(gstreamer_root)/lib/glib-2.0.lib",
            "-luser32.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ],
  "variables": {
    "gstreamer_root%": "<!(node -p \"process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64 || process.env.GSTREAMER_ROOT_X86_64 || 'C:/gstreamer/1.0/msvc_x86_64'\")"
  }
}

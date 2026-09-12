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
    }
  ]
}

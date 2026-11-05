require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# kula-llama for iOS. The podspec lives at the module root (not ios/) so the pod can
# compile cpp/core, the C++ shared with the Android JNI. llama.cpp itself is not in git:
# tools/ios-llama.sh fetches the pinned release (tools/llama-src.mjs, b11157) and builds it
# with Metal and RPC into ios/llama/kula_llama_cpp.xcframework (gitignored); CocoaPods runs
# that script here before every `pod install` (prepare_command runs for :path pods too)
# and it is a no-op once the stamp matches.
Pod::Spec.new do |s|
  s.name           = 'KulaLlama'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'kula'
  s.homepage       = 'https://github.com/kurtkurtkurt-del/kula-decentralized-ai'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/kurtkurtkurt-del/kula-decentralized-ai.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.prepare_command = 'sh tools/ios-llama.sh'

  s.source_files = 'ios/**/*.{h,mm,swift}', 'cpp/core/*.{h,cpp}'
  s.public_header_files = 'ios/KulaLlamaBridge.h'
  s.private_header_files = 'cpp/core/kula_core.h'
  s.preserve_paths = 'ios/llama/**/*', 'tools/**/*', 'cpp/**/*'
  s.vendored_frameworks = 'ios/llama/kula_llama_cpp.xcframework'
  s.frameworks = 'Foundation', 'Metal', 'MetalKit', 'Accelerate'
  s.libraries = 'c++'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) KULA_USE_GPU=1',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/cpp/core" "$(PODS_TARGET_SRCROOT)/ios/llama/include"',
    # the metal library is embedded in the static lib (GGML_METAL_EMBED_LIBRARY); nothing to copy
    'OTHER_LDFLAGS' => '$(inherited) -framework Metal -framework MetalKit -framework Accelerate',
  }
end

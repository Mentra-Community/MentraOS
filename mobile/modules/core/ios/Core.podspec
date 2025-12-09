require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'Core'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/fossephate/core' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # External dependencies required by MentraOS native code
  s.dependency 'SWCompression', '~> 4.8.0'
  s.dependency 'SwiftProtobuf', '~> 1.0'
  s.dependency 'onnxruntime-objc', '1.18.0'
  s.dependency 'UltraliteSDK'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'SWIFT_INCLUDE_PATHS' => '$(PODS_TARGET_SRCROOT)/Packages/libbz2'
  }

  # iOS frameworks required by MentraOS
  s.frameworks = 'AVFoundation', 'CoreBluetooth', 'UIKit', 'CoreGraphics'

  # System libraries required by MentraOS
  s.library = 'bz2'

  # Vendored frameworks
  s.vendored_frameworks = 'Packages/SherpaOnnx/sherpa-onnx.xcframework'

  # Resources (model files)
  s.resources = 'Packages/VAD/Silero/Model/*.onnx'

  # Include all Swift, Objective-C, and C/C++ source files
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp,c}"

  # Explicitly mark C++ headers and internal headers as private to prevent exposure in public interface
  s.private_header_files = [
    "Packages/CoreObjC/lc3_cpp.h",
    "Packages/CoreObjC/mdct_neon.h",
    "Packages/CoreObjC/ltpf_neon.h",
    "Packages/SherpaOnnx/sherpa-onnx.xcframework/Headers/sherpa-onnx/c-api/cxx-api.h",
    "Source/Bridging-Header.h"
  ]

  # Exclude problematic patterns
  s.exclude_files = "Source/BridgeModule.{h,m}", "Source/Bridge.m"
end

require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'MentraBluetoothSDK'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = {
    :git => 'https://github.com/Mentra-Community/MentraOS.git',
    :tag => "bluetooth-sdk-v#{s.version}"
  }
  s.static_framework = true

  # External dependencies required by Bluetooth SDK native code
  s.dependency 'ExpoModulesCore'
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

  # iOS frameworks required by Bluetooth SDK
  s.frameworks = 'AVFoundation', 'CoreBluetooth', 'UIKit', 'CoreGraphics'

  # System libraries required by MentraOS
  s.library = 'bz2'

  # Vendored frameworks
  s.vendored_frameworks = 'Packages/SherpaOnnx/sherpa-onnx.xcframework'

  # Resources (model files)
  s.resources = 'Packages/VAD/Silero/Model/*.onnx'
  s.resource_bundles = {
    'BluetoothSDKPrivacy' => ['Source/PrivacyInfo.xcprivacy']
  }

  native_source_files = [
    "Source/**/*.{h,m,mm,swift,hpp,cpp,c}",
    "Packages/CoreObjC/**/*.{h,m,mm,hpp,cpp,c}",
    "Packages/SherpaOnnx/SherpaOnnx.swift",
    "Packages/SherpaOnnx/sherpa-onnx.xcframework/Headers/**/*.{h,hpp}",
    "Packages/VAD/**/*.swift",
    "Packages/libbz2/shim.h",
    "BluetoothSdkModule.swift"
  ]
  s.source_files = native_source_files

  # Explicitly mark C++ headers and internal headers as private to prevent exposure in public interface
  s.private_header_files = [
    "Packages/CoreObjC/lc3_cpp.h",
    "Packages/CoreObjC/mdct_neon.h",
    "Packages/CoreObjC/ltpf_neon.h",
    "Packages/SherpaOnnx/sherpa-onnx.xcframework/Headers/sherpa-onnx/c-api/cxx-api.h",
    "Packages/libbz2/shim.h",
    "Source/Bridging-Header.h"
  ]

  # Exclude legacy Obj-C bridge files.
  s.exclude_files = ["Source/BridgeModule.{h,m}", "Source/Bridge.m"]
end

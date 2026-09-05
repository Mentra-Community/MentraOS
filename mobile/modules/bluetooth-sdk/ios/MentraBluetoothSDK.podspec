require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
include_expo_adapter = ENV['MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER'] == '1'

Pod::Spec.new do |s|
  s.name           = 'MentraBluetoothSDK'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :osx => '13.0'
  }
  s.swift_version  = '5.9'
  s.source         = {
    :git => 'https://github.com/Mentra-Community/MentraOS.git',
    :tag => "bluetooth-sdk-v#{s.version}"
  }
  s.static_framework = true

  # External dependencies required by Bluetooth SDK native code
  s.dependency 'ExpoModulesCore' if include_expo_adapter
  s.ios.dependency 'SWCompression', '~> 4.8.0'
  s.ios.dependency 'SwiftProtobuf', '~> 1.0'
  s.ios.dependency 'onnxruntime-objc', '1.18.0'
  s.ios.dependency 'UltraliteSDK'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'SWIFT_INCLUDE_PATHS' => '$(PODS_TARGET_SRCROOT)/Packages/libbz2'
  }

  # iOS frameworks required by Bluetooth SDK
  ios_frameworks = ['AVFoundation', 'CoreBluetooth', 'UIKit', 'CoreGraphics']
  ios_frameworks << 'Network' if include_expo_adapter
  s.ios.frameworks = ios_frameworks
  s.osx.frameworks = ['AVFoundation', 'CoreBluetooth', 'CoreAudio', 'AudioToolbox', 'ImageIO', 'JavaScriptCore', 'Network']

  # System libraries required by MentraOS
  s.ios.library = 'bz2'

  # Vendored frameworks
  s.ios.vendored_frameworks = 'Packages/SherpaOnnx/sherpa-onnx.xcframework'

  s.resource_bundles = {
    'BluetoothSDKPrivacy' => ['Source/PrivacyInfo.xcprivacy']
  }

  native_source_files = [
    "Source/**/*.{h,m,mm,swift,hpp,cpp,c}",
    "Packages/CoreObjC/**/*.{h,m,mm,hpp,cpp,c}",
    "Packages/SherpaOnnx/SherpaOnnx.swift",
    "Packages/SherpaOnnx/sherpa-onnx.xcframework/ios-arm64/Headers/**/*.{h,hpp}",
    "Packages/VAD/**/*.swift",
    "Packages/SherpaOnnx/sherpa-onnx.xcframework/Headers/**/*.{h,hpp}",
    "Packages/libbz2/shim.h"
  ]
  adapter_source_files = [
    "BluetoothSdkModule.swift",
    "LocalPhotoUploadServer.swift",
    "MentraPhotoReceiverModule.swift",
    "LocalIPv4.swift",
    "LocalOtaServer.swift",
    "BackgroundOtaArtifactDownloader.swift",
    "MentraOtaServerModule.swift"
  ]
  native_source_files.concat(adapter_source_files) if include_expo_adapter
  s.ios.source_files = native_source_files
  s.osx.source_files = [
    'Source/**/*.{h,m,mm,swift,hpp,cpp,c}',
    'Packages/CoreObjC/**/*.{h,m,mm,hpp,cpp,c}'
  ] + (include_expo_adapter ? adapter_source_files : [])
  s.osx.exclude_files = [
    'Source/Bridging-Header.h',
    'Source/sgcs/Mach1.swift',
    'Source/sgcs/MentraNex.swift',
    'Source/sgcs/mentraos_ble.pb.swift',
    'Source/stt/**/*',
    'Source/tts/**/*',
    'Source/utils/TarBz2Extractor.swift',
    'Source/BridgeModule.{h,m}',
    'Source/Bridge.m'
  ]

  # Explicitly mark C++ headers and internal headers as private to prevent exposure in public interface
  s.private_header_files = [
    "Packages/CoreObjC/lc3_cpp.h",
    "Packages/CoreObjC/mdct_neon.h",
    "Packages/CoreObjC/ltpf_neon.h",
    "Packages/SherpaOnnx/sherpa-onnx.xcframework/ios-arm64/Headers/sherpa-onnx/c-api/cxx-api.h",
    "Packages/libbz2/shim.h",
    "Source/Bridging-Header.h"
  ]

  # Exclude legacy Obj-C bridge files.
  s.exclude_files = ["Source/BridgeModule.{h,m}", "Source/Bridge.m"]
end

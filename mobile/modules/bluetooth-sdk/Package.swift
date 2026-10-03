// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "MentraBluetoothSDK",
  platforms: [
    .iOS("15.1"),
    .macOS(.v13)
  ],
  products: [
    .library(
      name: "MentraBluetoothSDK",
      targets: ["MentraBluetoothSDK"]
    )
  ],
  targets: [
    .target(
      name: "MentraBluetoothSDK",
      dependencies: [
        "MentraBluetoothSDKCoreObjC"
      ],
      path: "ios/Source",
      exclude: [
        "Bridging-Header.h",
        "sgcs/Mach1.swift",
        "sgcs/MentraNex.swift",
        "sgcs/mentraos_ble.pb.swift",
        "stt",
        "tts",
        "utils/TarBz2Extractor.swift",
      ],
      resources: [
        .process("PrivacyInfo.xcprivacy")
      ]
    ),
    .target(
      name: "MentraBluetoothSDKCoreObjC",
      path: "ios/Packages/CoreObjC",
      exclude: [
        "CoreObjC.xcodeproj",
        "makefile.mk",
        "meson.build",
      ],
      publicHeadersPath: "include",
      cSettings: [
        .headerSearchPath(".")
      ]
    ),
    .testTarget(
      name: "MentraBluetoothSDKTests",
      dependencies: ["MentraBluetoothSDK"],
      path: "ios/Tests"
    )
  ]
)

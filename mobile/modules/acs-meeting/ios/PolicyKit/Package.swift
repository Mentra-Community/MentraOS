// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "AcsAudioPolicyKit",
  platforms: [
    .macOS(.v13),
    .iOS(.v15),
  ],
  products: [
    .library(name: "AcsAudioPolicy", targets: ["AcsAudioPolicy"]),
  ],
  targets: [
    .target(name: "AcsAudioPolicy"),
    .testTarget(name: "AcsAudioPolicyTests", dependencies: ["AcsAudioPolicy"]),
  ]
)

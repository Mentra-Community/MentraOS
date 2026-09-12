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
  dependencies: [.package(path: "../../../glasses-media/ios/CoreKit")],
  targets: [
    .target(name: "AcsAudioPolicy", dependencies: [.product(name: "GlassesMediaCore", package: "CoreKit")]),
    .testTarget(name: "AcsAudioPolicyTests", dependencies: ["AcsAudioPolicy"]),
  ]
)

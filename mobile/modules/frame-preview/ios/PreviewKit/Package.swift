// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "FramePreviewCore", platforms: [.macOS(.v13), .iOS(.v15)],
  products: [.library(name: "FramePreviewCore", targets: ["FramePreviewCore"])],
  targets: [
    .target(name: "FramePreviewCore"),
    .testTarget(name: "FramePreviewCoreTests", dependencies: ["FramePreviewCore"]),
  ]
)

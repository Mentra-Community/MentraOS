// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GlassesMediaCore", platforms: [.macOS(.v13), .iOS(.v15)],
    products: [.library(name: "GlassesMediaCore", targets: ["GlassesMediaCore"])],
    targets: [.target(name: "GlassesMediaCore"), .testTarget(name: "GlassesMediaCoreTests", dependencies: ["GlassesMediaCore"])]
)

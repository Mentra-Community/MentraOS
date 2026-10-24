// swift-tools-version: 5.9
import PackageDescription

// The Crust pod compiles Sources/MiniappPolicy into its own module; this package
// exists so the rules can be unit tested on a Mac with `swift test`.
let package = Package(
  name: "MiniappPolicyKit", platforms: [.macOS(.v13), .iOS(.v15)],
  products: [.library(name: "MiniappPolicy", targets: ["MiniappPolicy"])],
  targets: [
    .target(name: "MiniappPolicy"),
    .testTarget(name: "MiniappPolicyTests", dependencies: ["MiniappPolicy"]),
  ]
)

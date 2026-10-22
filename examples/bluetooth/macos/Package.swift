// swift-tools-version: 5.9
import PackageDescription

// Builds against the Bluetooth SDK source in this MentraOS checkout. The
// standalone Starter Kit pins the published SwiftPM package instead.
let package = Package(
    name: "MentraMacExample",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(name: "MentraBluetoothSDK", path: "../../../mobile/modules/bluetooth-sdk"),
    ],
    targets: [.executableTarget(name: "MentraMacExample", dependencies: [
        .product(name: "MentraBluetoothSDK", package: "MentraBluetoothSDK"),
    ])]
)

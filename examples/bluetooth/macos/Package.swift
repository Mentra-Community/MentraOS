// swift-tools-version: 5.9
import Foundation
import PackageDescription

let sdkVersion = "3.2.0-dev.127"
let sdk: Package.Dependency
let sdkIdentity: String
if let localPath = ProcessInfo.processInfo.environment["MENTRA_BLUETOOTH_SDK_PACKAGE_PATH"] {
    sdk = .package(path: localPath)
    sdkIdentity = URL(fileURLWithPath: localPath).lastPathComponent.lowercased()
} else {
    sdk = .package(url: "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git", exact: Version(sdkVersion)!)
    sdkIdentity = "mentra-bluetooth-sdk-ios"
}

let package = Package(
    name: "MentraMacExample",
    platforms: [.macOS(.v13)],
    dependencies: [sdk],
    targets: [.executableTarget(name: "MentraMacExample", dependencies: [
        .product(name: "MentraBluetoothSDK", package: sdkIdentity),
    ])]
)

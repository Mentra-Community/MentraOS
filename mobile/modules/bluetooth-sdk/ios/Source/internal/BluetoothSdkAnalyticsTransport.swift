import Foundation

/// Process-wide owner of analytics delivery: one serial queue and one retry file
/// for the whole process. Connection tracking stays per SDK instance, but two
/// instances can overlap briefly when the SDK is recreated, and if each owned its
/// own queue a drain started by the old instance could rewrite the retry file over
/// an event the new instance had just persisted. A single serial queue serializes
/// every read-modify-write of that file.
enum BluetoothSdkAnalyticsTransport {
    static let queue = DispatchQueue(label: "com.mentra.bluetoothsdk.analytics.transport")
    static let retryQueue: BluetoothSdkAnalyticsQueue? =
        BluetoothSdkAnalyticsQueue.defaultFileURL().map { BluetoothSdkAnalyticsQueue(fileURL: $0) }
}

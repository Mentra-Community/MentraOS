import AVFoundation
import CoreBluetooth
import CoreLocation
import Foundation

@main
enum PermissionStatusReceiptTests {
    static func main() throws {
        // Exercise mappings and file publication without observing this test
        // process's OS grants or opening any consent prompt.
        precondition(PermissionStatusReceipt.location(.notDetermined) == ["rawStatus": "notDetermined", "status": "denied"])
        precondition(PermissionStatusReceipt.location(.denied)["status"] == "blocked")
        precondition(PermissionStatusReceipt.location(.restricted)["status"] == "unavailable")
        precondition(PermissionStatusReceipt.location(CLAuthorizationStatus(rawValue: 4)!)["status"] == "granted")
        precondition(PermissionStatusReceipt.location(.authorizedAlways)["status"] == "granted")
        precondition(PermissionStatusReceipt.capture(.notDetermined)["status"] == "denied")
        precondition(PermissionStatusReceipt.capture(.denied)["status"] == "blocked")
        precondition(PermissionStatusReceipt.capture(.restricted)["status"] == "unavailable")
        precondition(PermissionStatusReceipt.capture(.authorized)["status"] == "granted")
        precondition(PermissionStatusReceipt.bluetooth(.notDetermined)["status"] == "denied")
        precondition(PermissionStatusReceipt.bluetooth(.denied)["status"] == "blocked")
        precondition(PermissionStatusReceipt.bluetooth(.restricted)["status"] == "unavailable")
        precondition(PermissionStatusReceipt.bluetooth(.allowedAlways)["status"] == "granted")

        for invalid in ["", "read-1\n", "../outside", String(repeating: "x", count: 161)] {
            do {
                _ = try PermissionStatusReceipt.correlate([:], requestId: invalid)
                preconditionFailure("Accepted invalid permission request ID")
            } catch {}
        }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent(PermissionStatusReceipt.relativePath)
        let first = try PermissionStatusReceipt.correlate(["observedAt": "first", "locationServicesEnabled": false], requestId: "read-1")
        try PermissionStatusReceipt.write(first, to: path)
        let second = try PermissionStatusReceipt.correlate(["observedAt": "second", "locationServicesEnabled": true], requestId: "read-2")
        try PermissionStatusReceipt.write(second, to: path)
        let stored = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
        precondition(stored["requestId"] as? String == "read-2")
        precondition(stored["observedAt"] as? String == "second")
        precondition(stored["locationServicesEnabled"] as? Bool == true)
        let files = try FileManager.default.contentsOfDirectory(atPath: path.deletingLastPathComponent().path)
        precondition(files == ["permission-status.json"])
        let mode = try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as! NSNumber
        precondition(mode.intValue == 0o600)
        print("Permission status mappings and atomic correlated replacement passed")
    }
}

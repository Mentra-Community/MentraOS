import Foundation

/// Which manufacturing serial to publish for a G2 connection.
///
/// A fresh pairing decodes the serial from the advertisement during the scan. A
/// cached reconnect (UUID based, after a process restart) skips the scan, so the
/// only serial the SDK still holds is the one it persisted as the device name at
/// the previous auth completion. That persisted value is reused only when it is
/// exactly the id this connection was asked for: the search id can be a partial
/// string typed by a host, and a partial must never be reported as a serial.
enum G2SerialResolution {
    private static let unset = "NOT_SET"

    static func resolve(scannedSerial: String?, requestedId: String, persistedDeviceName: String) -> String? {
        if let scanned = scannedSerial?.trimmingCharacters(in: .whitespacesAndNewlines), !scanned.isEmpty {
            return scanned
        }
        let persisted = persistedDeviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        let requested = requestedId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !persisted.isEmpty, persisted != unset, persisted == requested else { return nil }
        return persisted
    }
}

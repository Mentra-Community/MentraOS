import Foundation

/// Keeps the advertising serial across process restarts. The short G1 pairing
/// number is not globally unique: a cached identity must also match the exact
/// CoreBluetooth peripheral. The UUID stays local and is never the serial.
struct G1SerialIdentity {
    private let defaults: UserDefaults
    private let key = "g1ManufacturingSerial"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func remember(serial: String, peripheralID: UUID, searchID: String) {
        guard Self.isValidSerial(serial), Self.isSelected(searchID) else { return }
        defaults.set([
            "serial": serial,
            "peripheralID": peripheralID.uuidString,
            "searchID": searchID,
        ], forKey: key)
    }

    func resolve(peripheralID: UUID, searchID: String) -> String? {
        guard Self.isSelected(searchID),
              let saved = defaults.dictionary(forKey: key) as? [String: String],
              saved["peripheralID"] == peripheralID.uuidString,
              saved["searchID"] == searchID,
              let serial = saved["serial"], Self.isValidSerial(serial)
        else { return nil }
        return serial
    }

    func forget() {
        defaults.removeObject(forKey: key)
    }

    static func decodeManufacturerData(_ data: Data) -> String? {
        guard data.count >= 10 else { return nil }
        let ascii = data.prefix { $0 != 0 }.filter { $0 >= 0x20 && $0 <= 0x7E }
        let serial = String(bytes: ascii, encoding: .ascii)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return isValidSerial(serial) ? serial : nil
    }

    private static func isValidSerial(_ serial: String) -> Bool {
        serial.count >= 12 && (serial.hasPrefix("S1") || serial.hasPrefix("100") || serial.hasPrefix("110"))
    }

    private static func isSelected(_ searchID: String) -> Bool {
        !searchID.isEmpty && searchID != "NOT_SET"
    }
}

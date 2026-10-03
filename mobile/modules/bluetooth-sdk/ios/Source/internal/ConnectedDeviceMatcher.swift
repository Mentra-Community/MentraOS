import Foundation

/// Model-level identity heuristic for system-connected peripherals, not app ownership.
enum ConnectedDeviceMatcher {
    static func matches(model: DeviceModel, defaultDevice: Device?, name: String?, identifier: String?) -> Bool {
        guard model != .simulated else { return false }
        if let saved = defaultDevice, saved.model == model {
            let savedID = saved.identifier.flatMap { $0.isEmpty ? nil : $0 }
            let candidateID = identifier.flatMap { $0.isEmpty ? nil : $0 }
            if let savedID, let candidateID {
                if savedID.caseInsensitiveCompare(candidateID) == .orderedSame { return true }
            } else if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name == saved.name {
                return true
            }
        }
        guard let name else { return false }
        switch model {
        case .mentraLive:
            return name == "Xy_A" || name.hasPrefix("XyBLE_") || name.lowercased().hasPrefix("mentra_live")
        case .mentraNex:
            return name.hasPrefix("Nex1-") || name.hasPrefix("MENTRA_DISPLAY_")
        default:
            return false
        }
    }

    /// Service IDs used by the corresponding SGCs. CoreBluetooth cannot enumerate
    /// every system connection without service filters; unsupported models stay silent.
    static func serviceUUIDs(for model: DeviceModel) -> [String] {
        switch model {
        case .mentraLive, .mentraNex:
            return ["00004860-0000-1000-8000-00805F9B34FB"]
        case .g1:
            return ["6E400001-B5A3-F393-E0A9-E50E24DCCA9E"]
        case .g2:
            return ["00002760-08C2-11E1-9073-0E8AC72E0000"]
        case .nimo:
            return ["00007033-0000-1000-8000-00805F9B34FB"]
        case .ar99:
            return ["A72EC9A8-CF72-8544-AD96-D1481A02CE98"]
        default:
            return []
        }
    }
}

import Foundation

enum NexConnectionTarget {
    static func shouldConnect(
        name: String, target: String?, discoveryOnly: Bool,
        savedName: String?, preferredID: String?, discoveredID: String?
    ) -> Bool {
        guard !discoveryOnly else { return false }
        // An explicit selection is authoritative even when it does not match.
        // Saved-device fallbacks are only for reconnecting without a selection.
        if let target { return !target.isEmpty && name == target }
        if let savedName, !savedName.isEmpty, name == savedName { return true }
        return preferredID != nil && preferredID == discoveredID
    }
}

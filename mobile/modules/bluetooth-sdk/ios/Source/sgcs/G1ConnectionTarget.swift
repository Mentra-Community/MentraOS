import Foundation

enum G1ConnectionTarget {
    /// A legacy UUID needs a matching peripheral name; newly recorded UUIDs can
    /// also reconnect without a name because their search ID was saved with them.
    static func matchesCachedPeripheral(name: String?, searchID: String, cachedSearchID: String?) -> Bool {
        guard searchID != "NOT_SET", searchID.count > 2 else { return false }
        if let name, !name.isEmpty {
            return name.contains("G1" + searchID)
        }
        return cachedSearchID == searchID
    }
}

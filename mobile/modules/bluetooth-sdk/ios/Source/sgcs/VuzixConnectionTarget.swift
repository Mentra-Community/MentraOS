import Foundation

enum VuzixConnectionTarget {
    static func identifier(_ name: String) -> String {
        guard let start = name.lastIndex(of: "["),
              let end = name[start...].firstIndex(of: "]")
        else { return name }
        return String(name[name.index(after: start) ..< end])
    }

    static func matches(name: String?, target: String) -> Bool {
        guard let name, !target.isEmpty else { return false }
        return identifier(name) == identifier(target)
    }
}

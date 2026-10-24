import Foundation

/// The real location of a path, for checking that a path a miniapp names stays inside the
/// directory the host allows: absolute, with `.`, `..` and every symlink resolved.
public enum CanonicalFilePath {
    /// The canonical path of an existing file or directory, or nil when there is none.
    public static func of(_ path: String) -> String? {
        guard path.hasPrefix("/"), !path.contains("\u{0}") else { return nil }
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

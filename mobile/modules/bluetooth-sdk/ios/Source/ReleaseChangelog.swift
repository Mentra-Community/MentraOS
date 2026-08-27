import Foundation

/// One coordinated Mentra release note authored in /changelogs/<version>.md.
public struct ReleaseChangelog: Equatable, Sendable {
    public let version: String
    public let markdown: String

    public init(version: String, markdown: String) {
        self.version = version
        self.markdown = markdown
    }
}

enum ReleaseChangelogCatalog {
    static func select(fromVersion: String?, toVersion: String?) throws -> [ReleaseChangelog] {
        let fallbackTarget = GeneratedReleaseMetadata.familyBaseVersion.isEmpty
            ? (generatedReleaseChangelogs.first?.version ?? "")
            : GeneratedReleaseMetadata.familyBaseVersion
        if fallbackTarget.isEmpty, toVersion == nil { return [] }
        let target = try baseVersion(toVersion ?? fallbackTarget, label: "toVersion")
        guard generatedReleaseChangelogs.contains(where: { $0.version == target }) else {
            throw BluetoothSdkError(code: "missing_changelog", message: "No changelog is bundled for target version \(target).")
        }
        guard let fromVersion else {
            return generatedReleaseChangelogs.filter { $0.version == target }
        }

        let source = try baseVersion(fromVersion, label: "fromVersion")
        let direction = compareVersions(target, source)
        return generatedReleaseChangelogs.filter { entry in
            if direction == 0 { return entry.version == target }
            if direction > 0 {
                return compareVersions(entry.version, source) > 0 && compareVersions(entry.version, target) <= 0
            }
            return compareVersions(entry.version, source) < 0 && compareVersions(entry.version, target) >= 0
        }
    }

    private static func baseVersion(_ version: String, label: String) throws -> String {
        let value = version.trimmingCharacters(in: .whitespacesAndNewlines)
        let suffixStart = value.firstIndex(where: { $0 == "-" || $0 == "+" }) ?? value.endIndex
        let components = value[..<suffixStart].split(separator: ".", omittingEmptySubsequences: false)
        let isValid = components.count == 3 && components.allSatisfy { component in
            !component.isEmpty
                && (component == "0" || !component.hasPrefix("0"))
                && component.utf8.allSatisfy { byte in byte >= 48 && byte <= 57 }
        }
        guard isValid else {
            throw BluetoothSdkError(
                code: "invalid_changelog_version",
                message: "\(label) must be a semantic version such as 3.1.0, 3.1.0-dev.4, or 3.1.0-beta.2."
            )
        }
        return components.joined(separator: ".")
    }

    private static func compareVersions(_ left: String, _ right: String) -> Int {
        let a = left.split(separator: ".").map { Int($0) ?? 0 }
        let b = right.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0 ..< 3 where a[index] != b[index] {
            return a[index] - b[index]
        }
        return 0
    }
}

import CryptoKit
import Darwin
import Foundation

enum InstallerError: LocalizedError {
    case invalid(String)
    case recovery(String)

    var errorDescription: String? {
        switch self {
        case let .invalid(message), let .recovery(message): message
        }
    }
}

struct BuildManifest {
    static let bundleID = "com.mentra.mentra"
    static let teamID = "T5XXXL6N36"
    let data: Data
    let pr: Int
    let headSHA: String
    let version: String
    let build: String
    let executableSHA256: String
    let javascriptSHA256: String
    let profileUUID: String
    let profileExpires: Date
    let packageVersion: Int

    init(data: Data, expected: Data? = nil) throws {
        if let expected, data != expected {
            throw InstallerError.invalid("This folder belongs to a different build. Choose the folder containing this Install Mentra app and its original build.json.")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Self.supportedPackage(json),
              json["app"] as? String == "Mentra.app",
              json["bundleId"] as? String == Self.bundleID,
              json["teamId"] as? String == Self.teamID,
              json["archivePath"] == nil,
              let pr = json["pr"] as? Int, pr > 0,
              let head = json["headSha"] as? String, Self.hex(head, length: 40),
              let version = json["version"] as? String, !version.isEmpty,
              let build = json["build"] as? String, !build.isEmpty,
              let executable = json["executableSha256"] as? String, Self.hex(executable, length: 64),
              let javascript = json["javascriptSha256"] as? String, Self.hex(javascript, length: 64),
              let profileUUID = json["profileUUID"] as? String, UUID(uuidString: profileUUID) != nil,
              let expiration = json["profileExpires"] as? String,
              let profileExpires = Self.date(expiration)
        else { throw InstallerError.invalid("The package does not contain a valid Mentra Mac build manifest. Download a fresh Mac ZIP from #pr-builds.") }
        self.data = data
        self.pr = pr
        headSHA = head
        self.version = version
        self.build = build
        executableSHA256 = executable
        javascriptSHA256 = javascript
        self.profileUUID = profileUUID
        self.profileExpires = profileExpires
        packageVersion = json["macPackageVersion"] as? Int ?? 1
    }

    var summary: String {
        "PR #\(pr) · \(headSHA.prefix(8))\nMentra \(version) (\(build))"
    }

    private static func hex(_ value: String, length: Int) -> Bool {
        value.count == length && value.allSatisfy { "0123456789abcdef".contains($0) }
    }

    private static func supportedPackage(_ json: [String: Any]) -> Bool {
        switch json["macPackageVersion"] as? Int ?? 1 {
        case 1:
            // Existing CDN packages remain usable. Only their signed iOS app
            // is installed; the legacy script and ad hoc launcher never run.
            return json["macInstaller"] == nil
                && json["launcherPath"] as? String == "launch-ios-on-mac"
                && (json["launcherSha256"] as? String).map { hex($0, length: 64) } == true
        case 2:
            return json["macInstaller"] as? String == "Install Mentra.app"
                && json["launcherPath"] == nil && json["launcherSha256"] == nil
        default: return false
        }
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: value) ?? formatter.date(from: value + "Z")
    }
}

struct VerifiedBuild {
    let directory: URL
    let manifest: BuildManifest
    let codeRequirement: String
}

enum InstallerFiles {
    static let manager = FileManager.default
    static let owner = "mentra-ios-mac-v1"

    static func exists(_ url: URL) -> Bool {
        var info = stat()
        return lstat(url.path, &info) == 0
    }

    /// Check every path component rather than resolving an unexpected link into
    /// another user's installation or a different downloaded package.
    static func requirePath(_ url: URL, directory: Bool) throws {
        // URL.standardizedFileURL rewrites /private/var to the /var symlink on
        // macOS, so inspect the original lexical components instead.
        let normalized = url
        guard url.path.hasPrefix("/"), !url.pathComponents.contains(".."), !url.pathComponents.contains(".") else {
            throw InstallerError.invalid("Expected an absolute path without traversal: \(url.path)")
        }
        var current = URL(fileURLWithPath: "/", isDirectory: true)
        for component in normalized.pathComponents.dropFirst() {
            current.appendPathComponent(component)
            var info = stat()
            guard lstat(current.path, &info) == 0 else { throw InstallerError.invalid("Cannot read \(current.path).") }
            let isDirectory = (info.st_mode & S_IFMT) == S_IFDIR
            let isFile = (info.st_mode & S_IFMT) == S_IFREG && info.st_nlink == 1
            let last = current.path == normalized.path
            guard last ? (directory ? isDirectory : isFile) : isDirectory else {
                throw InstallerError.invalid("Refusing a symlink, linked file, or unexpected file type: \(current.path)")
            }
        }
    }

    static func requirePlainTree(_ root: URL) throws {
        try requirePath(root, directory: true)
        var enumerationError: Error?
        guard let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: nil,
                                                  errorHandler: { _, error in enumerationError = error; return false })
        else { throw InstallerError.invalid("Cannot inspect \(root.path).") }
        while let entry = enumerator.nextObject() as? URL {
            var info = stat()
            guard lstat(entry.path, &info) == 0 else { throw InstallerError.invalid("Cannot inspect \(entry.path).") }
            let kind = info.st_mode & S_IFMT
            guard kind == S_IFDIR || (kind == S_IFREG && info.st_nlink == 1) else {
                throw InstallerError.invalid("The app contains an unexpected link or special file: \(entry.path)")
            }
        }
        if let enumerationError { throw enumerationError }
    }

    static func read(_ url: URL) throws -> Data {
        try requirePath(url, directory: false)
        return try Data(contentsOf: url)
    }

    static func hash(_ file: URL) throws -> String {
        try requirePath(file, directory: false)
        let stream = try FileHandle(forReadingFrom: file)
        defer { try? stream.close() }
        var digest = SHA256()
        while let chunk = try stream.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            digest.update(data: chunk)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func dictionary(_ data: Data) throws -> [String: Any] {
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw InstallerError.invalid("Expected a JSON object.")
        }
        return result
    }

    static func writeJSON(_ value: [String: Any], to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .withoutOverwriting)
    }

    static func claim(_ root: URL, owner: String = InstallerFiles.owner, bundleID: String = BuildManifest.bundleID) throws {
        let applications = root.deletingLastPathComponent()
        try requirePath(applications.deletingLastPathComponent(), directory: true)
        if !exists(applications) { try manager.createDirectory(at: applications, withIntermediateDirectories: false) }
        try requirePath(applications, directory: true)
        if !exists(root) {
            try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try writeJSON(["owner": owner, "bundleId": bundleID], to: root.appendingPathComponent("owner.json"))
        }
        try requirePath(root, directory: true)
        let attributes = try manager.attributesOfItem(atPath: root.path)
        guard (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o022 == 0
        else {
            throw InstallerError.invalid("The managed installation must belong to you and must not be writable by other users.")
        }
        let marker = try dictionary(read(root.appendingPathComponent("owner.json")))
        guard marker["owner"] as? String == owner, marker["bundleId"] as? String == bundleID else {
            throw InstallerError.invalid("This installation directory is not owned by the Mentra installer: \(root.path)")
        }
    }

    static func move(_ from: URL, _ to: URL) throws {
        if rename(from.path, to.path) != 0 { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    /// The old manifest remains untouched until the new app is promoted. Keep
    /// the lock and both generations if rollback itself fails; never guess at
    /// recovery by deleting or force-replacing a partially installed app.
    static func commit(root: URL, staging: URL, lock: URL,
                       move: (URL, URL) throws -> Void = InstallerFiles.move) throws
    {
        let destination = root.appendingPathComponent("Mentra.app")
        let wrapper = staging.appendingPathComponent("Mentra.app")
        let previous = lock.appendingPathComponent("previous.app")
        for directory in [root, staging, lock, wrapper] {
            try requirePath(directory, directory: true)
        }
        guard staging.deletingLastPathComponent().path == root.path, lock.deletingLastPathComponent().path == root.path,
              !exists(previous)
        else { throw InstallerError.invalid("Invalid installation staging or retained recovery directory.") }
        try requirePath(staging.appendingPathComponent("installed-build.json"), directory: false)
        if exists(destination) { try requirePath(destination, directory: true) }
        if exists(root.appendingPathComponent("installed-build.json")) {
            try requirePath(root.appendingPathComponent("installed-build.json"), directory: false)
        }
        var movedPrevious = false
        var movedNew = false
        do {
            if exists(destination) {
                try move(destination, previous)
                movedPrevious = true
            }
            try move(wrapper, destination)
            movedNew = true
            try move(staging.appendingPathComponent("installed-build.json"), root.appendingPathComponent("installed-build.json"))
        } catch {
            let original = error
            do {
                if movedNew { try move(destination, wrapper) }
                if movedPrevious { try move(previous, destination) }
            } catch {
                throw InstallerError.recovery("Installation failed and rollback could not finish. Recovery files are retained in \(lock.path) and \(staging.path). Do not remove them. \(original.localizedDescription); rollback: \(error.localizedDescription)")
            }
            throw original
        }
    }
}

/// Only fixed macOS tools are invoked, never a program supplied by a download.
/// Capture into a private temporary file so a full pipe cannot deadlock a tool.
@discardableResult
func tool(_ executable: String, _ arguments: [String], timeout: TimeInterval = 120) throws -> Data {
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("mentra-installer-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: temporary) }
    let output = temporary.appendingPathComponent("output")
    FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
    let handle = try FileHandle(forWritingTo: output)
    defer { try? handle.close() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = handle
    process.standardError = handle
    process.standardInput = FileHandle.nullDevice
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    try process.run()
    guard finished.wait(timeout: .now() + timeout) == .success else {
        process.terminate()
        guard finished.wait(timeout: .now() + 5) == .success else {
            throw InstallerError.recovery("The installer tool \(URL(fileURLWithPath: executable).lastPathComponent) has not stopped. Recovery files have been retained; wait for the tool to exit before recovering the installation.")
        }
        throw InstallerError.invalid("\(URL(fileURLWithPath: executable).lastPathComponent) did not finish in time. No app was force-quit.")
    }
    let data = try Data(contentsOf: output)
    guard process.terminationStatus == 0 else {
        throw InstallerError.invalid("\(URL(fileURLWithPath: executable).lastPathComponent) failed: \(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    return data
}

func validateProfile(_ profile: [String: Any], manifest: BuildManifest, deviceID: String, now: Date = Date()) throws {
    guard let expiration = profile["ExpirationDate"] as? Date, expiration > now else {
        throw InstallerError.invalid("This app's provisioning profile has expired. Download a fresh PR build.")
    }
    let entitlements = profile["Entitlements"] as? [String: Any]
    guard profile["UUID"] as? String == manifest.profileUUID,
          abs(expiration.timeIntervalSince(manifest.profileExpires)) < 1,
          profile["TeamIdentifier"] as? [String] == [BuildManifest.teamID],
          profile["ProvisionsAllDevices"] as? Bool != true,
          entitlements?["application-identifier"] as? String == "\(BuildManifest.teamID).\(BuildManifest.bundleID)",
          entitlements?["get-task-allow"] as? Bool == false
    else { throw InstallerError.invalid("The app's provisioning profile does not match this Mentra build.") }
    guard !deviceID.isEmpty, (profile["ProvisionedDevices"] as? [String])?.contains(deviceID) == true else {
        throw InstallerError.invalid("This Mac is not registered for this build. Ask the release maintainer to register provisioning UDID \(deviceID.isEmpty ? "(unavailable)" : deviceID) and publish a fresh Mac ZIP.")
    }
}

func verifySignedApp(_ app: URL, manifest: [String: Any]) throws -> String {
    try InstallerFiles.requirePlainTree(app)
    let info = try PropertyListSerialization.propertyList(from: InstallerFiles.read(app.appendingPathComponent("Info.plist")), format: nil) as? [String: Any]
    guard manifest["bundleId"] as? String == BuildManifest.bundleID,
          info?["CFBundleIdentifier"] as? String == BuildManifest.bundleID,
          let executable = info?["CFBundleExecutable"] as? String, !executable.isEmpty,
          executable != ".", executable != "..", !executable.contains("/"),
          info?["CFBundleVersion"] as? String == manifest["build"] as? String,
          info?["CFBundleShortVersionString"] as? String == manifest["version"] as? String,
          (info?["CFBundleSupportedPlatforms"] as? [String])?.contains("iPhoneOS") == true
    else { throw InstallerError.invalid("The app identity or version differs from build.json.") }
    guard try InstallerFiles.hash(app.appendingPathComponent(executable)) == manifest["executableSha256"] as? String,
          try InstallerFiles.hash(app.appendingPathComponent("main.jsbundle")) == manifest["javascriptSha256"] as? String
    else { throw InstallerError.invalid("The app executable or JavaScript does not match this build. Download the Mac ZIP again.") }
    try tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R",
                                   "=identifier \"\(BuildManifest.bundleID)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(BuildManifest.teamID)\"", app.path])
    return try String(decoding: tool("/usr/bin/codesign", ["-dr", "-", app.path]), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

func verifyProvisioning(_ app: URL, manifest: BuildManifest) throws {
    let profileData = try tool("/usr/bin/security", ["cms", "-D", "-i", app.appendingPathComponent("embedded.mobileprovision").path])
    guard let profile = try PropertyListSerialization.propertyList(from: profileData, format: nil) as? [String: Any],
          let hardware = try InstallerFiles.dictionary(tool("/usr/sbin/system_profiler", ["SPHardwareDataType", "-json"]))["SPHardwareDataType"] as? [[String: Any]]
    else { throw InstallerError.invalid("Cannot read this Mac's provisioning identity.") }
    try validateProfile(profile, manifest: manifest, deviceID: hardware.first?["provisioning_UDID"] as? String ?? "")
}

func verifyPackage(_ directory: URL, expected: Data) throws -> VerifiedBuild {
    try InstallerFiles.requirePath(directory, directory: true)
    let manifest = try BuildManifest(data: InstallerFiles.read(directory.appendingPathComponent("build.json")), expected: expected)
    let app = directory.appendingPathComponent("Mentra.app")
    let requirement = try verifySignedApp(app, manifest: InstallerFiles.dictionary(manifest.data))
    try verifyProvisioning(app, manifest: manifest)
    return VerifiedBuild(directory: directory, manifest: manifest, codeRequirement: requirement)
}

/// Same atomic protocol as mobile/scripts/app-ownership.mjs. Installers never
/// reclaim an existing owner; interruption requires explicit recovery.
final class AppOwnershipLease {
    private let path: URL
    private let token = UUID().uuidString
    private var released = false

    init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws {
        let folder = homeDirectory.appendingPathComponent(".cache/mentra-e2e")
        try InstallerFiles.manager.createDirectory(at: folder, withIntermediateDirectories: true)
        try InstallerFiles.requirePath(folder, directory: true)
        path = folder.appendingPathComponent("com.mentra.mentra.lock")
        let guardPath = path.path + ".reclaim"
        guard Darwin.mkdir(guardPath, 0o700) == 0 else {
            throw InstallerError.invalid("Another app owner is acquiring the lock; stop all runs before recovering \(guardPath).")
        }
        defer { Darwin.rmdir(guardPath) }
        let descriptor = Darwin.open(path.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            throw InstallerError.invalid("Mentra is owned by a test or installation. Finish it or recover its retained lease before installing: \(path.path).")
        }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }
        try file.write(contentsOf: JSONSerialization.data(withJSONObject: ["pid": getpid(), "token": token, "retainOnExit": true]))
        try file.synchronize()
    }

    func release() throws {
        guard !released else { return }
        let owner = try InstallerFiles.dictionary(InstallerFiles.read(path))
        if owner["token"] as? String == token, owner["pid"] as? Int == Int(getpid()) {
            try InstallerFiles.manager.removeItem(at: path)
        }
        released = true
    }
}

func withAppOwnership<T>(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
                         operation: () async throws -> T) async throws -> T
{
    let lease = try AppOwnershipLease(homeDirectory: homeDirectory)
    let result: T
    do { result = try await operation() }
    catch {
        if case InstallerError.recovery = error { throw error }
        try lease.release()
        throw error
    }
    try lease.release()
    return result
}

func install(_ verified: VerifiedBuild, homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
             quit: () async throws -> Void, launch: (URL) async throws -> Void = { _ in }) async throws -> URL
{
    try await withAppOwnership(homeDirectory: homeDirectory) {
        try await installOwned(verified, homeDirectory: homeDirectory, quit: quit, launch: launch)
    }
}

private func installOwned(_ verified: VerifiedBuild, homeDirectory: URL,
                          quit: () async throws -> Void, launch: (URL) async throws -> Void) async throws -> URL
{
    let root = homeDirectory.appendingPathComponent("Applications/Mentra E2E")
    try InstallerFiles.claim(root)
    let lock = root.appendingPathComponent(".install-lock")
    do { try InstallerFiles.manager.createDirectory(at: lock, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
    catch { throw InstallerError.invalid("Another installation is running or needs recovery: \(lock.path). Quit the other installer before trying again; retain this folder if an earlier install failed.") }
    let staging = root.appendingPathComponent(".staging-\(UUID().uuidString)")
    func cleanup() throws {
        do {
            if InstallerFiles.exists(staging) { try InstallerFiles.manager.removeItem(at: staging) }
            try InstallerFiles.manager.removeItem(at: lock)
        } catch {
            throw InstallerError.recovery("Installation cleanup failed. Keep the app lease and recovery files at \(lock.path): \(error.localizedDescription)")
        }
    }
    do {
        try InstallerFiles.manager.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let current = try verifyPackage(verified.directory, expected: verified.manifest.data)
        let destination = root.appendingPathComponent("Mentra.app")
        let installedManifest = root.appendingPathComponent("installed-build.json")
        if InstallerFiles.exists(destination) {
            try InstallerFiles.requirePath(destination, directory: true)
            guard try Set(InstallerFiles.manager.contentsOfDirectory(atPath: destination.path)) == ["Wrapper", "WrappedBundle"],
                  try Set(InstallerFiles.manager.contentsOfDirectory(atPath: destination.appendingPathComponent("Wrapper").path)) == ["Mentra.app"]
            else { throw InstallerError.invalid("The installed app wrapper contains unexpected files. Refusing replacement.") }
            let link = destination.appendingPathComponent("WrappedBundle")
            guard try InstallerFiles.manager.destinationOfSymbolicLink(atPath: link.path) == "Wrapper/Mentra.app" else {
                throw InstallerError.invalid("The installed app wrapper has changed. Refusing to replace it.")
            }
            let previousData = try InstallerFiles.read(installedManifest)
            _ = try verifySignedApp(destination.appendingPathComponent("Wrapper/Mentra.app"), manifest: InstallerFiles.dictionary(previousData))
            try previousData.write(to: lock.appendingPathComponent("previous-installed-build.json"), options: .withoutOverwriting)
            let backup = staging.appendingPathComponent("previous-installation.zip")
            try tool("/usr/bin/ditto", ["-c", "-k", "--keepParent", destination.path, backup.path])
            try tool("/usr/bin/unzip", ["-tq", backup.path])
            let saved = root.appendingPathComponent("previous-installation.zip")
            if InstallerFiles.exists(saved) { try InstallerFiles.requirePath(saved, directory: false) }
            try InstallerFiles.move(backup, saved)
        } else if InstallerFiles.exists(installedManifest) {
            throw InstallerError.invalid("The installation manifest exists without its app. Restore the prior installation before continuing.")
        }
        let wrapper = staging.appendingPathComponent("Mentra.app")
        let inner = wrapper.appendingPathComponent("Wrapper/Mentra.app")
        try InstallerFiles.manager.createDirectory(at: inner.deletingLastPathComponent(), withIntermediateDirectories: true)
        try tool("/usr/bin/ditto", [current.directory.appendingPathComponent("Mentra.app").path, inner.path])
        try InstallerFiles.manager.createSymbolicLink(atPath: wrapper.appendingPathComponent("WrappedBundle").path, withDestinationPath: "Wrapper/Mentra.app")
        let requirement = try verifySignedApp(inner, manifest: InstallerFiles.dictionary(current.manifest.data))
        try verifyProvisioning(inner, manifest: current.manifest)
        var installed = try InstallerFiles.dictionary(current.manifest.data)
        installed["codeRequirement"] = requirement
        installed["launchPath"] = destination.path
        installed["installedAt"] = ISO8601DateFormatter().string(from: Date())
        installed["installationLauncher"] = ["source": "native-installer", "bundleId": "com.mentra.mac-installer"]
        try InstallerFiles.writeJSON(installed, to: staging.appendingPathComponent("installed-build.json"))
        try await quit()
        try InstallerFiles.commit(root: root, staging: staging, lock: lock)
        try await launch(destination)
        try cleanup()
        return destination
    } catch {
        if case InstallerError.recovery = error { throw error }
        try cleanup()
        throw error
    }
}

enum InstallerHost {
    static let bundleID = "com.mentra.mac-installer"
    static let owner = "mentra-native-installer-v1"
    static var application: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Install Mentra.app")
    }

    static var state: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Mentra Installer")
    }

    static func verify(_ app: URL) throws -> String {
        try InstallerFiles.requirePlainTree(app)
        let info = try PropertyListSerialization.propertyList(from: InstallerFiles.read(app.appendingPathComponent("Contents/Info.plist")), format: nil) as? [String: Any]
        let types = info?["CFBundleURLTypes"] as? [[String: Any]] ?? []
        guard info?["CFBundleIdentifier"] as? String == bundleID,
              info?["CFBundleExecutable"] as? String == "Installer",
              types.contains(where: { ($0["CFBundleURLSchemes"] as? [String])?.contains("mentra-install") == true })
        else { throw InstallerError.invalid("This is not a Mentra installer with support for PR links.") }
        try tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=identifier \"\(bundleID)\"", app.path])
        return try InstallerFiles.hash(app.appendingPathComponent("Contents/MacOS/Installer"))
    }

    /// A one-time bootstrap retains the already-running, OS-approved installer.
    /// CI requires Developer ID/notarization; this copy preserves its signature.
    /// It also allows an explicitly launched local signed development preview.
    /// Never replace a running helper or execute a helper fetched by a PR link.
    static func retain(_ runningBundle: URL) throws -> URL {
        guard let resolved = realpath(runningBundle.path, nil) else {
            throw InstallerError.invalid("Cannot locate the running installer bundle.")
        }
        let source = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
        free(resolved)
        let sourceHash = try verify(source)
        let destination = application
        let state = state
        try InstallerFiles.claim(state, owner: owner, bundleID: bundleID)
        let metadata = state.appendingPathComponent("installed-helper.json")
        if InstallerFiles.exists(destination) {
            let retained = try InstallerFiles.dictionary(InstallerFiles.read(metadata))
            let installedHash = try verify(destination)
            guard retained["bundleId"] as? String == bundleID,
                  retained["executableSha256"] as? String == installedHash
            else { throw InstallerError.invalid("The permanent Mentra installer does not match its ownership record. Quit it and ask a maintainer to repair the installation.") }
            return destination
        }
        if InstallerFiles.exists(metadata) {
            throw InstallerError.invalid("The permanent installer is missing but its ownership record remains. Ask a maintainer to repair the installation.")
        }
        let applications = destination.deletingLastPathComponent()
        try InstallerFiles.requirePath(applications.deletingLastPathComponent(), directory: true)
        if !InstallerFiles.exists(applications) {
            try FileManager.default.createDirectory(at: applications, withIntermediateDirectories: false)
        }
        try InstallerFiles.requirePath(applications, directory: true)
        let lock = state.appendingPathComponent(".bootstrap-lock")
        do { try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        catch { throw InstallerError.invalid("Another installer bootstrap is running or needs recovery: \(lock.path)") }
        var preserveRecovery = false
        defer { if !preserveRecovery { try? FileManager.default.removeItem(at: lock) } }
        let staged = lock.appendingPathComponent("Install Mentra.app")
        let stagedMetadata = lock.appendingPathComponent("installed-helper.json")
        var moved = false
        do {
            try tool("/usr/bin/ditto", [source.path, staged.path])
            guard try verify(staged) == sourceHash else { throw InstallerError.invalid("The retained installer copy differs from the running app.") }
            try InstallerFiles.writeJSON(["bundleId": bundleID, "executableSha256": sourceHash,
                                          "installedAt": ISO8601DateFormatter().string(from: Date())], to: stagedMetadata)
            guard !InstallerFiles.exists(destination), !InstallerFiles.exists(metadata) else {
                throw InstallerError.invalid("Another installer appeared during setup. Nothing was replaced.")
            }
            try InstallerFiles.move(staged, destination)
            moved = true
            try InstallerFiles.move(stagedMetadata, metadata)
            return destination
        } catch {
            let original = error
            do { if moved { try InstallerFiles.move(destination, staged) } }
            catch {
                preserveRecovery = true
                throw InstallerError.recovery("Installer setup could not roll back. Retain \(lock.path) for recovery: \(error.localizedDescription)")
            }
            if case InstallerError.recovery = original { preserveRecovery = true }
            throw original
        }
    }
}

import Darwin
import Foundation

private struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw TestFailure(description: message) }
}

@discardableResult
private func rejects(_ fragment: String? = nil, _ operation: () throws -> Void) throws -> Error {
    do { try operation() }
    catch {
        if let fragment { try expect(error.localizedDescription.contains(fragment), "Unexpected error: \(error)") }
        return error
    }
    throw TestFailure(description: "Expected the operation to reject")
}

private func manifestJSON() -> [String: Any] {
    ["macPackageVersion": 2, "macInstaller": "Install Mentra.app", "app": "Mentra.app",
     "bundleId": BuildManifest.bundleID, "teamId": BuildManifest.teamID,
     "pr": 123, "headSha": String(repeating: "a", count: 40), "version": "3.2.1", "build": "302015703",
     "executableSha256": String(repeating: "b", count: 64), "javascriptSha256": String(repeating: "c", count: 64),
     "profileUUID": "44260D9B-F260-406F-BAD7-7119EFE321D8", "profileExpires": "2027-05-28T04:05:18"]
}

private func encode(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
}

private func profile(_ manifest: BuildManifest) -> [String: Any] {
    ["ExpirationDate": manifest.profileExpires, "UUID": manifest.profileUUID,
     "TeamIdentifier": [BuildManifest.teamID], "ProvisionedDevices": ["registered-mac"],
     "Entitlements": ["application-identifier": "\(BuildManifest.teamID).\(BuildManifest.bundleID)", "get-task-allow": false]]
}

private struct Fixture {
    let temporary: URL
    let root: URL
    let staging: URL
    let lock: URL

    init(existing: Bool = true) throws {
        guard let canonical = realpath(FileManager.default.temporaryDirectory.path, nil) else {
            throw TestFailure(description: "Cannot resolve temporary directory")
        }
        let temporaryRoot = String(cString: canonical)
        free(canonical)
        temporary = URL(fileURLWithPath: temporaryRoot, isDirectory: true).appendingPathComponent("mentra-core-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false)
        root = temporary.appendingPathComponent("Applications/Mentra E2E")
        staging = root.appendingPathComponent(".staging-test")
        lock = root.appendingPathComponent(".install-lock")
        try InstallerFiles.claim(root)
        try FileManager.default.createDirectory(at: staging.appendingPathComponent("Mentra.app"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        try Data("new".utf8).write(to: staging.appendingPathComponent("Mentra.app/binary"))
        try Data("new manifest".utf8).write(to: staging.appendingPathComponent("installed-build.json"))
        if existing {
            try FileManager.default.createDirectory(at: root.appendingPathComponent("Mentra.app"), withIntermediateDirectories: false)
            try Data("old".utf8).write(to: root.appendingPathComponent("Mentra.app/binary"))
            try Data("old manifest".utf8).write(to: root.appendingPathComponent("installed-build.json"))
        }
    }

    func clean() {
        try? FileManager.default.removeItem(at: temporary)
    }

    func text(_ relative: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func commit(move: (URL, URL) throws -> Void = InstallerFiles.move) throws {
        try InstallerFiles.commit(root: root, staging: staging, lock: lock, move: move)
    }
}

@main
private struct InstallerCoreTests {
    static func main() {
        do { try run() }
        catch {
            FileHandle.standardError.write(Data("Test failed: \(error)\n".utf8))
            exit(1)
        }
    }

    static func run() throws {
        var count = 0
        func test(_ name: String, _ body: () throws -> Void) throws {
            try body()
            count += 1
            print("ok \(count) - \(name)")
        }
        let data = try encode(manifestJSON())
        let manifest = try BuildManifest(data: data)
        let now = Date(timeIntervalSince1970: 1_750_000_000)

        try test("bind the chosen package to the signed installer's exact manifest") {
            let actual = try BuildManifest(data: data, expected: data)
            try expect(actual.pr == 123 && actual.version == "3.2.1", "Lost build identity")
            try rejects("different build") { _ = try BuildManifest(data: data + Data("\n".utf8), expected: data) }
        }
        for (key, value) in ["teamId": "OTHER", "bundleId": "another.app", "app": "../Mentra.app",
                             "macInstaller": "another.app", "javascriptSha256": "", "headSha": "invalid"]
        {
            try test("reject altered \(key)") {
                var invalid = manifestJSON()
                invalid[key] = value
                try rejects("valid Mentra") { _ = try BuildManifest(data: encode(invalid)) }
            }
        }
        try test("reject archive and launcher redirection") {
            for key in ["archivePath", "launcherPath"] {
                var invalid = manifestJSON()
                invalid[key] = "/somewhere/else"
                try rejects { _ = try BuildManifest(data: encode(invalid)) }
            }
        }
        try test("reject incomplete legacy package format") {
            var invalid = manifestJSON()
            invalid["macPackageVersion"] = 1
            try rejects { _ = try BuildManifest(data: encode(invalid)) }
        }
        try test("accept genuine legacy packages without executing their launcher") {
            var legacy = manifestJSON()
            legacy.removeValue(forKey: "macPackageVersion")
            legacy.removeValue(forKey: "macInstaller")
            legacy["launcherPath"] = "launch-ios-on-mac"
            legacy["launcherSha256"] = String(repeating: "d", count: 64)
            let candidate = try BuildManifest(data: encode(legacy))
            try expect(candidate.packageVersion == 1, "Legacy package was not identified")
            legacy["launcherPath"] = "../run-something"
            try rejects { _ = try BuildManifest(data: encode(legacy)) }
        }
        try test("installer ownership cannot claim the app installer's directory") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            try rejects("not owned") {
                try InstallerFiles.claim(fixture.root, owner: InstallerHost.owner, bundleID: InstallerHost.bundleID)
            }
            try expect(fixture.text("Mentra.app/binary") == "old", "Another owner's app changed")
        }
        try test("accept only the registered Mac and exact unexpired profile") {
            try validateProfile(profile(manifest), manifest: manifest, deviceID: "registered-mac", now: now)
            try rejects("not registered") { try validateProfile(profile(manifest), manifest: manifest, deviceID: "another-mac", now: now) }
            try rejects("expired") { try validateProfile(profile(manifest), manifest: manifest, deviceID: "registered-mac", now: manifest.profileExpires) }
        }
        try test("reject mismatched profile and development or enterprise entitlements") {
            for (key, value) in ["UUID": "different", "TeamIdentifier": ["OTHER"], "ProvisionsAllDevices": true,
                                 "Entitlements": ["application-identifier": "\(BuildManifest.teamID).\(BuildManifest.bundleID)", "get-task-allow": true]] as [String: Any]
            {
                var invalid = profile(manifest)
                invalid[key] = value
                try rejects("does not match") { try validateProfile(invalid, manifest: manifest, deviceID: "registered-mac", now: now) }
            }
        }
        try test("preserve and reuse the managed installation marker") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            try InstallerFiles.claim(fixture.root)
            try expect(fixture.text("Mentra.app/binary") == "old", "Claim modified installed app")
        }
        try test("refuse an unowned installation directory") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            try FileManager.default.removeItem(at: fixture.root.appendingPathComponent("owner.json"))
            try rejects { try InstallerFiles.claim(fixture.root) }
            try expect(fixture.text("Mentra.app/binary") == "old", "Unowned app changed")
        }
        try test("refuse symlinked ancestors and manifests") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            let alias = fixture.temporary.appendingPathComponent("alias")
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: fixture.root)
            try rejects("symlink") { try InstallerFiles.requirePath(alias.appendingPathComponent("Mentra.app"), directory: true) }
            let metadata = fixture.staging.appendingPathComponent("installed-build.json")
            try FileManager.default.removeItem(at: metadata)
            try FileManager.default.createSymbolicLink(at: metadata, withDestinationURL: fixture.root.appendingPathComponent("installed-build.json"))
            try rejects("symlink") { try fixture.commit() }
            try expect(fixture.text("Mentra.app/binary") == "old", "Rejected metadata changed app")
        }
        try test("refuse linked files and links inside an app") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            let binary = fixture.root.appendingPathComponent("Mentra.app/binary")
            let alias = fixture.root.appendingPathComponent("alias")
            try FileManager.default.linkItem(at: binary, to: alias)
            try rejects("linked file") { _ = try InstallerFiles.read(binary) }
            try FileManager.default.removeItem(at: alias)
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: binary)
            try rejects("unexpected link") { try InstallerFiles.requirePlainTree(fixture.root) }
        }
        try test("promote the app and matching evidence together") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            try fixture.commit()
            try expect(fixture.text("Mentra.app/binary") == "new", "App was not promoted")
            try expect(fixture.text("installed-build.json") == "new manifest", "Metadata was not promoted")
            try expect(fixture.text(".install-lock/previous.app/binary") == "old", "Recovery app missing")
        }
        try test("metadata failure restores the old app and evidence") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            try rejects("metadata failure") {
                try fixture.commit { from, to in
                    if from.lastPathComponent == "installed-build.json" { throw InstallerError.invalid("metadata failure") }
                    try InstallerFiles.move(from, to)
                }
            }
            try expect(fixture.text("Mentra.app/binary") == "old", "Old app not restored")
            try expect(fixture.text("installed-build.json") == "old manifest", "Old evidence changed")
            try expect(fixture.text(".staging-test/Mentra.app/binary") == "new", "New app unavailable for recovery")
        }
        try test("failed first installation leaves no unmatched app") {
            let fixture = try Fixture(existing: false)
            defer { fixture.clean() }
            try rejects {
                try fixture.commit { from, to in
                    if from.lastPathComponent == "installed-build.json" { throw InstallerError.invalid("metadata failure") }
                    try InstallerFiles.move(from, to)
                }
            }
            try expect(!InstallerFiles.exists(fixture.root.appendingPathComponent("Mentra.app")), "Unmatched app remained live")
            try expect(!InstallerFiles.exists(fixture.root.appendingPathComponent("installed-build.json")), "Unexpected live manifest")
        }
        try test("rollback failure retains both generations") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            let error = try rejects("Recovery files") {
                try fixture.commit { from, to in
                    if from.lastPathComponent == "installed-build.json" { throw InstallerError.invalid("metadata failure") }
                    if from.path == fixture.root.appendingPathComponent("Mentra.app").path, to.path == fixture.staging.appendingPathComponent("Mentra.app").path {
                        throw InstallerError.invalid("rollback failure")
                    }
                    try InstallerFiles.move(from, to)
                }
            }
            guard case InstallerError.recovery = error else { throw TestFailure(description: "Recovery failure was not distinguished") }
            try expect(fixture.text("Mentra.app/binary") == "new", "New generation lost")
            try expect(fixture.text(".install-lock/previous.app/binary") == "old", "Old generation lost")
            try expect(fixture.text("installed-build.json") == "old manifest", "Old evidence lost")
        }
        try test("never overwrite retained recovery state") {
            let fixture = try Fixture()
            defer { fixture.clean() }
            try FileManager.default.createDirectory(at: fixture.lock.appendingPathComponent("previous.app"), withIntermediateDirectories: false)
            try rejects("retained recovery") { try fixture.commit() }
            try expect(fixture.text("Mentra.app/binary") == "old", "Old app changed")
        }
        print("Passed \(count) offline native installer tests.")
    }
}

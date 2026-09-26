import Foundation
import zlib

private struct Failure: Error, CustomStringConvertible {
    let description: String
}

private func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw Failure(description: message) }
}

private func rejects(_ operation: () throws -> Void) throws {
    do { try operation() }
    catch { return }
    throw Failure(description: "Expected rejection")
}

private let head = String(repeating: "a", count: 40)
private let link = "mentra-install://pr?number=123&head=\(head)&run=100&attempt=2"

private func encode(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
}

private func receiptJSON(legacy: Bool = false, schema: Int = 2) -> [String: Any] {
    var app: [String: Any] = [
        "macPackageVersion": 2, "macInstaller": "Install Mentra.app", "app": "Mentra.app",
        "bundleId": BuildManifest.bundleID, "teamId": BuildManifest.teamID,
        "pr": 123, "headSha": head, "runId": 100, "runAttempt": 1,
        "buildSha": String(repeating: "b", count: 40), "backend": "dev",
        "otaManifestUrl": InstallRequest.origin + "ota-pr-123-\(head).json",
        "version": "3.2.1", "build": "302015703",
        "executableSha256": String(repeating: "b", count: 64), "javascriptSha256": String(repeating: "c", count: 64),
        "profileUUID": "44260D9B-F260-406F-BAD7-7119EFE321D8", "profileExpires": "2027-05-28T04:05:18",
    ]
    if legacy {
        app.removeValue(forKey: "macPackageVersion")
        app.removeValue(forKey: "macInstaller")
        app["launcherPath"] = "launch-ios-on-mac"
        app["launcherSha256"] = String(repeating: "d", count: 64)
    }
    let extensions = schema == 2 ? ["mac": "zip", "iphone": "ipa", "manifest": "plist", "install": "html"] : ["mac": "zip", "iphone": "ipa"]
    let assets = extensions.mapValues { _ in [String: Any]() }
    var receipt: [String: Any] = [
        "schemaVersion": schema, "pr": 123, "headSha": head, "runId": 100, "runAttempt": 2, "buildAttempt": 1,
        "buildSha": app["buildSha"]!, "app": app,
    ]
    var artifacts = assets
    for (kind, ext) in extensions {
        artifacts[kind] = ["name": "mentra-ios-\(kind)-pr-123-\(head)-100-1.\(ext)", "size": 100, "sha256": String(repeating: "c", count: 64)]
    }
    receipt["artifacts"] = artifacts
    return receipt
}

private extension Data {
    mutating func integer(_ value: Int, width: Int) {
        for byte in 0 ..< width {
            append(UInt8(truncatingIfNeeded: value >> (byte * 8)))
        }
    }

    mutating func setInteger(_ value: Int, at offset: Int, width: Int) {
        for byte in 0 ..< width {
            self[offset + byte] = UInt8(truncatingIfNeeded: value >> (byte * 8))
        }
    }
}

private func deflated(_ data: Data) throws -> Data {
    var stream = z_stream()
    guard deflateInit2_(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY,
                        zlibVersion(), Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw Failure(description: "Cannot build deflate fixture") }
    defer { deflateEnd(&stream) }
    var output = Data(count: Int(compressBound(uLong(data.count))))
    let status = data.withUnsafeBytes { input in
        output.withUnsafeMutableBytes { out in
            stream.next_in = UnsafeMutablePointer(mutating: input.baseAddress?.assumingMemoryBound(to: Bytef.self))
            stream.avail_in = uInt(input.count)
            stream.next_out = out.baseAddress?.assumingMemoryBound(to: Bytef.self)
            stream.avail_out = uInt(out.count)
            return deflate(&stream, Z_FINISH)
        }
    }
    guard status == Z_STREAM_END else { throw Failure(description: "Deflate fixture failed") }
    output.count = Int(stream.total_out)
    return output
}

private struct Entry {
    var name: String
    var body = Data("fixture".utf8)
    var mode = 0o100644
    var flags = 0
    var method = 0
    var extra = Data()
    var localName: String?
    var declaredSize: Int?
}

private let validEntries = [Entry(name: "Mentra PR/build.json"), Entry(name: "Mentra PR/Mentra.app/Info.plist")]

private func archive(_ entries: [Entry]) throws -> Data {
    var output = Data()
    var central = Data()
    for entry in entries {
        let name = Data(entry.name.utf8)
        let localName = Data((entry.localName ?? entry.name).utf8)
        let content = entry.method == 8 ? try deflated(entry.body) : entry.body
        let size = entry.declaredSize ?? entry.body.count
        let crc = Int(entry.body.withUnsafeBytes { crc32(0, $0.baseAddress?.assumingMemoryBound(to: Bytef.self), uInt($0.count)) })
        let offset = output.count
        output.integer(0x0403_4B50, width: 4)
        for value in [20, entry.flags, entry.method, 0, 0] {
            output.integer(value, width: 2)
        }
        for value in entry.flags & 8 == 0 ? [crc, content.count, size] : [0, 0, 0] {
            output.integer(value, width: 4)
        }
        output.integer(localName.count, width: 2)
        output.integer(entry.extra.count, width: 2)
        output.append(localName)
        output.append(entry.extra)
        output.append(content)
        if entry.flags & 8 != 0 {
            for value in [0x0807_4B50, crc, content.count, size] {
                output.integer(value, width: 4)
            }
        }
        central.integer(0x0201_4B50, width: 4)
        for value in [0x0315, 20, entry.flags, entry.method, 0, 0] {
            central.integer(value, width: 2)
        }
        for value in [crc, content.count, size] {
            central.integer(value, width: 4)
        }
        for value in [name.count, entry.extra.count, 0, 0, 0] {
            central.integer(value, width: 2)
        }
        central.integer(entry.mode << 16, width: 4)
        central.integer(offset, width: 4)
        central.append(name)
        central.append(entry.extra)
    }
    let start = output.count
    output.append(central)
    output.integer(0x0605_4B50, width: 4)
    for value in [0, 0, entries.count, entries.count] {
        output.integer(value, width: 2)
    }
    output.integer(central.count, width: 4)
    output.integer(start, width: 4)
    output.integer(0, width: 2)
    return output
}

@main
private struct DistributionTests {
    static func main() {
        do {
            try run()
            if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--archive" {
                let result = try ArchiveInspection(data: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]), options: .mappedIfSafe))
                print("Verified actual archive: \(result.entryCount) entries, \(result.expandedBytes) expanded bytes")
            }
        } catch {
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
        let request = try InstallRequest(url: URL(string: link)!)
        try test("select immutable company CI coordinates from a link") {
            try expect(request.pr == 123 && request.runID == 100 && request.attempt == 2 && request.head == head, "Incorrect request")
            try expect(request.receiptURL.absoluteString == InstallRequest.origin + "mentra-ios-pr-123-\(head)-100-2.json", "Wrong receipt origin")
        }
        try test("reject alternate origins, paths, credentials and extra or duplicate arguments") {
            for invalid in [
                link.replacingOccurrences(of: "mentra-install", with: "https"),
                link.replacingOccurrences(of: "://pr?", with: "://other?"),
                link.replacingOccurrences(of: "://pr?", with: "://user@pr?"),
                link.replacingOccurrences(of: "://pr?", with: "://pr:443?"),
                link.replacingOccurrences(of: "://pr?", with: "://pr/path?"),
                link + "&url=https://attacker.test/file.zip", link + "&number=123", link + "#fragment",
            ] {
                try rejects { _ = try InstallRequest(url: URL(string: invalid)!) }
            }
        }
        try test("reject noncanonical numbers and incomplete commit hashes") {
            for value in ["0", "-1", "01", "+1", "1.5", "NaN", "9007199254740992", "99999999999999999999999999"] {
                try rejects { _ = try InstallRequest(url: URL(string: link.replacingOccurrences(of: "number=123", with: "number=\(value)"))!) }
            }
            try rejects { _ = try InstallRequest(url: URL(string: link.replacingOccurrences(of: head, with: "abc123"))!) }
        }
        try test("accept only the admitted dev and staging PR backends") {
            for backend in ["dev", "staging"] {
                var receipt = receiptJSON()
                var app = receipt["app"] as! [String: Any]
                app["backend"] = backend
                receipt["app"] = app
                _ = try DistributionReceipt(data: encode(receipt), request: request)
            }
            var missing = receiptJSON()
            var app = missing["app"] as! [String: Any]
            app.removeValue(forKey: "backend")
            missing["app"] = app
            try rejects { _ = try DistributionReceipt(data: encode(missing), request: request) }
        }
        try test("publication rerun selects original build attempt and archive") {
            let receipt = try DistributionReceipt(data: encode(receiptJSON()), request: request)
            try expect(receipt.archiveName.hasSuffix("-100-1.zip"), "Publication attempt changed source archive")
            try expect(receipt.archiveURL.absoluteString == InstallRequest.origin + receipt.archiveName, "Archive escaped fixed origin")
        }
        try test("support previously published legacy Mac ZIP receipts without running their scripts") {
            _ = try DistributionReceipt(data: encode(receiptJSON(legacy: true)), request: request)
            _ = try DistributionReceipt(data: encode(receiptJSON(legacy: true, schema: 1)), request: request)
            var original = receiptJSON(legacy: true, schema: 1)
            original["runAttempt"] = 1
            original.removeValue(forKey: "buildAttempt")
            let originalRequest = try InstallRequest(url: URL(string: link.replacingOccurrences(of: "attempt=2", with: "attempt=1"))!)
            _ = try DistributionReceipt(data: encode(original), request: originalRequest)
        }
        try test("reject stale, cross-PR and impossible build attempts") {
            for (key, value) in ["pr": 124, "headSha": String(repeating: "c", count: 40), "runId": 101,
                                 "runAttempt": 1, "buildAttempt": 3, "schemaVersion": 3] as [String: Any]
            {
                var receipt = receiptJSON()
                receipt[key] = value
                try rejects { _ = try DistributionReceipt(data: encode(receipt), request: request) }
            }
            for value in [0, true, "1", -1] as [Any] {
                var receipt = receiptJSON()
                receipt["buildAttempt"] = value
                try rejects { _ = try DistributionReceipt(data: encode(receipt), request: request) }
            }
        }
        try test("bind the embedded app to its producing attempt, signing identity and OTA pin") {
            for (key, value) in ["runAttempt": 2, "teamId": "OTHER", "buildSha": String(repeating: "c", count: 40),
                                 "otaManifestUrl": "https://attacker.test/ota.json", "backend": "prod"] as [String: Any]
            {
                var receipt = receiptJSON()
                var app = receipt["app"] as! [String: Any]
                app[key] = value
                receipt["app"] = app
                try rejects { _ = try DistributionReceipt(data: encode(receipt), request: request) }
            }
        }
        try test("reject archive redirection, missing hashes and oversized or boolean sizes") {
            for (key, value) in ["name": "../evil.zip", "sha256": "bad", "size": DistributionReceipt.maximumArchiveBytes + 1] as [String: Any] {
                var receipt = receiptJSON()
                var assets = receipt["artifacts"] as! [String: [String: Any]]
                assets["mac"]![key] = value
                receipt["artifacts"] = assets
                try rejects { _ = try DistributionReceipt(data: encode(receipt), request: request) }
            }
            var receipt = receiptJSON()
            var assets = receipt["artifacts"] as! [String: [String: Any]]
            assets["mac"]!["size"] = true
            receipt["artifacts"] = assets
            try rejects { _ = try DistributionReceipt(data: encode(receipt), request: request) }
        }
        try test("reject large receipts and keep packaged manifest bound to all receipt fields") {
            let receipt = try DistributionReceipt(data: encode(receiptJSON()), request: request)
            try receipt.verifyManifest(encode(receipt.app))
            var changed = receipt.app
            changed["version"] = "different"
            try rejects { try receipt.verifyManifest(encode(changed)) }
            try rejects { _ = try DistributionReceipt(data: Data(repeating: 32, count: DistributionReceipt.maximumReceiptBytes + 1), request: request) }
        }
        try test("inspect stored entries with implicit directories") {
            let inspection = try ArchiveInspection(data: archive(validEntries))
            try expect(inspection.entryCount == 2 && inspection.expandedBytes == 14, "Lost archive size information")
        }
        try test("inspect genuine deflate data and signed data descriptors") {
            let entries = validEntries.map { entry -> Entry in
                var result = entry
                result.method = 8
                result.flags = 8
                result.body = Data(repeating: 65, count: 200_000)
                return result
            }
            try expect(ArchiveInspection(data: archive(entries)).expandedBytes == 400_000, "Wrong expanded size")
        }
        try test("accept macOS metadata and a native installer alongside the untouched iOS app") {
            let entries = validEntries + [
                Entry(name: "Mentra PR/Install Mentra.app/Contents/MacOS/Installer", mode: 0o100755, method: 8),
                Entry(name: "Mentra PR/Install Mentra.app/Contents/_CodeSignature/CodeResources", method: 8),
                Entry(name: "__MACOSX/Mentra PR/._Install Mentra.app", method: 8),
                Entry(name: "__MACOSX/Mentra PR/Install Mentra.app/Contents/MacOS/._Installer", method: 8),
            ]
            try expect(ArchiveInspection(data: archive(entries)).entryCount == 6, "Mac metadata entries were lost")
        }
        try test("reject traversal, alternate roots and macOS path ambiguity") {
            for name in ["/Mentra PR/evil", "Mentra PR/../evil", "Mentra PR//evil", "Mentra PR/./evil", "evil/file",
                         "Mentra PR/back\\slash", "Mentra PR/colon:name", "Mentra PR/control\u{0}", "Mentra PR/../../evil"]
            {
                try rejects { _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: name)])) }
            }
        }
        try test("reject duplicate, case-colliding and file-as-directory paths") {
            for extra in [
                [validEntries[0]], [Entry(name: "Mentra PR/BUILD.JSON")],
                [Entry(name: "Mentra PR/Foo/a"), Entry(name: "Mentra PR/foo/b")],
                [Entry(name: "Mentra PR/file"), Entry(name: "Mentra PR/file/child")],
            ] {
                try rejects { _ = try ArchiveInspection(data: archive(validEntries + extra)) }
            }
        }
        try test("reject symlinks, devices and privileged modes before extraction") {
            for mode in [0o120777, 0o020666, 0o010666, 0o104755] {
                try rejects { _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: "Mentra PR/link", mode: mode)])) }
            }
        }
        try test("reject encrypted and unsupported compressed entries") {
            try rejects { _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: "Mentra PR/encrypted", flags: 1)])) }
            try rejects { _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: "Mentra PR/unknown", method: 12)])) }
        }
        try test("allow timestamp metadata and reject ZIP64 or path-changing extra fields") {
            var timestamp = Data()
            timestamp.integer(0x5855, width: 2)
            timestamp.integer(8, width: 2)
            timestamp.append(Data(repeating: 0, count: 8))
            _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: "Mentra PR/timestamp", extra: timestamp)]))
            for tag in [0x0001, 0x7075, 0x756E] {
                var extra = Data()
                extra.integer(tag, width: 2)
                extra.integer(0, width: 2)
                try rejects { _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: "Mentra PR/extra", extra: extra)])) }
            }
        }
        try test("reject local-header names that differ from the central directory") {
            try rejects { _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: "Mentra PR/good", localName: "Mentra PR/evil")])) }
        }
        try test("reject false expanded lengths based on actual inflated bytes") {
            let bomb = Entry(name: "Mentra PR/bomb", body: Data(repeating: 65, count: 200_000), method: 8, declaredSize: 1)
            try rejects { _ = try ArchiveInspection(data: archive(validEntries + [bomb])) }
            try rejects { _ = try ArchiveInspection(data: archive(validEntries + [Entry(name: "Mentra PR/huge", declaredSize: ArchiveInspection.maximumExpandedBytes)])) }
        }
        try test("reject damaged file data, split disks and excessive entry counts") {
            var damaged = try archive(validEntries)
            damaged[30 + validEntries[0].name.utf8.count] ^= 1
            try rejects { _ = try ArchiveInspection(data: damaged) }
            var split = try archive(validEntries)
            split.setInteger(1, at: split.count - 22 + 4, width: 2)
            try rejects { _ = try ArchiveInspection(data: split) }
            var many = try archive(validEntries)
            many.setInteger(65535, at: many.count - 22 + 8, width: 2)
            many.setInteger(65535, at: many.count - 22 + 10, width: 2)
            try rejects { _ = try ArchiveInspection(data: many) }
        }
        try test("reject truncation and archives without the app and manifest") {
            let complete = try archive(validEntries)
            for size in [0, 21, complete.count - 1, complete.count / 2] {
                try rejects { _ = try ArchiveInspection(data: complete.prefix(size)) }
            }
            try rejects { _ = try ArchiveInspection(data: archive([validEntries[0]])) }
        }
        print("Passed \(count) distribution tests")
    }
}

import CoreFoundation
import Darwin
import Foundation
import zlib

/// Links select immutable CI coordinates, never a download URL or a command.
struct InstallRequest {
    static let origin = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/"
    let pr: Int
    let head: String
    let runID: Int
    let attempt: Int

    init(url: URL) throws {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "mentra-install", parts.host == "pr", parts.path.isEmpty,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count == 4,
              Set(items.map(\.name)) == ["number", "head", "run", "attempt"]
        else { throw InstallerError.invalid("This is not a valid Mentra PR installation link. Open Install on Mac in #pr-builds again.") }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        func number(_ name: String) throws -> Int {
            guard let string = values[name], let value = Int(string), value > 0,
                  value <= 9_007_199_254_740_991, String(value) == string
            else { throw InstallerError.invalid("Invalid \(name) in the Mentra installation link.") }
            return value
        }
        guard let head = values["head"], distributionHex(head, length: 40) else {
            throw InstallerError.invalid("The installation link must identify the complete PR commit.")
        }
        pr = try number("number")
        self.head = head
        runID = try number("run")
        attempt = try number("attempt")
    }

    var summary: String {
        "PR #\(pr) · \(head.prefix(8))"
    }

    var receiptURL: URL {
        URL(string: "\(Self.origin)mentra-ios-pr-\(pr)-\(head)-\(runID)-\(attempt).json")!
    }

    var otaURL: String {
        "\(Self.origin)ota-pr-\(pr)-\(head).json"
    }
}

private func distributionHex(_ value: String, length: Int) -> Bool {
    value.count == length && value.allSatisfy { "0123456789abcdef".contains($0) }
}

private func distributionInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue > 0, number.doubleValue <= 9_007_199_254_740_991,
          number.doubleValue.rounded() == number.doubleValue else { return nil }
    return number.intValue
}

struct DistributionReceipt {
    static let maximumReceiptBytes = 512 * 1024
    static let maximumArchiveBytes = 2 * 1024 * 1024 * 1024
    let app: [String: Any]
    let archiveName: String
    let archiveSHA256: String
    let archiveSize: Int

    init(data: Data, request: InstallRequest) throws {
        guard data.count <= Self.maximumReceiptBytes else { throw InstallerError.invalid("The build receipt is too large.") }
        let json = try InstallerFiles.dictionary(data)
        let buildAttempt = distributionInteger(json["buildAttempt"] ?? json["runAttempt"])
        guard let schema = distributionInteger(json["schemaVersion"]), [1, 2].contains(schema),
              distributionInteger(json["pr"]) == request.pr, json["headSha"] as? String == request.head,
              distributionInteger(json["runId"]) == request.runID,
              distributionInteger(json["runAttempt"]) == request.attempt,
              let buildAttempt, buildAttempt <= request.attempt,
              let buildSHA = json["buildSha"] as? String, distributionHex(buildSHA, length: 40),
              let app = json["app"] as? [String: Any],
              distributionInteger(app["pr"]) == request.pr, app["headSha"] as? String == request.head,
              distributionInteger(app["runId"]) == request.runID,
              distributionInteger(app["runAttempt"]) == buildAttempt,
              app["buildSha"] as? String == buildSHA,
              app["otaManifestUrl"] as? String == request.otaURL,
              // Only the admitted PR backends; the notifier binds each to its PR base.
              ["dev", "staging"].contains(app["backend"] as? String ?? "")
        else { throw InstallerError.invalid("The published receipt does not match the selected PR, commit, or workflow attempt.") }
        _ = try BuildManifest(data: JSONSerialization.data(withJSONObject: app))
        guard let assets = json["artifacts"] as? [String: [String: Any]] else {
            throw InstallerError.invalid("The receipt has no valid Mac artifact.")
        }
        let kinds = schema == 1 ? ["iphone": "ipa", "mac": "zip"] : ["iphone": "ipa", "mac": "zip", "manifest": "plist", "install": "html"]
        guard Set(assets.keys) == Set(kinds.keys) else { throw InstallerError.invalid("The receipt contains an unexpected artifact set.") }
        for (kind, ext) in kinds {
            let asset = assets[kind]!
            let name = "mentra-ios-\(kind)-pr-\(request.pr)-\(request.head)-\(request.runID)-\(buildAttempt).\(ext)"
            guard asset["name"] as? String == name,
                  let hash = asset["sha256"] as? String, distributionHex(hash, length: 64),
                  let size = distributionInteger(asset["size"]), size <= Self.maximumArchiveBytes
            else { throw InstallerError.invalid("Invalid \(kind) artifact in the build receipt.") }
        }
        self.app = app
        archiveName = assets["mac"]!["name"] as! String
        archiveSHA256 = assets["mac"]!["sha256"] as! String
        archiveSize = distributionInteger(assets["mac"]!["size"])!
    }

    var archiveURL: URL {
        URL(string: InstallRequest.origin + archiveName)!
    }

    func verifyManifest(_ data: Data) throws {
        guard data.count <= Self.maximumReceiptBytes,
              try NSDictionary(dictionary: InstallerFiles.dictionary(data)).isEqual(to: app)
        else { throw InstallerError.invalid("The downloaded build.json does not match its published receipt.") }
    }
}

/// Data delegates enforce the byte limit while streaming, including when a
/// server omits Content-Length. Redirects cannot change the fixed origin.
private final class ArtifactDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let url: URL
    let limit: Int
    let output: FileHandle
    private var received = 0
    private var failure: Error?
    private var completion: CheckedContinuation<Void, Error>?
    private var session: URLSession?

    init(url: URL, destination: URL, limit: Int) throws {
        self.url = url
        self.limit = limit
        let descriptor = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            throw InstallerError.invalid("Cannot create the private download file.")
        }
        output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    func start(_ completion: CheckedContinuation<Void, Error>) {
        self.completion = completion
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 15 * 60
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        var request = URLRequest(url: url)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue("Mentra-Mac-Installer/1", forHTTPHeaderField: "User-Agent")
        session.dataTask(with: request).resume()
    }

    func urlSession(_: URLSession, task: URLSessionTask, willPerformHTTPRedirection _: HTTPURLResponse,
                    newRequest _: URLRequest, completionHandler: @escaping (URLRequest?) -> Void)
    {
        failure = InstallerError.invalid("The artifact server redirected this download. The selected build was not installed.")
        completionHandler(nil)
        task.cancel()
    }

    func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void)
    {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, response.url == url,
              response.expectedContentLength <= limit
        else {
            failure = InstallerError.invalid("The build download is unavailable or exceeds its size limit. Try the Install on Mac link again after CI publishes the build.")
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        guard data.count <= limit - received else {
            failure = InstallerError.invalid("The build download exceeded its declared size.")
            dataTask.cancel()
            return
        }
        do {
            try output.write(contentsOf: data)
            received += data.count
        } catch {
            failure = error
            dataTask.cancel()
        }
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError error: Error?) {
        do { try output.close() } catch { if failure == nil { failure = error } }
        if let completion {
            self.completion = nil
            if let error = failure ?? error { completion.resume(throwing: error) }
            else { completion.resume() }
        }
        session?.finishTasksAndInvalidate()
        session = nil
    }

    static func download(_ url: URL, to destination: URL, limit: Int) async throws {
        let operation = try ArtifactDownload(url: url, destination: destination, limit: limit)
        try await withCheckedThrowingContinuation { operation.start($0) }
    }
}

/// The installer accepts the small, ordinary ZIP dialect produced by ditto.
/// Both headers and actual deflate output are checked before ditto sees it.
/// In particular, central-directory sizes alone do not bound a ZIP bomb.
struct ArchiveInspection {
    static let maximumExpandedBytes = 2 * 1024 * 1024 * 1024
    static let maximumEntries = 20000
    let entryCount: Int
    let expandedBytes: Int

    init(data: Data) throws {
        func reject() -> InstallerError {
            .invalid("The Mac ZIP is corrupt or uses an unsupported archive format. Download a fresh build; if it still fails, send the PR and run number to the release maintainer.")
        }
        func u16(_ offset: Int) throws -> Int {
            guard offset >= 0, offset <= data.count - 2 else { throw reject() }
            return Int(data[offset]) | Int(data[offset + 1]) << 8
        }
        func u32(_ offset: Int) throws -> Int {
            try u16(offset) | u16(offset + 2) << 16
        }
        func bytes(_ start: Int, _ count: Int) throws -> Data {
            guard start >= 0, count >= 0, start <= data.count, count <= data.count - start else { throw reject() }
            return data.subdata(in: start ..< start + count)
        }
        func extras(_ start: Int, _ count: Int) throws {
            var cursor = start
            let end = start + count
            guard end <= data.count else { throw reject() }
            while cursor < end {
                guard end - cursor >= 4 else { throw reject() }
                let tag = try u16(cursor)
                let size = try u16(cursor + 2)
                guard size <= end - cursor - 4,
                      (tag == 0x5855 && [8, 12].contains(size)) ||
                      (tag == 0x5455 && (1 ... 13).contains(size)) ||
                      (tag == 0x7875 && (3 ... 32).contains(size)) else { throw reject() }
                cursor += 4 + size
            }
        }
        guard data.count >= 22, data.count <= DistributionReceipt.maximumArchiveBytes else { throw reject() }
        var end: Int?
        for candidate in stride(from: data.count - 22, through: max(0, data.count - 65557), by: -1) {
            if try u32(candidate) == 0x0605_4B50, try candidate + 22 + u16(candidate + 20) == data.count {
                end = candidate
                break
            }
        }
        guard let end else { throw reject() }
        let count = try u16(end + 10)
        let centralSize = try u32(end + 12)
        let centralStart = try u32(end + 16)
        guard try u16(end + 4) == 0, try u16(end + 6) == 0, try u16(end + 8) == count,
              count > 0, count <= Self.maximumEntries,
              centralStart < end, centralSize == end - centralStart else { throw reject() }
        var cursor = centralStart
        var expanded = 0
        var paths: [String: (name: String, directory: Bool, declared: Bool)] = [:]
        var ranges: [Range<Int>] = []
        var hasManifest = false
        var hasApp = false
        for _ in 0 ..< count {
            guard try u32(cursor) == 0x0201_4B50, cursor <= end - 46,
                  try u16(cursor + 6) <= 20, try u16(cursor + 34) == 0 else { throw reject() }
            let flags = try u16(cursor + 8)
            let method = try u16(cursor + 10)
            let crc = try u32(cursor + 16)
            let compressed = try u32(cursor + 20)
            let size = try u32(cursor + 24)
            let nameLength = try u16(cursor + 28)
            let extraLength = try u16(cursor + 30)
            let commentLength = try u16(cursor + 32)
            let attributes = try u32(cursor + 38)
            let local = try u32(cursor + 42)
            let nameBytes = try bytes(cursor + 46, nameLength)
            guard (flags & ~0x0808) == 0, [0, 8].contains(method), nameLength <= 4096,
                  let rawName = String(data: nameBytes, encoding: .utf8), !rawName.isEmpty,
                  rawName.utf8.allSatisfy({ $0 >= 32 && $0 != 127 }),
                  (flags & 0x0800) != 0 || rawName.utf8.allSatisfy({ $0 < 128 }),
                  !rawName.contains("\\"), !rawName.contains(":"),
                  rawName == rawName.precomposedStringWithCanonicalMapping,
                  size <= Self.maximumExpandedBytes - expanded,
                  compressed <= data.count, local < centralStart
            else { throw reject() }
            expanded += size
            let directory = rawName.hasSuffix("/")
            let name = directory ? String(rawName.dropLast()) : rawName
            let components = name.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            let kind = (attributes >> 16) & 0o170000
            guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                  components.first == "Mentra PR" || components.first == "__MACOSX",
                  [0, 0o100000, 0o040000].contains(kind),
                  kind == 0 || (kind == 0o040000) == directory,
                  attributes & 0x10 == 0 || directory,
                  (attributes >> 16) & 0o7000 == 0,
                  !directory || (size == 0 && compressed == 0 && method == 0 && crc == 0)
            else { throw reject() }
            // Include implicit parents: Foo/a and foo/b must not coalesce on
            // the usual case-insensitive macOS filesystem either.
            for index in components.indices {
                let partial = components[...index].joined(separator: "/")
                let key = partial.folding(options: .caseInsensitive, locale: Locale(identifier: "en_US_POSIX"))
                let last = index == components.count - 1
                let isDirectory = !last || directory
                if let previous = paths[key] {
                    guard previous.name == partial, previous.directory == isDirectory,
                          !(last && previous.declared) else { throw reject() }
                    if last { paths[key] = (partial, isDirectory, true) }
                } else { paths[key] = (partial, isDirectory, last) }
            }
            hasManifest = hasManifest || name == "Mentra PR/build.json" && !directory
            hasApp = hasApp || name.hasPrefix("Mentra PR/Mentra.app/")
            try extras(cursor + 46 + nameLength, extraLength)
            cursor += 46 + nameLength + extraLength + commentLength
            guard cursor <= end, try u32(local) == 0x0403_4B50,
                  try u16(local + 4) <= 20, try u16(local + 6) == flags, try u16(local + 8) == method,
                  try u16(local + 26) == nameLength,
                  try bytes(local + 30, nameLength) == nameBytes else { throw reject() }
            let localExtra = try u16(local + 28)
            try extras(local + 30 + nameLength, localExtra)
            let content = local + 30 + nameLength + localExtra
            guard content <= centralStart, compressed <= centralStart - content else { throw reject() }
            var next = content + compressed
            if flags & 8 == 0 {
                guard try u32(local + 14) == crc, try u32(local + 18) == compressed, try u32(local + 22) == size else { throw reject() }
            } else {
                guard try [0, crc].contains(u32(local + 14)), try [0, compressed].contains(u32(local + 18)),
                      try [0, size].contains(u32(local + 22)) else { throw reject() }
                if try u32(next) == 0x0807_4B50 { next += 4 }
                guard try u32(next) == crc, try u32(next + 4) == compressed, try u32(next + 8) == size else { throw reject() }
                next += 12
            }
            guard next <= centralStart else { throw reject() }
            ranges.append(local ..< next)
            try validateArchiveContent(data, offset: content, compressed: compressed, expanded: size, method: method, crc: crc)
        }
        guard cursor == end, hasManifest, hasApp else { throw reject() }
        var next = 0
        for range in ranges.sorted(by: { $0.lowerBound < $1.lowerBound }) {
            guard range.lowerBound == next else { throw reject() }
            next = range.upperBound
        }
        guard next == centralStart else { throw reject() }
        entryCount = count
        expandedBytes = expanded
    }
}

private func validateArchiveContent(_ data: Data, offset: Int, compressed: Int, expanded: Int, method: Int, crc: Int) throws {
    func invalid() -> InstallerError {
        .invalid("The Mac ZIP contains damaged data or exceeds its declared expanded size.")
    }
    try data.withUnsafeBytes { (source: UnsafeRawBufferPointer) in
        let input = source.baseAddress!.advanced(by: offset).assumingMemoryBound(to: Bytef.self)
        if method == 0 {
            guard compressed == expanded, crc32(0, input, uInt(compressed)) == crc else { throw invalid() }
            return
        }
        var stream = z_stream()
        guard inflateInit2_(&stream, -MAX_WBITS, zlibVersion(), Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw invalid() }
        defer { inflateEnd(&stream) }
        stream.next_in = UnsafeMutablePointer(mutating: input)
        stream.avail_in = uInt(compressed)
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        var checksum: uLong = 0
        var total = 0
        while true {
            let status: Int32 = buffer.withUnsafeMutableBytes { output in
                stream.next_out = output.baseAddress!.assumingMemoryBound(to: Bytef.self)
                stream.avail_out = uInt(output.count)
                return inflate(&stream, Z_NO_FLUSH)
            }
            let written = buffer.count - Int(stream.avail_out)
            guard written <= expanded - total else { throw invalid() }
            total += written
            checksum = buffer.withUnsafeBufferPointer { crc32(checksum, $0.baseAddress, uInt(written)) }
            if status == Z_STREAM_END {
                guard total == expanded, stream.avail_in == 0, checksum == crc else { throw invalid() }
                return
            }
            guard status == Z_OK, written > 0 else { throw invalid() }
        }
    }
}

private enum DistributionCache {
    static let owner = "mentra-mac-download-v1"
    static var root: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/com.mentra.mac-installer")
    }

    static func claim() throws {
        let root = root
        try InstallerFiles.requirePath(root.deletingLastPathComponent(), directory: true)
        if !InstallerFiles.exists(root) {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try InstallerFiles.writeJSON(["owner": owner], to: root.appendingPathComponent("owner.json"))
        }
        try InstallerFiles.requirePath(root, directory: true)
        let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
        guard (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0,
              try InstallerFiles.dictionary(InstallerFiles.read(root.appendingPathComponent("owner.json")))["owner"] as? String == owner
        else { throw InstallerError.invalid("The Mac installer cache is not a private, owned directory.") }
        // Normal success/failure removes its own request directory immediately.
        // A force-quit can interrupt that cleanup. Reclaim only our marked
        // requests whose owner process is gone and which are over a day old.
        // The delay also outlasts an orphaned macOS extraction subprocess.
        for child in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            guard child.lastPathComponent.hasPrefix("request-"),
                  UUID(uuidString: String(child.lastPathComponent.dropFirst("request-".count))) != nil,
                  let marker = try? InstallerFiles.dictionary(InstallerFiles.read(child.appendingPathComponent("owner.json"))),
                  marker["owner"] as? String == owner,
                  let pid = distributionInteger(marker["pid"]), pid <= Int32.max,
                  let created = marker["createdAt"] as? Double,
                  Date().timeIntervalSince1970 - created > 24 * 60 * 60,
                  kill(pid_t(pid), 0) == -1, errno == ESRCH,
                  (try? InstallerFiles.requirePlainTree(child)) != nil else { continue }
            try FileManager.default.removeItem(at: child)
        }
    }
}

/// Downloads only artifacts from the fixed company CI origin. Downloaded
/// installers and legacy scripts are data; none are executed by this helper.
func preparePackage(_ request: InstallRequest) async throws -> VerifiedBuild {
    try DistributionCache.claim()
    let staging = DistributionCache.root.appendingPathComponent("request-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    do {
        try InstallerFiles.writeJSON(["owner": DistributionCache.owner, "pid": Int(getpid()), "createdAt": Date().timeIntervalSince1970],
                                     to: staging.appendingPathComponent("owner.json"))
        let receiptFile = staging.appendingPathComponent("receipt.json")
        try await ArtifactDownload.download(request.receiptURL, to: receiptFile, limit: DistributionReceipt.maximumReceiptBytes)
        let receipt = try DistributionReceipt(data: InstallerFiles.read(receiptFile), request: request)
        let archive = staging.appendingPathComponent(receipt.archiveName)
        try await ArtifactDownload.download(receipt.archiveURL, to: archive, limit: receipt.archiveSize)
        guard try FileManager.default.attributesOfItem(atPath: archive.path)[.size] as? Int == receipt.archiveSize,
              try InstallerFiles.hash(archive) == receipt.archiveSHA256
        else {
            throw InstallerError.invalid("The downloaded Mac ZIP does not match the published size and SHA-256. The installed app was not changed.")
        }
        try Task.checkCancellation()
        _ = try ArchiveInspection(data: Data(contentsOf: archive, options: .mappedIfSafe))
        let extracted = staging.appendingPathComponent("extracted")
        try FileManager.default.createDirectory(at: extracted, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        // ditto preserves macOS metadata and quarantine. No xattr or security
        // preference is removed, including when importing an older CI ZIP.
        try tool("/usr/bin/ditto", ["-x", "-k", archive.path, extracted.path], timeout: 5 * 60)
        try InstallerFiles.requirePlainTree(extracted)
        let package = extracted.appendingPathComponent("Mentra PR")
        let manifestFile = package.appendingPathComponent("build.json")
        guard try FileManager.default.attributesOfItem(atPath: manifestFile.path)[.size] as? Int ?? Int.max <= DistributionReceipt.maximumReceiptBytes else {
            throw InstallerError.invalid("The packaged build manifest is too large.")
        }
        let manifest = try InstallerFiles.read(manifestFile)
        try receipt.verifyManifest(manifest)
        let verified = try verifyPackage(package, expected: manifest)
        let app = package.appendingPathComponent("Mentra.app")
        let config = try InstallerFiles.dictionary(InstallerFiles.read(app.appendingPathComponent("EXConstants.bundle/app.config")))
        let extra = config["extra"] as? [String: Any]
        if let pin = extra?["mentraPrBuild"] {
            guard let pin = pin as? [String: Any], distributionInteger(pin["schemaVersion"]) == 1,
                  pin["otaManifestUrl"] as? String == request.otaURL else { throw InstallerError.invalid("The app contains a different OTA manifest selection.") }
        } else {
            let javascript = try Data(contentsOf: app.appendingPathComponent("main.jsbundle"), options: .mappedIfSafe)
            guard javascript.range(of: Data(request.otaURL.utf8)) != nil else { throw InstallerError.invalid("The app is missing its PR OTA manifest selection.") }
        }
        return verified
    } catch {
        // An unexpectedly live extraction tool must retain its working files.
        if case InstallerError.recovery = error {} else { try? FileManager.default.removeItem(at: staging) }
        throw error
    }
}

/// Call after the verified app has been installed. Only this installer's fresh
/// request directories are eligible; a manually selected download is retained.
func cleanupPackage(_ verified: VerifiedBuild) throws {
    let staging = verified.directory.deletingLastPathComponent().deletingLastPathComponent()
    guard verified.directory.lastPathComponent == "Mentra PR",
          verified.directory.deletingLastPathComponent().lastPathComponent == "extracted",
          staging.deletingLastPathComponent().path == DistributionCache.root.path,
          staging.lastPathComponent.hasPrefix("request-"),
          UUID(uuidString: String(staging.lastPathComponent.dropFirst("request-".count))) != nil else { return }
    try DistributionCache.claim()
    try InstallerFiles.requirePlainTree(staging)
    guard try InstallerFiles.dictionary(InstallerFiles.read(staging.appendingPathComponent("owner.json")))["owner"] as? String == DistributionCache.owner else {
        throw InstallerError.invalid("Refusing to remove an unowned download directory.")
    }
    try FileManager.default.removeItem(at: staging)
}

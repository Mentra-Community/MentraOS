import Foundation
#if os(macOS) || os(iOS)
import CryptoKit
import Darwin

struct NimoMacProcessBirth: Codable, Equatable {
    let seconds: UInt64
    let microseconds: UInt64

}
struct NimoMacFixtureConfiguration: Codable {
    let version: Int
    let ownerPid: Int32
    let ownerAuditToken: String
    let ownerBirth: NimoMacProcessBirth
    let planSha256: String
    let grantSha256: String
    let bootstrapNonce: String
    let appExecutableSha256: String
    let appBundleId: String
}

/// Private, one-owner fixture IPC. Only typed lifecycle operations reach Main.
/// No socket path, packet, host address or connection command is caller supplied.
final class NimoMacResourceTransport {
    let configuration: NimoMacFixtureConfiguration
    private let process: NimoResourceProcess
    private let directory: String
    private let directoryFd: Int32
    private let directoryDevice: UInt64
    private let directoryInode: UInt64
    private let socketFd: Int32
    private let socketPath: String
    private let processAuditToken: String
    private let executableSha256: String
    private let queue = DispatchQueue(label: "NimoResourceFixtureSocket")

    init(process: NimoResourceProcess) throws {
        #if os(iOS)
        guard ProcessInfo.processInfo.isiOSAppOnMac else { throw transportError("fixture-requires-ios-on-mac") }
        #endif
        guard let text = ProcessInfo.processInfo.environment["MENTRA_NIMO_RESOURCE_BOOTSTRAP"], text.utf8.count <= 4096,
              let bytes = text.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == Set(["version","ownerPid","ownerAuditToken","ownerBirth","planSha256","grantSha256","bootstrapNonce","appExecutableSha256","appBundleId"]),
              let birth = object["ownerBirth"] as? [String: Any], Set(birth.keys) == Set(["seconds","microseconds"]) else { throw transportError("invalid-bootstrap") }
        configuration = try JSONDecoder().decode(NimoMacFixtureConfiguration.self, from: bytes)
        guard configuration.version == 1, configuration.ownerPid > 1,
              configuration.ownerPid != process.pid,
              UUID(uuidString: configuration.bootstrapNonce)?.uuidString.lowercased() == configuration.bootstrapNonce,
              [configuration.planSha256, configuration.grantSha256, configuration.appExecutableSha256, configuration.ownerAuditToken].allSatisfy({ $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }),
              Bundle.main.bundleIdentifier == configuration.appBundleId,
              let executable = Bundle.main.executableURL else { throw transportError("bootstrap-identity-mismatch") }
        let executableBytes = try Data(contentsOf: executable, options: [.mappedIfSafe])
        guard executableBytes.count <= 256 * 1024 * 1024 else { throw transportError("executable-budget") }
        executableSha256 = SHA256.hash(data: executableBytes).map { String(format: "%02x", $0) }.joined()
        guard executableSha256 == configuration.appExecutableSha256 else { throw transportError("executable-mismatch") }
        self.process = process; processAuditToken = try nimoOwnAuditToken()
        directory = NSHomeDirectory() + "/tmp/nr-" + configuration.bootstrapNonce.replacingOccurrences(of: "-", with: "").prefix(16)
        // Never reuse another process's directory, socket or receipts.
        guard mkdir(directory, 0o700) == 0 else { throw transportError("fixture-directory-exists-or-unavailable") }
        directoryFd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directoryFd >= 0 else { throw transportError("fixture-directory-open") }
        var info = stat()
        guard fstat(directoryFd, &info) == 0, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700 else { throw transportError("fixture-directory-permissions") }
        directoryDevice = UInt64(info.st_dev); directoryInode = UInt64(info.st_ino)
        socketPath = directory + "/s"
        socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else { throw transportError("fixture-socket-open") }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8) + [0]
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw transportError("fixture-socket-path-budget") }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: pathBytes) }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        address.sun_len = UInt8(length)
        let result = withUnsafePointer(to: &address) { ptr in ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socketFd, $0, length) } }
        guard result == 0, chmod(socketPath, 0o600) == 0, listen(socketFd, 4) == 0 else { throw transportError("fixture-socket-bind") }
        let flags = fcntl(socketFd, F_GETFD); _ = fcntl(socketFd, F_SETFD, flags | FD_CLOEXEC)
        let schedulerQoS: DispatchQoS = .unspecified
        let schedulerFlags = DispatchWorkItemFlags(rawValue: 0)
        enqueueServe(qos: schedulerQoS, flags: schedulerFlags)
    }

    // A narrow scheduling boundary for this transport's original accept loop.
    @inline(never)
    private func enqueueServe(qos: DispatchQoS, flags: DispatchWorkItemFlags) {
        queue.async(group: nil, qos: qos, flags: flags) { [weak self] in self?.serve() }
    }

    private func sameDirectory() -> Bool {
        var byPath = stat(), byFd = stat()
        return lstat(directory, &byPath) == 0 && fstat(directoryFd, &byFd) == 0 &&
            byPath.st_mode & S_IFMT == S_IFDIR && byPath.st_dev == byFd.st_dev && byPath.st_ino == byFd.st_ino &&
            UInt64(byFd.st_dev) == directoryDevice && UInt64(byFd.st_ino) == directoryInode && byFd.st_uid == geteuid() && byFd.st_mode & 0o777 == 0o700
    }

    func persist(_ bytes: Data, nonce: String, kind: String) throws {
        guard sameDirectory(), UUID(uuidString: nonce)?.uuidString.lowercased() == nonce,
              ["intent","receipt","admission","transport"].contains(kind), bytes.count <= 32_768 else { throw transportError("journal-identity-mismatch") }
        let final = "\(nonce).\(kind).json", temp = "\(nonce).\(kind).pending"
        let fd = openat(directoryFd, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw transportError("journal-intent-exists-or-unavailable") }
        defer { close(fd); unlinkat(directoryFd, temp, 0) }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard count > 0 else { throw transportError("journal-write-failed") }; offset += count
            }
        }
        guard fsync(fd) == 0, sameDirectory(), linkat(directoryFd, temp, directoryFd, final, 0) == 0,
              fsync(directoryFd) == 0 else { throw transportError("journal-atomic-publish-failed") }
    }

    private func peerAllowed(_ fd: Int32) -> Bool {
        var peerPid: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
        var uid: uid_t = 0, gid: gid_t = 0
        var token = audit_token_t(), tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
        return getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peerPid, &length) == 0 &&
            length == MemoryLayout<Int32>.size && peerPid == configuration.ownerPid && getpeereid(fd, &uid, &gid) == 0 && uid == geteuid() &&
            getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenLength) == 0 &&
            tokenLength == MemoryLayout<audit_token_t>.size && nimoAuditTokenHex(token) == configuration.ownerAuditToken && sameDirectory()
    }

    private func serve() {
        while true {
            let fd = accept(socketFd, nil, nil)
            if fd < 0 { if errno == EINTR { continue }; return }
            defer { close(fd) }
            guard peerAllowed(fd) else { continue }
            var timeout = timeval(tv_sec: 5, tv_usec: 0)
            _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            var noSignal: Int32 = 1
            _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            var request = Data(), complete = false
            let readDeadline = NimoResourceClock.now() + 5_000
            while request.count <= 16_384, NimoResourceClock.now() < readDeadline {
                var buffer = [UInt8](repeating: 0, count: 1024)
                let count = read(fd, &buffer, buffer.count)
                if count <= 0 { break }
                request.append(contentsOf: buffer.prefix(count))
                if request.contains(10) { complete = true; break }
            }
            guard complete, request.count <= 16_384, request.last == 10, request.dropLast().contains(10) == false,
                  peerAllowed(fd) else { continue }
            do {
                guard let envelope = try JSONSerialization.jsonObject(with: request) as? [String: Any],
                      envelope["bootstrapNonce"] as? String == configuration.bootstrapNonce else { throw transportError("bootstrap-capability-mismatch") }
                let response: Data
                if Set(envelope.keys) == Set(["bootstrapNonce","hello"]), envelope["hello"] as? Bool == true {
                    response = try JSONSerialization.data(withJSONObject: hello(), options: [.sortedKeys])
                } else {
                    guard Set(envelope.keys) == Set(["bootstrapNonce","request"]), let value = envelope["request"] as? [String: Any] else { throw transportError("invalid-envelope") }
                    let canonical = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
                    let semaphore = DispatchSemaphore(value: 0)
                    // Connection execution is serial; parent timeout does not cancel
                    // native cleanup or renew its original operation authority.
                    final class Box: @unchecked Sendable { var result: Result<Data, Error>? }
                    let box = Box()
                    Task { @MainActor in
                        do { box.result = .success(try await NimoResourceFixture.shared.execute(canonical)) }
                        catch { box.result = .failure(error) }
                        semaphore.signal()
                    }
                    semaphore.wait()
                    guard peerAllowed(fd), let result = box.result else { continue }
                    let receipt = try result.get()
                    response = try JSONSerialization.data(withJSONObject: ["receipt": try JSONSerialization.jsonObject(with: receipt)], options: [.sortedKeys])
                }
                send(response + Data([10]), fd)
            } catch {
                let code = String(error.localizedDescription.prefix(160))
                if let bytes = try? JSONSerialization.data(withJSONObject: ["error": code], options: [.sortedKeys]) { send(bytes + Data([10]), fd) }
            }
        }
    }
    private func send(_ data: Data, _ fd: Int32) {
        data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count <= 0 { return }; offset += count
            }
        }
    }
    private func hello() -> [String: Any] {
        ["protocol": "nimo-macos-resource-v1", "process": ["pid": process.pid, "instanceId": process.instanceId],
         "processAuditToken": processAuditToken, "ownerAuditToken": configuration.ownerAuditToken,
         "ownerPid": configuration.ownerPid, "ownerBirth": ["seconds": configuration.ownerBirth.seconds, "microseconds": configuration.ownerBirth.microseconds],
         "executableSha256": executableSha256, "bundleIdentifier": configuration.appBundleId,
         "directory": ["device": directoryDevice, "inode": directoryInode], "socketPath": socketPath]
    }
}
// Audit tokens are opaque kernel identities: never interpret their word layout.
private func nimoAuditTokenHex(_ token: audit_token_t) -> String {
    withUnsafeBytes(of: token) { $0.map { String(format: "%02x", $0) }.joined() }
}
private func nimoOwnAuditToken() throws -> String {
    var token = audit_token_t()
    var count = mach_msg_type_number_t(MemoryLayout<audit_token_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &token) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_AUDIT_TOKEN), $0, &count)
        }
    }
    guard result == KERN_SUCCESS, count == MemoryLayout<audit_token_t>.size / MemoryLayout<integer_t>.size else { throw transportError("process-audit-token-unavailable") }
    return nimoAuditTokenHex(token)
}
private func transportError(_ code: String) -> Error { NSError(domain: "NimoResourceTransport", code: 1, userInfo: [NSLocalizedDescriptionKey: code]) }
#else
struct NimoMacFixtureConfiguration { let planSha256 = "", grantSha256 = "" }
final class NimoMacResourceTransport {
    let configuration = NimoMacFixtureConfiguration()
    init(process: NimoResourceProcess) throws { throw NSError(domain: "NimoResourceFixture", code: 1) }
    func persist(_ bytes: Data, nonce: String, kind: String) throws { throw NSError(domain: "NimoResourceFixture", code: 1) }
}
#endif

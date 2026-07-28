import Darwin
import ExpoModulesCore
import Foundation

public class MentraPhotoReceiverModule: Module {
    private let receiverLock = NSLock()
    private var photoUploadServer: LocalPhotoUploadServer?

    public func definition() -> ModuleDefinition {
        Name("MentraPhotoReceiver")

        Events("photoUpload", "receiverStatus")

        AsyncFunction("isSupported") {
            true
        }

        AsyncFunction("startPhotoReceiver") { () -> [String: Any] in
            try startPhotoReceiver()
        }

        AsyncFunction("stopPhotoReceiver") {
            stopPhotoReceiverInternal()
        }

        OnDestroy {
            stopPhotoReceiverInternal()
        }
    }

    private func startPhotoReceiver() throws -> [String: Any] {
        receiverLock.lock()
        defer { receiverLock.unlock() }

        guard let host = bestLocalIPv4Address() else {
            throw PhotoReceiverError("No Wi-Fi/LAN IPv4 address found for this phone.")
        }

        let server = photoUploadServer ?? LocalPhotoUploadServer(
            onLog: { [weak self] message in
                self?.emitStatus(message: message)
            },
            onUpload: { [weak self] upload in
                self?.handlePhotoUpload(upload)
            }
        )
        photoUploadServer = server

        if let activePort = server.activePort {
            let uploadUrl = "http://\(host):\(activePort)/upload"
            LocalPhotoReceiverRegistry.register(uploadUrl)
            emitStatus(message: "Photo receiver ready at \(uploadUrl)")
            return receiverResult(uploadUrl: uploadUrl, host: host, port: activePort)
        }

        var lastError: Error?
        for port in photoPorts {
            do {
                let actualPort = try server.start(port: UInt16(port))
                let uploadUrl = "http://\(host):\(actualPort)/upload"
                LocalPhotoReceiverRegistry.register(uploadUrl)
                emitStatus(message: "Photo receiver ready at \(uploadUrl)")
                return receiverResult(uploadUrl: uploadUrl, host: host, port: actualPort)
            } catch {
                lastError = error
                emitStatus(message: "Port \(port) unavailable: \(error.localizedDescription)")
            }
        }

        throw PhotoReceiverError(
            "Could not start phone photo receiver: \(lastError?.localizedDescription ?? "all ports unavailable")"
        )
    }

    private func stopPhotoReceiverInternal() {
        receiverLock.lock()
        defer { receiverLock.unlock() }

        LocalPhotoReceiverRegistry.unregister()
        photoUploadServer?.stop()
        emitStatus(message: "Photo receiver stopped")
    }

    private func handlePhotoUpload(_ upload: PhotoUpload) {
        BleTraceLogger.logMap(
            direction: "phone_to_app",
            layer: "photo_receiver_event",
            type: "photo_upload",
            payload: [
                "requestId": upload.requestId ?? "",
                "fileName": upload.photoFile.lastPathComponent,
                "byteCount": upload.byteCount,
            ]
        )
        sendEvent("photoUpload", [
            "requestId": upload.requestId as Any,
            "fileUri": upload.photoFile.absoluteString,
            "byteCount": upload.byteCount,
        ])
        emitStatus(message: "Photo uploaded (\(upload.byteCount) bytes)")
    }

    private func emitStatus(message: String) {
        NSLog("[MentraPhotoReceiver] %@", message)
        sendEvent("receiverStatus", [
            "message": message,
        ])
    }

    private func bestLocalIPv4Address() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else {
            return nil
        }
        defer { freeifaddrs(interfaces) }

        var preferredPrivate: String?
        var preferred: String?
        var privateFallback: String?
        var fallback: String?
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let interface = current.pointee
            guard let addressPointer = interface.ifa_addr,
                  addressPointer.pointee.sa_family == UInt8(AF_INET)
            else {
                continue
            }

            let name = String(cString: interface.ifa_name)
            let flags = interface.ifa_flags
            guard (flags & UInt32(IFF_UP)) != 0,
                  (flags & UInt32(IFF_LOOPBACK)) == 0
            else {
                continue
            }

            var address = addressPointer.pointee
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &address,
                socklen_t(address.sa_len),
                &hostname,
                socklen_t(hostname.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else {
                continue
            }

            let ip = String(cString: hostname)
            guard ip != "127.0.0.1", !isLinkLocalIPv4(ip) else {
                continue
            }
            if isPreferredLocalInterface(name), isPrivateIPv4(ip) {
                preferredPrivate = preferredPrivate ?? ip
            } else if isPreferredLocalInterface(name) {
                preferred = preferred ?? ip
            } else if isPrivateIPv4(ip) {
                privateFallback = privateFallback ?? ip
            } else {
                fallback = fallback ?? ip
            }
        }

        return preferredPrivate ?? preferred ?? privateFallback ?? fallback
    }

    private func receiverResult(uploadUrl: String, host: String, port: UInt16) -> [String: Any] {
        [
            "uploadUrl": uploadUrl,
            "host": host,
            "port": port,
        ]
    }

    private func isPreferredLocalInterface(_ name: String) -> Bool {
        name == "en0" ||
            name.hasPrefix("bridge") ||
            name.hasPrefix("ap") ||
            name.hasPrefix("awdl") ||
            name.hasPrefix("llw")
    }

    private func isPrivateIPv4(_ ip: String) -> Bool {
        if ip.hasPrefix("192.168.") || ip.hasPrefix("10.") {
            return true
        }
        let parts = ip.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 172 && (16 ... 31).contains(parts[1])
    }

    private func isLinkLocalIPv4(_ ip: String) -> Bool {
        ip.hasPrefix("169.254.")
    }

    private let photoPorts = [8787, 8788, 8789, 8790]
}

final class PhotoReceiverError: Exception, @unchecked Sendable {
    private let message: String

    init(_ message: String) {
        self.message = message
        super.init()
    }

    override var reason: String {
        message
    }
}

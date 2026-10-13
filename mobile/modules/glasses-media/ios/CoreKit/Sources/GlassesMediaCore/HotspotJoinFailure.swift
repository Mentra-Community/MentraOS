import Foundation

/// Explicit bridge facts; never forward native userInfo or arbitrary NSError descriptions.
public struct HotspotJoinFailure {
    public let code: String
    public let message: String

    public init(_ error: Error) {
        if error is CancellationError || (error as? LocalMediaError)?.message == "Hotspot join cancelled" {
            code = "ERR_HOTSPOT_CANCELLED"
            message = "Hotspot join cancelled"
        } else if let local = error as? LocalMediaError {
            code = "ERR_HOTSPOT_JOIN"
            // These messages are authored by the owned hotspot implementation, not NSError.
            message = String(local.message.filter { !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }.prefix(512))
        } else {
            code = "ERR_HOTSPOT_NATIVE"
            let native = error as NSError
            let domain = native.domain.range(of: "^[A-Za-z0-9_.-]{1,128}$", options: .regularExpression) == nil ? "unavailable" : native.domain
            message = "Hotspot join failed (\(domain), \(native.code))"
        }
    }
}

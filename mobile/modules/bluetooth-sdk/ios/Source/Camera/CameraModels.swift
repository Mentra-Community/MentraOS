import Foundation

public enum PhotoSize: String {
    case small
    case medium
    case large
    case full
}

public enum ButtonPhotoSize: String {
    case small
    case medium
    case large
}

public enum PhotoCompression: String {
    case none
    case medium
    case heavy
}

public struct ButtonPhotoSettings {
    public let size: ButtonPhotoSize

    public init(size: ButtonPhotoSize) {
        self.size = size
    }
}

public struct ButtonVideoRecordingSettings {
    public let width: Int
    public let height: Int
    public let fps: Int

    public init(width: Int, height: Int, fps: Int) {
        self.width = width
        self.height = height
        self.fps = fps
    }
}

public struct CameraFov {
    public static let minFov = 82
    public static let maxFov = 118
    public static let defaultFov = 102
    public static let minRoiPosition = 0
    public static let maxRoiPosition = 2
    public static let defaultRoiPosition = 0

    public let fov: Int
    public let roiPosition: Int

    public init(fov: Int = CameraFov.defaultFov, roiPosition: Int = CameraFov.defaultRoiPosition) {
        self.fov = min(max(fov, CameraFov.minFov), CameraFov.maxFov)
        self.roiPosition = min(max(roiPosition, CameraFov.minRoiPosition), CameraFov.maxRoiPosition)
    }

    var value: [String: Int] {
        ["fov": fov, "roi_position": roiPosition]
    }
}

public struct PhotoRequest {
    public let requestId: String
    public let appId: String
    public let size: PhotoSize
    public let webhookUrl: String?
    public let authToken: String?
    public let compress: PhotoCompression?
    public let flash: Bool
    public let sound: Bool
    /// Sensor exposure time for this capture only (ns), or nil for auto exposure
    public let exposureTimeNs: Double?
    /// Sensor ISO for this capture only. Only used when exposureTimeNs enables manual exposure.
    public let iso: Int?

    public init(
        requestId: String,
        appId: String,
        size: PhotoSize,
        webhookUrl: String? = nil,
        authToken: String? = nil,
        compress: PhotoCompression? = nil,
        flash: Bool = true,
        sound: Bool,
        exposureTimeNs: Double? = nil,
        iso: Int? = nil
    ) {
        self.requestId = requestId
        self.appId = appId
        self.size = size
        self.webhookUrl = webhookUrl
        self.authToken = authToken
        self.compress = compress
        self.flash = flash
        self.sound = sound
        self.exposureTimeNs = exposureTimeNs
        self.iso = iso
    }
}

public enum RgbLedAction: String {
    case on
    case off
}

public enum RgbLedColor: String {
    case red
    case green
    case blue
    case orange
    case white
}

public struct RgbLedRequest {
    public let requestId: String
    public let packageName: String?
    public let action: RgbLedAction
    public let color: RgbLedColor?
    public let onDurationMs: Int
    public let offDurationMs: Int
    public let count: Int

    public init(
        requestId: String,
        packageName: String?,
        action: RgbLedAction,
        color: RgbLedColor?,
        onDurationMs: Int,
        offDurationMs: Int,
        count: Int
    ) {
        self.requestId = requestId
        self.packageName = packageName
        self.action = action
        self.color = color
        self.onDurationMs = onDurationMs
        self.offDurationMs = offDurationMs
        self.count = count
    }
}

public struct VideoRecordingRequest {
    public let requestId: String
    public let save: Bool
    public let sound: Bool

    public init(requestId: String, save: Bool, sound: Bool) {
        self.requestId = requestId
        self.save = save
        self.sound = sound
    }
}

public enum PhotoResponse: CustomStringConvertible, Equatable {
    public enum State: String {
        case success
        case error
    }

    case success(requestId: String, uploadUrl: String, timestamp: Int)
    case error(requestId: String, errorCode: String?, errorMessage: String, timestamp: Int)

    public init(values: [String: Any]) {
        let requestId = stringValue(values, "requestId") ?? ""
        let timestamp = intValue(values["timestamp"]) ?? Int(Date().timeIntervalSince1970 * 1000)
        let state = stringValue(values, "state")?.lowercased()
        if state == State.success.rawValue {
            self = .success(
                requestId: requestId,
                uploadUrl: stringValue(values, "uploadUrl") ?? "",
                timestamp: timestamp
            )
        } else {
            self = .error(
                requestId: requestId,
                errorCode: stringValue(values, "errorCode"),
                errorMessage: stringValue(values, "errorMessage") ?? "Unknown photo error",
                timestamp: timestamp
            )
        }
    }

    public var state: State {
        switch self {
        case .success:
            .success
        case .error:
            .error
        }
    }

    public var requestId: String {
        switch self {
        case let .success(requestId, _, _), let .error(requestId, _, _, _):
            requestId
        }
    }

    public var timestamp: Int {
        switch self {
        case let .success(_, _, timestamp), let .error(_, _, _, timestamp):
            timestamp
        }
    }

    public var values: [String: Any] {
        switch self {
        case let .success(requestId, uploadUrl, timestamp):
            return [
                "state": State.success.rawValue,
                "requestId": requestId,
                "uploadUrl": uploadUrl,
                "timestamp": timestamp,
            ]
        case let .error(requestId, errorCode, errorMessage, timestamp):
            var values: [String: Any] = [
                "state": State.error.rawValue,
                "requestId": requestId,
                "errorMessage": errorMessage,
                "timestamp": timestamp,
            ]
            if let errorCode, !errorCode.isEmpty {
                values["errorCode"] = errorCode
            }
            return values
        }
    }

    public var description: String {
        "PhotoResponse(requestId: \(requestId), state: \(state.rawValue))"
    }
}

public struct PhotoResponseEvent: CustomStringConvertible {
    public let response: PhotoResponse

    public init(response: PhotoResponse) {
        self.response = response
    }

    public init(values: [String: Any]) {
        response = PhotoResponse(values: values)
    }

    public var requestId: String {
        response.requestId
    }

    public var values: [String: Any] {
        var values = response.values
        values["type"] = "photo_response"
        return values
    }

    public var description: String {
        "PhotoResponseEvent(requestId: \(requestId), state: \(response.state.rawValue))"
    }
}

public struct PhotoStatusEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        var values = values
        values["type"] = "photo_status"
        self.values = values
    }

    public var requestId: String {
        stringValue(values, "requestId") ?? ""
    }

    public var status: String {
        stringValue(values, "status") ?? ""
    }

    public var timestamp: Int64 {
        if let value = values["timestamp"] as? Int64 { return value }
        if let value = values["timestamp"] as? Int { return Int64(value) }
        if let value = values["timestamp"] as? Double { return Int64(value) }
        if let value = values["timestamp"] as? NSNumber { return value.int64Value }
        return Int64(Date().timeIntervalSince1970 * 1000)
    }

    public var resolvedConfig: [String: Any]? {
        values["resolvedConfig"] as? [String: Any]
    }

    public var requestedCaptureConfig: [String: Any]? {
        values["requestedCaptureConfig"] as? [String: Any]
    }

    public var meteredPreview: [String: Any]? {
        values["meteredPreview"] as? [String: Any]
    }

    public var captureMetadata: [String: Any]? {
        values["captureMetadata"] as? [String: Any]
    }

    public var errorCode: String? {
        stringValue(values, "errorCode")
    }

    public var errorMessage: String? {
        stringValue(values, "errorMessage")
    }

    public var description: String {
        "PhotoStatusEvent(requestId: \(requestId), status: \(status))"
    }
}

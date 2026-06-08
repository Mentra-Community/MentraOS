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

public enum CameraRoiPosition: Int {
    case center = 0
    case bottom = 1
    case top = 2

    public var label: String {
        switch self {
        case .center:
            return "center"
        case .bottom:
            return "bottom"
        case .top:
            return "top"
        }
    }

    public static func from(rawValue: Int?) -> CameraRoiPosition {
        guard let rawValue else {
            return .center
        }
        return CameraRoiPosition(rawValue: rawValue) ?? .center
    }
}

public struct CameraFov {
    public static let minFov = 62
    public static let maxFov = 118
    public static let defaultFov = 102
    public static let narrowFov = 82
    public static let defaultRoiPosition = CameraRoiPosition.center
    public static let narrow = CameraFov(
        fov: CameraFov.narrowFov,
        roiPosition: CameraFov.defaultRoiPosition
    )
    public static let standard = CameraFov(
        fov: CameraFov.defaultFov,
        roiPosition: CameraFov.defaultRoiPosition
    )
    public static let wide = CameraFov(
        fov: CameraFov.maxFov,
        roiPosition: CameraFov.defaultRoiPosition
    )

    public let fov: Int
    public let roiPosition: CameraRoiPosition

    public init(fov: Int = CameraFov.defaultFov, roiPosition: CameraRoiPosition = CameraFov.defaultRoiPosition) {
        self.fov = min(max(fov, CameraFov.minFov), CameraFov.maxFov)
        self.roiPosition = roiPosition
    }

    var value: [String: Int] {
        ["fov": fov, "roi_position": roiPosition.rawValue]
    }
}

public struct CameraFovResult: CustomStringConvertible {
    public let requestId: String
    public let fov: Int
    public let roiPosition: CameraRoiPosition
    public let timestamp: Int

    public var values: [String: Any] {
        [
            "requestId": requestId,
            "fov": fov,
            "roiPosition": roiPosition.label,
            "timestamp": timestamp,
        ]
    }

    public var description: String {
        "CameraFovResult(fov: \(fov), roiPosition: \(roiPosition.label))"
    }

    static func from(ack: SettingsAckEvent, fallback: CameraFov) throws -> CameraFovResult {
        if ack.status == "error" {
            throw BluetoothError(
                code: ack.errorCode ?? "camera_fov_failed",
                message: ack.errorMessage ?? "Camera FOV request failed."
            )
        }
        if !ack.hardwareApplied {
            throw BluetoothError(
                code: "camera_fov_not_applied",
                message: "Camera FOV was saved but not applied to hardware."
            )
        }

        return CameraFovResult(
            requestId: ack.requestId,
            fov: ack.fov ?? fallback.fov,
            roiPosition: CameraRoiPosition.from(rawValue: ack.roiPosition ?? fallback.roiPosition.rawValue),
            timestamp: ack.timestamp
        )
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
    public let save: Bool
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
        save: Bool = false,
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
        self.save = save
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
    // Optional per-recording overrides; 0 means "use the saved button-video default".
    public let width: Int
    public let height: Int
    public let fps: Int

    public init(
        requestId: String, save: Bool, sound: Bool, width: Int = 0, height: Int = 0, fps: Int = 0
    ) {
        self.requestId = requestId
        self.save = save
        self.sound = sound
        self.width = width
        self.height = height
        self.fps = fps
    }
}

public struct VideoRecordingStatusEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        var values = values
        values["type"] = "video_recording_status"
        self.values = values
    }

    public var requestId: String {
        stringValue(values, "requestId") ?? ""
    }

    public var success: Bool {
        boolValue(values, "success") ?? false
    }

    public var status: String {
        stringValue(values, "status") ?? ""
    }

    public var details: String? {
        stringValue(values, "details")
    }

    public var timestamp: Int {
        intValue(values["timestamp"]) ?? Int(Date().timeIntervalSince1970 * 1000)
    }

    public var data: [String: Any]? {
        values["data"] as? [String: Any]
    }

    public var description: String {
        "VideoRecordingStatusEvent(requestId: \(requestId), status: \(status), success: \(success))"
    }
}

public enum PhotoResponse: CustomStringConvertible, Equatable {
    public enum State: String {
        case success
        case error
    }

    case success(
        requestId: String,
        uploadUrl: String,
        photoUrl: String?,
        statusUrl: String?,
        contentType: String?,
        fileSizeBytes: Int?,
        timestamp: Int
    )
    case error(requestId: String, errorCode: String?, errorMessage: String, timestamp: Int)

    public init(values: [String: Any]) {
        let requestId = stringValue(values, "requestId") ?? ""
        let timestamp = intValue(values["timestamp"]) ?? Int(Date().timeIntervalSince1970 * 1000)
        let state = stringValue(values, "state")?.lowercased()
        let success = state == State.success.rawValue || boolValue(values, "success") == true
        if success {
            self = .success(
                requestId: requestId,
                uploadUrl: stringValue(values, "uploadUrl") ?? "",
                photoUrl: stringValue(values, "photoUrl"),
                statusUrl: stringValue(values, "statusUrl"),
                contentType: stringValue(values, "contentType") ?? stringValue(values, "mimeType"),
                fileSizeBytes: intValue(values["fileSizeBytes"]) ?? intValue(values["bytes"])
                    ?? intValue(values["size"]),
                timestamp: timestamp
            )
        } else {
            self = .error(
                requestId: requestId,
                errorCode: stringValue(values, "errorCode"),
                errorMessage: stringValue(values, "errorMessage") ?? stringValue(values, "error")
                    ?? "Unknown photo error",
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
        case let .success(requestId, _, _, _, _, _, _), let .error(requestId, _, _, _):
            requestId
        }
    }

    public var timestamp: Int {
        switch self {
        case let .success(_, _, _, _, _, _, timestamp), let .error(_, _, _, timestamp):
            timestamp
        }
    }

    public var values: [String: Any] {
        switch self {
        case let .success(requestId, uploadUrl, photoUrl, statusUrl, contentType, fileSizeBytes, timestamp):
            var values: [String: Any] = [
                "state": State.success.rawValue,
                "requestId": requestId,
                "uploadUrl": uploadUrl,
                "timestamp": timestamp,
            ]
            if let photoUrl, !photoUrl.isEmpty {
                values["photoUrl"] = photoUrl
            }
            if let statusUrl, !statusUrl.isEmpty {
                values["statusUrl"] = statusUrl
            }
            if let contentType, !contentType.isEmpty {
                values["contentType"] = contentType
            }
            if let fileSizeBytes {
                values["fileSizeBytes"] = fileSizeBytes
            }
            return values
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

public struct GalleryStatusEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        var values = values
        values["type"] = "gallery_status"
        self.values = values
    }

    public var photos: Int {
        intValue(values["photos"]) ?? 0
    }

    public var videos: Int {
        intValue(values["videos"]) ?? 0
    }

    public var total: Int {
        intValue(values["total"]) ?? 0
    }

    public var totalSize: Int? {
        intValue(values["totalSize"]) ?? intValue(values["total_size"])
    }

    public var hasContent: Bool {
        boolValue(values, "hasContent", "has_content") ?? false
    }

    public var cameraBusy: Bool {
        boolValue(values, "cameraBusy", "camera_busy") ?? false
    }

    public var cameraBusyReason: String? {
        stringValue(values, "cameraBusyReason", "camera_busy")
    }

    public var description: String {
        "GalleryStatusEvent(total: \(total), photos: \(photos), videos: \(videos))"
    }
}

import Foundation

public enum PhotoSize: String {
    case low
    case medium
    case high
    case max

    public static func normalizeLegacy(_ value: String?) -> String {
        switch value {
        case "small":
            return PhotoSize.low.rawValue
        case "large":
            return PhotoSize.high.rawValue
        case "full":
            return PhotoSize.max.rawValue
        default:
            return value ?? PhotoSize.medium.rawValue
        }
    }

    public init(normalizedRawValue value: String?) {
        let normalized = PhotoSize.normalizeLegacy(value)
        self = PhotoSize(rawValue: normalized) ?? .medium
    }
}

public enum ButtonPhotoSize: String {
    case low
    case medium
    case high
    case max

    public static func normalizeLegacy(_ value: String?) -> String {
        PhotoSize.normalizeLegacy(value)
    }

    public init(normalizedRawValue value: String?) {
        let normalized = ButtonPhotoSize.normalizeLegacy(value)
        self = ButtonPhotoSize(rawValue: normalized) ?? .medium
    }
}

public enum PhotoCompression: String {
    case none
    case medium
    case heavy
}

public struct ButtonPhotoSettings {
    public let size: ButtonPhotoSize?
    public let mfnr: Bool?
    public let zsl: Bool?
    public let noiseReduction: Bool?
    public let edgeEnhancement: Bool?
    public let ispDigitalGain: Int?
    public let ispAnalogGain: String?
    public let aeExposureDivisor: Int?
    public let isoCap: Int?
    public let compress: String?
    public let sound: Bool?
    public let resetCaptureTuning: Bool?

    public init(
        size: ButtonPhotoSize?,
        mfnr: Bool? = nil,
        zsl: Bool? = nil,
        noiseReduction: Bool? = nil,
        edgeEnhancement: Bool? = nil,
        ispDigitalGain: Int? = nil,
        ispAnalogGain: String? = nil,
        aeExposureDivisor: Int? = nil,
        isoCap: Int? = nil,
        compress: String? = nil,
        sound: Bool? = nil,
        resetCaptureTuning: Bool? = nil
    ) {
        self.size = size
        self.mfnr = mfnr
        self.zsl = zsl
        self.noiseReduction = noiseReduction
        self.edgeEnhancement = edgeEnhancement
        self.ispDigitalGain = ispDigitalGain
        self.ispAnalogGain = ispAnalogGain
        self.aeExposureDivisor = aeExposureDivisor
        self.isoCap = isoCap
        self.compress = compress
        self.sound = sound
        self.resetCaptureTuning = resetCaptureTuning
    }

    static func from(params: [String: Any]) -> ButtonPhotoSettings {
        let size = (params["size"] as? String).map { ButtonPhotoSize(normalizedRawValue: $0) }
        let aeExposureDivisor =
            optionalIntValue(params, "aeExposureDivisor").flatMap { $0 > 1 ? $0 : nil }
        let isoCap = optionalIntValue(params, "isoCap").flatMap { $0 > 0 ? $0 : nil }
        return ButtonPhotoSettings(
            size: size,
            mfnr: optionalBoolValue(params, "mfnr"),
            zsl: optionalBoolValue(params, "zsl"),
            noiseReduction: optionalBoolValue(params, "noiseReduction"),
            edgeEnhancement: optionalBoolValue(params, "edgeEnhancement"),
            ispDigitalGain: optionalIntValue(params, "ispDigitalGain"),
            ispAnalogGain: optionalStringValue(params, "ispAnalogGain"),
            aeExposureDivisor: aeExposureDivisor,
            isoCap: isoCap,
            compress: optionalStringValue(params, "compress"),
            sound: optionalBoolValue(params, "sound"),
            resetCaptureTuning: optionalBoolValue(params, "resetCaptureTuning")
        )
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
    public let aeExposureDivisor: Int?
    public let isoCap: Int?
    public let noiseReduction: Bool?
    public let edgeEnhancement: Bool?
    public let mfnr: Bool?
    public let zsl: Bool?
    public let ispDigitalGain: Int?
    public let ispAnalogGain: String?

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
        iso: Int? = nil,
        aeExposureDivisor: Int? = nil,
        isoCap: Int? = nil,
        noiseReduction: Bool? = nil,
        edgeEnhancement: Bool? = nil,
        mfnr: Bool? = nil,
        zsl: Bool? = nil,
        ispDigitalGain: Int? = nil,
        ispAnalogGain: String? = nil
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
        self.aeExposureDivisor = aeExposureDivisor
        self.isoCap = isoCap
        self.noiseReduction = noiseReduction
        self.edgeEnhancement = edgeEnhancement
        self.mfnr = mfnr
        self.zsl = zsl
        self.ispDigitalGain = ispDigitalGain
        self.ispAnalogGain = ispAnalogGain
    }

    public static func from(params: [String: Any]) -> PhotoRequest {
        let sizeRaw = params["size"] as? String ?? "medium"
        let compressRaw = params["compress"] as? String ?? "none"
        let exposureTimeNs: Double?
        switch params["exposureTimeNs"] {
        case let value as Double:
            exposureTimeNs = value.isFinite && value > 0 ? value : nil
        case let value as Int:
            exposureTimeNs = value > 0 ? Double(value) : nil
        case let value as NSNumber:
            let d = value.doubleValue
            exposureTimeNs = d.isFinite && d > 0 ? d : nil
        default:
            exposureTimeNs = nil
        }
        let iso: Int?
        switch params["iso"] {
        case let value as Int:
            iso = value > 0 ? value : nil
        case let value as Double:
            iso = value.isFinite && value > 0 && value < Double(Int.max) ? Int(value) : nil
        case let value as NSNumber:
            let intValue = value.intValue
            iso = intValue > 0 ? intValue : nil
        default:
            iso = nil
        }
        func optionalInt(_ key: String, min: Int = Int.min, filter: (Int) -> Bool = { _ in true }) -> Int? {
            guard params.keys.contains(key) else { return nil }
            switch params[key] {
            case let value as Int:
                return filter(value) ? value : nil
            case let value as Double:
                guard value.isFinite, value >= Double(min) else { return nil }
                return filter(Int(value)) ? Int(value) : nil
            case let value as NSNumber:
                let intValue = value.intValue
                return filter(intValue) ? intValue : nil
            default:
                return nil
            }
        }
        func optionalBool(_ key: String) -> Bool? {
            guard params.keys.contains(key) else { return nil }
            return params[key] as? Bool
        }

        return PhotoRequest(
            requestId: params["requestId"] as? String ?? "",
            appId: params["appId"] as? String ?? "",
            size: PhotoSize(normalizedRawValue: sizeRaw),
            webhookUrl: params["webhookUrl"] as? String,
            authToken: (params["authToken"] as? String)?.nilIfBlank,
            compress: PhotoCompression(rawValue: compressRaw),
            flash: params["flash"] as? Bool ?? true,
            save: (params["save"] as? Bool) ?? (params["saveToGallery"] as? Bool) ?? false,
            sound: params["sound"] as? Bool ?? true,
            exposureTimeNs: exposureTimeNs,
            iso: iso,
            aeExposureDivisor: optionalInt("aeExposureDivisor", min: 2) { $0 > 1 },
            isoCap: optionalInt("isoCap", min: 1) { $0 > 0 },
            noiseReduction: optionalBool("noiseReduction"),
            edgeEnhancement: optionalBool("edgeEnhancement"),
            mfnr: optionalBool("mfnr"),
            zsl: optionalBool("zsl"),
            ispDigitalGain: optionalInt("ispDigitalGain"),
            ispAnalogGain: params["ispAnalogGain"] as? String
        )
    }

    func appendScanFields(to json: inout [String: Any]) {
        if let aeExposureDivisor {
            json["aeExposureDivisor"] = aeExposureDivisor
        }
        if let isoCap {
            json["isoCap"] = isoCap
        }
        if let noiseReduction {
            json["noiseReduction"] = noiseReduction
        }
        if let edgeEnhancement {
            json["edgeEnhancement"] = edgeEnhancement
        }
        if let mfnr {
            json["mfnr"] = mfnr
        }
        if let zsl {
            json["zsl"] = zsl
        }
        if let ispDigitalGain {
            json["ispDigitalGain"] = ispDigitalGain
        }
        if let ispAnalogGain {
            json["ispAnalogGain"] = ispAnalogGain
        }
    }
}

private extension String {
    var nilIfBlank: String? {
        isEmpty ? nil : self
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
    // Optional auto-stop timer in minutes; 0 = record until stopped/interrupted.
    public let maxRecordingTimeMinutes: Int

    public init(
        requestId: String, save: Bool, sound: Bool, width: Int = 0, height: Int = 0, fps: Int = 0,
        maxRecordingTimeMinutes: Int = 0
    ) {
        self.requestId = requestId
        self.save = save
        self.sound = sound
        self.width = width
        self.height = height
        self.fps = fps
        self.maxRecordingTimeMinutes = maxRecordingTimeMinutes
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

public struct MediaUploadEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var type: String {
        stringValue(values, "type") ?? ""
    }

    public var requestId: String {
        stringValue(values, "requestId") ?? ""
    }

    public var mediaUrl: String? {
        stringValue(values, "mediaUrl")
    }

    public var errorMessage: String? {
        stringValue(values, "errorMessage")
    }

    public var mediaType: Int? {
        intValue(values["mediaType"])
    }

    public var timestamp: Int {
        intValue(values["timestamp"]) ?? Int(Date().timeIntervalSince1970 * 1000)
    }

    public var isSuccess: Bool {
        type == "media_success"
    }

    public var isVideo: Bool {
        mediaType == 2
    }

    public var description: String {
        "MediaUploadEvent(requestId: \(requestId), type: \(type), mediaType: \(mediaType ?? -1))"
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

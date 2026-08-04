import Foundation

public enum MicPreference: String {
    case auto
    case phone
    case glasses
    case bluetooth
}

public struct LocalTranscriptionEvent: CustomStringConvertible {
    public let text: String
    public let isFinal: Bool
    public let values: [String: Any]

    public init(text: String, isFinal: Bool, values: [String: Any]) {
        self.text = text
        self.isFinal = isFinal
        self.values = values
    }

    public var description: String {
        "LocalTranscriptionEvent(text: \(text), isFinal: \(isFinal))"
    }
}

public struct MicPcmEvent: CustomStringConvertible {
    public static let sampleRate = 16000
    public static let bitsPerSample = 16
    public static let channels = 1
    public static let encoding = "pcm_s16le"

    public let pcm: Data
    public let sampleRate: Int
    public let bitsPerSample: Int
    public let channels: Int
    public let encoding: String
    public let voiceActivityDetectionEnabled: Bool
    public let values: [String: Any]

    public init(values: [String: Any]) {
        let pcm = values["pcm"] as? Data ?? Data()
        let sampleRate = intValue(values["sampleRate"]) ?? Self.sampleRate
        let bitsPerSample = intValue(values["bitsPerSample"]) ?? Self.bitsPerSample
        let channels = intValue(values["channels"]) ?? Self.channels
        let encoding = values["encoding"] as? String ?? Self.encoding
        let voiceActivityDetectionEnabled =
            boolValue(values, "voiceActivityDetectionEnabled") ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled

        var normalized = values
        normalized["type"] = "mic_pcm"
        normalized["pcm"] = pcm
        normalized["sampleRate"] = sampleRate
        normalized["bitsPerSample"] = bitsPerSample
        normalized["channels"] = channels
        normalized["encoding"] = encoding
        normalized["voiceActivityDetectionEnabled"] = voiceActivityDetectionEnabled

        self.pcm = pcm
        self.sampleRate = sampleRate
        self.bitsPerSample = bitsPerSample
        self.channels = channels
        self.encoding = encoding
        self.voiceActivityDetectionEnabled = voiceActivityDetectionEnabled
        self.values = normalized
    }

    public var description: String {
        "MicPcmEvent(bytes: \(pcm.count), sampleRate: \(sampleRate), bitsPerSample: \(bitsPerSample), channels: \(channels), encoding: \(encoding), voiceActivityDetectionEnabled: \(voiceActivityDetectionEnabled))"
    }
}

public struct MicLc3Event: CustomStringConvertible {
    public static let sampleRate = 16000
    public static let channels = 1
    public static let encoding = "lc3"
    public static let frameDurationMs = 10
    public static let defaultFrameSizeBytes = 60

    public let lc3: Data
    public let sampleRate: Int
    public let channels: Int
    public let encoding: String
    public let frameDurationMs: Int
    public let frameSizeBytes: Int
    public let bitrate: Int
    public let packetizedFromGlasses: Bool
    public let voiceActivityDetectionEnabled: Bool
    public let values: [String: Any]

    public init(values: [String: Any]) {
        let lc3 = values["lc3"] as? Data ?? Data()
        let sampleRate = intValue(values["sampleRate"]) ?? Self.sampleRate
        let channels = intValue(values["channels"]) ?? Self.channels
        let encoding = values["encoding"] as? String ?? Self.encoding
        let frameDurationMs = intValue(values["frameDurationMs"]) ?? Self.frameDurationMs
        let frameSizeBytes = intValue(values["frameSizeBytes"]) ?? Self.defaultFrameSizeBytes
        let bitrate = intValue(values["bitrate"]) ?? frameSizeBytes * 8 * (1000 / frameDurationMs)
        let packetizedFromGlasses = boolValue(values, "packetizedFromGlasses") ?? false
        let voiceActivityDetectionEnabled =
            boolValue(values, "voiceActivityDetectionEnabled") ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled

        var normalized = values
        normalized["type"] = "mic_lc3"
        normalized["lc3"] = lc3
        normalized["sampleRate"] = sampleRate
        normalized["channels"] = channels
        normalized["encoding"] = encoding
        normalized["frameDurationMs"] = frameDurationMs
        normalized["frameSizeBytes"] = frameSizeBytes
        normalized["bitrate"] = bitrate
        normalized["packetizedFromGlasses"] = packetizedFromGlasses
        normalized["voiceActivityDetectionEnabled"] = voiceActivityDetectionEnabled

        self.lc3 = lc3
        self.sampleRate = sampleRate
        self.channels = channels
        self.encoding = encoding
        self.frameDurationMs = frameDurationMs
        self.frameSizeBytes = frameSizeBytes
        self.bitrate = bitrate
        self.packetizedFromGlasses = packetizedFromGlasses
        self.voiceActivityDetectionEnabled = voiceActivityDetectionEnabled
        self.values = normalized
    }

    public var description: String {
        "MicLc3Event(bytes: \(lc3.count), sampleRate: \(sampleRate), channels: \(channels), frameDurationMs: \(frameDurationMs), frameSizeBytes: \(frameSizeBytes), bitrate: \(bitrate), packetizedFromGlasses: \(packetizedFromGlasses), voiceActivityDetectionEnabled: \(voiceActivityDetectionEnabled))"
    }
}

public struct GlassesMediaVolumeGetResult: CustomStringConvertible {
    public let level: Int?
    public let statusCode: Int?
    public let values: [String: Any]

    public init(values: [String: Any]) {
        level = intValue(values["level"])
        statusCode = intValue(values["statusCode"])
        self.values = values
    }

    public var description: String {
        let levelText = level.map(String.init) ?? "unknown"
        let statusCodeText = statusCode.map(String.init) ?? "unknown"
        return "GlassesMediaVolumeGetResult(level: \(levelText), statusCode: \(statusCodeText))"
    }
}

public struct GlassesMediaVolumeSetResult: CustomStringConvertible {
    public let statusCode: Int?
    public let values: [String: Any]

    public init(values: [String: Any]) {
        statusCode = intValue(values["statusCode"])
        self.values = values
    }

    public var description: String {
        "GlassesMediaVolumeSetResult(statusCode: \(statusCode.map(String.init) ?? "unknown"))"
    }
}

import Foundation

public struct ButtonPressEvent: CustomStringConvertible {
    public let buttonId: String
    public let pressType: String
    public let timestamp: Int?

    public init(buttonId: String, pressType: String, timestamp: Int? = nil) {
        self.buttonId = buttonId
        self.pressType = pressType
        self.timestamp = timestamp
    }

    public var description: String {
        "ButtonPressEvent(buttonId: \(buttonId), pressType: \(pressType))"
    }
}

public struct TouchEvent: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var deviceModel: String? {
        stringValue(values, "deviceModel")
    }

    public var gestureName: String? {
        stringValue(values, "gestureName")
    }

    public var timestamp: Int? {
        intValue(values["timestamp"])
    }

    public var isSwipe: Bool {
        gestureName?.localizedCaseInsensitiveContains("swipe") == true
    }

    public var description: String {
        "TouchEvent(gestureName: \(gestureName ?? "unknown"))"
    }
}

public struct VoiceActivityDetectionStatusEvent: CustomStringConvertible {
    public let voiceActivityDetectionEnabled: Bool
    public let values: [String: Any]

    public init(values: [String: Any]) {
        voiceActivityDetectionEnabled = boolValue(values, "voiceActivityDetectionEnabled") ?? true
        self.values = values
    }

    public var description: String {
        "VoiceActivityDetectionStatusEvent(voiceActivityDetectionEnabled: \(voiceActivityDetectionEnabled))"
    }
}

public struct SpeakingStatusEvent: CustomStringConvertible {
    public let speaking: Bool
    public let values: [String: Any]

    public init(values: [String: Any]) {
        speaking = boolValue(values, "speaking") ?? false
        self.values = values
    }

    public var description: String {
        "SpeakingStatusEvent(speaking: \(speaking))"
    }
}

public enum BluetoothEvent: CustomStringConvertible {
    case buttonPress(ButtonPressEvent)
    case touch(TouchEvent)
    case voiceActivityDetectionStatus(VoiceActivityDetectionStatusEvent)
    case speakingStatus(SpeakingStatusEvent)
    case wifiStatus(WifiStatusEvent)
    case hotspotStatus(HotspotStatusEvent)
    case hotspotError(HotspotErrorEvent)
    case photoResponse(PhotoResponseEvent)
    case photoStatus(PhotoStatusEvent)
    case streamStatus(StreamStatusEvent)
    case keepAliveAck(KeepAliveAckEvent)
    case localTranscription(LocalTranscriptionEvent)
    case raw(name: String, values: [String: Any])

    public var description: String {
        switch self {
        case let .buttonPress(event):
            event.description
        case let .touch(event):
            event.description
        case let .voiceActivityDetectionStatus(event):
            event.description
        case let .speakingStatus(event):
            event.description
        case let .wifiStatus(event):
            event.description
        case let .hotspotStatus(event):
            event.description
        case let .hotspotError(event):
            event.description
        case let .photoResponse(event):
            event.description
        case let .photoStatus(event):
            event.description
        case let .streamStatus(event):
            event.description
        case let .keepAliveAck(event):
            event.description
        case let .localTranscription(event):
            event.description
        case let .raw(name, values):
            "\(name): \(values)"
        }
    }
}

@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdate state: MentraBluetoothState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateSdkState sdkState: PhoneSdkRuntimeState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateScan scan: BluetoothScanState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: ScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: BluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm event: MicPcmEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 event: MicLc3Event)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: Device?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: BluetoothError)
}

@MainActor
public extension MentraBluetoothSDKDelegate {
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdate _: MentraBluetoothState) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlasses _: GlassesRuntimeState) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateSdkState _: PhoneSdkRuntimeState) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateScan _: BluetoothScanState) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover _: Device) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didStopScan _: ScanStopReason) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive _: BluetoothEvent) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm _: MicPcmEvent) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 _: MicLc3Event) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice _: Device?) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog _: String) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail _: BluetoothError) {}
}

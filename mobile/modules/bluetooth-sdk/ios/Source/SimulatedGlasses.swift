import Foundation

/// Kind of a recorded simulated display command.
public enum SimulatedDisplayEventKind: String, Sendable {
    case clear
    case text
    case textWall
    case doubleTextWall
    case bitmap
}

/// One display command in call order, as the simulated glasses would have rendered it.
public struct SimulatedDisplayEvent: Sendable {
    public let kind: SimulatedDisplayEventKind
    public let text: String?
    public let top: String?
    public let bottom: String?
    public let base64ImageData: String?

    public init(
        kind: SimulatedDisplayEventKind,
        text: String? = nil,
        top: String? = nil,
        bottom: String? = nil,
        base64ImageData: String? = nil
    ) {
        self.kind = kind
        self.text = text
        self.top = top
        self.bottom = bottom
        self.base64ImageData = base64ImageData
    }
}

/// Scriptable handle for the built-in simulated glasses.
///
/// `MentraBluetoothSDK.connectSimulated()` returns this handle after connecting the simulated
/// device. Injected events flow through the same `Bridge` event sinks as real hardware events, so
/// listeners observe the same `mic_pcm`, `touch_event`, and `head_up` payloads they would for a
/// physical pair.
@MainActor
public protocol SimulatedGlasses {
    /// Display commands recorded since the last `clearDisplayTranscript()`, in call order.
    func displayTranscript() -> [SimulatedDisplayEvent]

    func clearDisplayTranscript()

    /// Deliver a PCM frame tagged with `source = "glasses"`.
    func injectMicPcm(_ pcm: Data)

    func injectTouch(_ gesture: TouchGesture)

    func injectHeadUp(_ headUp: Bool)

    /// Flip the observable connection state to disconnected without tearing down this handle.
    func simulateDisconnect()

    func simulateReconnect()
}

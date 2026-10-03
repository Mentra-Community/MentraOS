import WebRTC

/// Both legs need real interface enumeration: local Wi-Fi can be absent from the default
/// internet NWPath while cellular carries the uplink. Each factory's adapter mask and the
/// receiver's SDP policy still restrict candidates to the appropriate leg.
enum GlassesPeerFactory {
    /// M144 honors this field trial for factories with custom audio devices; M137 installed
    /// NWPathMonitor unconditionally (including when disableNetworkMonitor was set).
    /// The SDK setting is process-wide. Set it once and never toggle it around factory creation:
    /// receiver, relay, and React Native WebRTC factories may initialize concurrently.
    private static let configure: Void = {
        RTCPeerConnectionFactory.configureFieldTrials("WebRTC-Network-UseNWPathMonitor/Disabled/")
    }()

    static func make(audioDevice: RTCAudioDevice) -> RTCPeerConnectionFactory {
        _ = configure
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory(),
            audioDevice: audioDevice
        )
    }
}

public enum CapturePolicy {
    public static func captureGlassesMic(_ source: AudioSourceKind) -> Bool {
        source == .glasses
    }
}

struct DeviceTypes {
    static let SIMULATED = "Simulated Glasses"
    static let G1 = "Even Realities G1"
    static let LIVE = "Mentra Live"
    static let MACH1 = "Mentra Mach1"
    static let Z100 = "Vuzix Z100"
    static let NEX = "Mentra Display"
    static let FRAME = "Brilliant Frame"

    static let ALL = [
        SIMULATED,
        G1,
        MACH1,
        LIVE,
        Z100,
        NEX,
        FRAME,
    ]

    // Private init to prevent instantiation
    private init() {}
}

struct ConnTypes {
    static let CONNECTING = "CONNECTING"
    static let CONNECTED = "CONNECTED"
    static let DISCONNECTED = "DISCONNECTED"

    // Private init to prevent instantiation
    private init() {}
}

struct MicTypes {
    static let PHONE_INTERNAL = "phone"
    static let GLASSES_CUSTOM = "glasses"
    static let BT_CLASSIC = "btclassic"
    static let BT = "bt"

    static let ALL = [
        PHONE_INTERNAL,
        GLASSES_CUSTOM,
        BT_CLASSIC,
        BT,
    ]

    // Private init to prevent instantiation
    private init() {}
}

enum MicMap {
    static var map: [String: [String]] = [
        "auto": [MicTypes.GLASSES_CUSTOM, MicTypes.PHONE_INTERNAL, MicTypes.BT, MicTypes.BT_CLASSIC],
        "glasses": [MicTypes.GLASSES_CUSTOM],
        "phone": [MicTypes.PHONE_INTERNAL, MicTypes.GLASSES_CUSTOM],
        "bluetooth": [MicTypes.BT, MicTypes.PHONE_INTERNAL, MicTypes.GLASSES_CUSTOM],
    ]
}

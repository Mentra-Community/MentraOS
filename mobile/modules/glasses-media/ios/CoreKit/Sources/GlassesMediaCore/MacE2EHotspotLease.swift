#if MENTRA_E2E
    import Foundation

    /// Test-build dependency input, not a production network discovery mechanism.
    /// The Mac harness owns association and verifies the USB fixture, gateway MAC,
    /// DHCP address, local health and Ethernet before launching this process.
    public struct MacE2EHotspotLease: Decodable {
        public let ssid: String
        public let gateway: String
        public let address: String
        public let issuedAt: TimeInterval

        public func matches(ssid: String, gateway: String?, address: String?, now: TimeInterval) -> Bool {
            let age = now - issuedAt
            return age >= 0 && age <= 300 && self.gateway == gateway && self.address == address &&
                LocalMediaPolicy.canReuseHotspot(requestedSSID: ssid, currentSSID: self.ssid,
                                                 address: address, gateway: gateway)
        }
    }
#endif

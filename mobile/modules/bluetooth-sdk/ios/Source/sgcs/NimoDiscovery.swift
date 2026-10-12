import Foundation

/// Combines system-connected classic devices with incoming CoreBluetooth discoveries.
/// Kept independent of the radio so discovery can be exercised without hardware.
@MainActor
final class NimoDiscovery<Peripheral> {
    private(set) var active = false
    private let register: () -> Void
    private let connected: () -> [Peripheral]
    private let scan: () -> Void
    private let stop: () -> Void
    private let name: (Peripheral) -> String?
    private let found: (Peripheral, String, Int?) -> Void

    init(register: @escaping () -> Void, connected: @escaping () -> [Peripheral],
         scan: @escaping () -> Void, stop: @escaping () -> Void,
         name: @escaping (Peripheral) -> String?, found: @escaping (Peripheral, String, Int?) -> Void)
    {
        self.register = register
        self.connected = connected
        self.scan = scan
        self.stop = stop
        self.name = name
        self.found = found
    }

    func start() {
        active = true
        // Register first so pairing in Settings cannot race the connected snapshot.
        register()
        for peripheral in connected() {
            receive(peripheral)
        }
        if active { scan() }
    }

    func cancel() {
        active = false
        stop()
    }

    func receive(_ peripheral: Peripheral, advertisedName: String? = nil, rssi: Int? = nil) {
        guard active, let name = advertisedName ?? name(peripheral) else { return }
        let lower = name.lowercased()
        // The separate ANCS peripheral does not host the Companion data service.
        guard lower.hasPrefix("nimo"), !lower.hasSuffix("_ble") else { return }
        found(peripheral, name, rssi)
    }
}

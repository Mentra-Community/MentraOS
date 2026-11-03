import CoreBluetooth
import Foundation

final class BluetoothAvailability: NSObject, CBCentralManagerDelegate {
    static let shared = BluetoothAvailability()

    private var centralManager: CBCentralManager?
    private var systemState: CBManagerState = .unknown
    private var listeners: [UUID: (CBManagerState) -> Void] = [:]

    /// Test seam: while set, listeners and availability checks see this state instead of the
    /// host's radio, so a test does not depend on the machine's Bluetooth. Set it before the SDK
    /// under test registers its listener; the system's own updates are not delivered meanwhile.
    var stateOverride: CBManagerState?

    private var state: CBManagerState {
        stateOverride ?? systemState
    }

    override private init() {
        super.init()
        centralManager = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false]
        )
        systemState = centralManager?.state ?? .unknown
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        systemState = central.state
        guard stateOverride == nil else { return }
        for listener in Array(listeners.values) {
            listener(state)
        }
    }

    @discardableResult
    func addStateListener(_ listener: @escaping (CBManagerState) -> Void) -> UUID {
        // `listeners` is unsynchronized; it is only safe because the central
        // manager queue is `.main` and all callers are main-thread bound.
        dispatchPrecondition(condition: .onQueue(.main))
        let id = UUID()
        listeners[id] = listener
        listener(state)
        return id
    }

    func removeStateListener(_ id: UUID) {
        dispatchPrecondition(condition: .onQueue(.main))
        listeners[id] = nil
    }

    /// Whether phone Bluetooth is switched off right now. Read on the main thread,
    /// where the central manager delivers its state.
    var isPoweredOff: Bool {
        (stateOverride ?? centralManager?.state ?? systemState) == .poweredOff
    }

    /// Read-only system lookup. It neither connects nor claims ownership.
    func connectedPeripherals(withServices services: [CBUUID]) -> [CBPeripheral] {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let centralManager, centralManager.state == .poweredOn, !services.isEmpty else { return [] }
        return centralManager.retrieveConnectedPeripherals(withServices: services)
    }

    func requirePoweredOn(operation: String) throws {
        if let current = centralManager?.state {
            systemState = current
        }
        switch state {
        case .poweredOn:
            return
        case .poweredOff:
            throw BluetoothSdkError(
                code: "bluetooth_powered_off",
                message: "Turn on phone Bluetooth to \(operation)."
            )
        case .unauthorized:
            throw BluetoothSdkError(
                code: "bluetooth_unauthorized",
                message: "Allow Bluetooth access to \(operation)."
            )
        case .unsupported:
            throw BluetoothSdkError(
                code: "bluetooth_unsupported",
                message: "This phone does not support Bluetooth."
            )
        case .resetting, .unknown:
            throw BluetoothSdkError(
                code: "bluetooth_not_ready",
                message: "Bluetooth is not ready yet. Try again."
            )
        @unknown default:
            throw BluetoothSdkError(
                code: "bluetooth_unavailable",
                message: "Bluetooth is unavailable. Try again."
            )
        }
    }
}

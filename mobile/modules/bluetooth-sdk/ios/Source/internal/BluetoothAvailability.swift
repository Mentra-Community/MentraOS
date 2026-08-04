import CoreBluetooth
import Foundation

final class BluetoothAvailability: NSObject, CBCentralManagerDelegate {
    static let shared = BluetoothAvailability()

    private var centralManager: CBCentralManager?
    private var state: CBManagerState = .unknown
    private var listeners: [UUID: (CBManagerState) -> Void] = [:]

    override private init() {
        super.init()
        centralManager = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false]
        )
        state = centralManager?.state ?? .unknown
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        state = central.state
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

    func requirePoweredOn(operation: String) throws {
        if let current = centralManager?.state {
            state = current
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

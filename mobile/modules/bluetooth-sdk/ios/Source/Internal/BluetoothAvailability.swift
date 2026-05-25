import CoreBluetooth
import Foundation

final class BluetoothAvailability: NSObject, CBCentralManagerDelegate {
    static let shared = BluetoothAvailability()

    private var centralManager: CBCentralManager?
    private var state: CBManagerState = .unknown

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
    }

    func requirePoweredOn(operation: String) throws {
        if let current = centralManager?.state {
            state = current
        }
        switch state {
        case .poweredOn:
            return
        case .poweredOff:
            throw BluetoothError(
                code: "bluetooth_powered_off",
                message: "Turn on phone Bluetooth to \(operation)."
            )
        case .unauthorized:
            throw BluetoothError(
                code: "bluetooth_unauthorized",
                message: "Allow Bluetooth access to \(operation)."
            )
        case .unsupported:
            throw BluetoothError(
                code: "bluetooth_unsupported",
                message: "This phone does not support Bluetooth."
            )
        case .resetting, .unknown:
            throw BluetoothError(
                code: "bluetooth_not_ready",
                message: "Bluetooth is not ready yet. Try again."
            )
        @unknown default:
            throw BluetoothError(
                code: "bluetooth_unavailable",
                message: "Bluetooth is unavailable. Try again."
            )
        }
    }
}

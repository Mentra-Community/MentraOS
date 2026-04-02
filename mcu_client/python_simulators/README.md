# Python BLE Simulators

Cross-platform Python scripts for testing MentraOS BLE glasses simulators. Compatible with both ESP32 and nRF5340 implementations.

## 📋 Requirements

```bash
pip install -r requirements.txt
```

Required packages:
- `bleak` - Cross-platform BLE library
- `asyncio` - Async programming support

## 🔧 Scripts Overview

### `ble_scanner.py`
Scans for BLE devices and looks for MentraOS glasses simulators.

```bash
python ble_scanner.py
```

**Output**: Lists all discovered devices, highlighting "NexSim" devices.

### `service_scanner.py` 
Connects to a device and examines its BLE services and characteristics.

```bash
python service_scanner.py
```

**Features**:
- Service UUID discovery
- Characteristic properties inspection
- MentraOS service validation

### `phone_ble_simulator.py`
Full bidirectional communication testing with protobuf protocol.

```bash
python phone_ble_simulator.py
```

**Features**:
- Automatic device discovery
- Protobuf message sending
- Echo response validation
- Connection management

### `direct_connect_test.py`
Direct connection testing with specific device MAC addresses.

```bash
python direct_connect_test.py
```

**Use case**: When you know the exact device MAC and want to test specific scenarios.

### `test_connection.py`
Basic connection test script (template for custom tests).

## 🎯 Testing Workflow

1. **Start simulator** (ESP32 or nRF5340)
2. **Scan for device**:
   ```bash
   python ble_scanner.py
   ```
3. **Examine services**:
   ```bash
   python service_scanner.py
   ```
4. **Full protocol test**:
   ```bash
   python phone_ble_simulator.py
   ```

## 📡 Expected Device Behavior

### Device Discovery
- Device name: `NexSim XXXXXX` (where XXXXXX is MAC suffix)
- Service UUID: `00004860-0000-1000-8000-00805f9b34fb`

### Characteristics
- **TX** (Phone → Glasses): `000071FF-0000-1000-8000-00805f9b34fb`
- **RX** (Glasses → Phone): `000070FF-0000-1000-8000-00805f9b34fb`

### Protocol Messages
- Send: `0x02 + protobuf_data` (control messages)
- Receive: `Echo: Received X bytes` (echo responses)

## 🐛 Troubleshooting

### Device Not Found
- Ensure simulator is running and advertising
- Check device is in range (< 10 meters)
- Verify Bluetooth is enabled on computer

### Connection Failed
- Device might be connected to another client
- Restart the simulator device
- Check BLE permissions on your OS

### No Echo Response
- Verify TX/RX characteristic UUIDs match
- Check simulator logs for received data
- Ensure notifications are enabled

## 🔄 Cross-Platform Compatibility

| Script | ESP32 | nRF5340 | Notes |
|--------|-------|---------|-------|
| ble_scanner.py | ✅ | ✅ | Universal |
| service_scanner.py | ✅ | ✅ | Universal |  
| phone_ble_simulator.py | ✅ | ✅ | Universal |
| direct_connect_test.py | ✅ | ✅ | Universal |

All scripts work identically with both simulator platforms since they implement the same BLE protocol.

## 📚 Further Reading

- [MentraOS BLE Protocol Specification](../firmware_spec_protobuf.md)
- [ESP32 Simulator Guide](../esp32_ble_simulator/README.md)  
- [nRF5340 Simulator Guide](../nrf5340_ble_simulator/README.md)

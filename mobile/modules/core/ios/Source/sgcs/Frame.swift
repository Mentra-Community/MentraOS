// //
// //  Frame.swift
// //  AOS
// //
// //  Created by Matthew Fosse on 8/20/25.
// //

// //
// //  FrameManager.swift
// //  AOS
// //
// //  Created for Brilliant Labs Frame support
// //

// import Combine
// import CoreBluetooth
// import Foundation
// import React
// import UIKit

// // MARK: - Supporting Types

// struct FrameDevice {
//     let name: String
//     let address: String
// }

// struct FrameCommand {
//     let command: String
//     let completion: ((Bool) -> Void)?
// }

// // MARK: - FrameManager

// @objc(FrameManager) class FrameManager: NSObject, SGCManager {
//     func sendButtonMaxRecordingTime() {}

//     var glassesAppVersion: String = ""

//     var glassesBuildNumber: String = ""

//     var glassesDeviceModel: String = ""

//     var glassesAndroidVersion: String = ""

//     var glassesOtaVersionUrl: String = ""

//     var glassesSerialNumber: String = ""

//     var glassesStyle: String = ""

//     var glassesColor: String = ""

//     var caseBatteryLevel: Int = -1

//     var wifiSsid: String = ""

//     var wifiConnected: Bool = false

//     var wifiLocalIp: String = ""

//     var isHotspotEnabled: Bool = false

//     var hotspotSsid: String = ""

//     var hotspotPassword: String = ""

//     var hotspotGatewayIp: String = ""

//     func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}

//     func sendButtonPhotoSettings() {}

//     func sendButtonModeSetting() {}

//     func sendButtonVideoRecordingSettings() {}

//     func sendButtonMaxRecordingTime(_: Int) {}

//     func sendButtonCameraLedSetting() {}

func exit() {}

func sendRgbLedControl(requestId: String, packageName _: String?, action _: String, color _: String?, ontime _: Int, offtime _: Int, count _: Int) {
    Bridge.sendRgbLedControlResponse(requestId: requestId, success: false, error: "device_not_supported")
}

//     func requestWifiScan() {}

//     func sendWifiCredentials(_: String, _: String) {}

//     func sendHotspotState(_: Bool) {}

//     func queryGalleryStatus() {}

//     func showDashboard() {}

//     func getConnectedBluetoothName() -> String? {
//         return nil
//     }

//     func setDashboardPosition(_: Int, _: Int) {}

//     func setSilentMode(_: Bool) {}

//     func findCompatibleDevices() {}

//     func connectById(_: String) {}

//     func displayBitmap(base64ImageData _: String) async -> Bool {
//         return true
//     }

//     func sendDoubleTextWall(_: String, _: String) {}

//     func sendJson(_: [String: Any], wakeUp _: Bool) {}

//     func requestPhoto(_: String, appId _: String, size _: String?, webhookUrl _: String?) {}

//     func forget() {}

//     func setBrightness(_: Int, autoMode _: Bool) {}

//     let type = "frame"
//     let hasMic = false
//     var ready = false
//     var isHeadUp = false
//     var caseOpen = false
//     var caseRemoved = true
//     var caseCharging = false

//     func setMicEnabled(_: Bool) {}

//     func startRtmpStream(_: [String: Any]) {}

//     func stopRtmpStream() {}

//     func sendRtmpKeepAlive(_: [String: Any]) {}

//     func startBufferRecording() {}

//     func stopBufferRecording() {}

//     func saveBufferVideo(requestId _: String, durationSeconds _: Int) {}

//     func startVideoRecording(requestId _: String, save _: Bool) {}

//     func stopVideoRecording(requestId _: String) {}

//     func setHeadUpAngle(_: Int) {}

//     func getBatteryStatus() {}

//     // Frame BLE Service and Characteristic UUIDs
//     private let FRAME_SERVICE_UUID = CBUUID(string: "7A230001-5475-A6A4-654C-8431F6AD49C4")
//     private let FRAME_TX_CHAR_UUID = CBUUID(string: "7A230002-5475-A6A4-654C-8431F6AD49C4") // Phone → Frame
//     private let FRAME_RX_CHAR_UUID = CBUUID(string: "7A230003-5475-A6A4-654C-8431F6AD49C4") // Frame → Phone

//     private static let TAG = "FrameManager"
//     private static let COMMAND_DELAY_MS = 100
//     private static let MAX_QUEUE_SIZE = 10
//     private static let MTU_SIZE = 251

//     // MARK: - Properties

//     private var centralManager: CBCentralManager?
//     private var framePeripheral: CBPeripheral?
//     private var txCharacteristic: CBCharacteristic?
//     private var rxCharacteristic: CBCharacteristic?

//     private var isScanning = false
//     private var isConnecting = false
//     private var isConnected = false

//     // Command queue system
//     private var commandQueue = [FrameCommand]()
//     private var isProcessingQueue = false
//     private let queueLock = NSLock()
//     private var currentWriteCompletion: ((Bool) -> Void)?

//     // Device tracking
//     private var discoveredDevices = Set<String>()
//     private var savedDeviceName: String?

//     // Callbacks
//     var onConnectionStateChanged: (() -> Void)?
//     var onDeviceDiscovered: ((String) -> Void)?

//     // Published properties for SwiftUI/Combine
//     @Published var connectionState = "DISCONNECTED"
//     @Published var batteryLevel: Int = -1

//     override init() {
//         super.init()
//         centralManager = CBCentralManager(delegate: self, queue: nil)
//         loadSavedDeviceName()
//     }

//     // MARK: - Public Methods

//     func startScanning() {
//         guard let centralManager = centralManager,
//               centralManager.state == .poweredOn,
//               !isScanning
//         else {
//             Bridge.log("\(FrameManager.TAG): Cannot start scan - BLE not ready or already scanning")
//             return
//         }

//         isScanning = true
//         discoveredDevices.removeAll()

//         let scanOptions: [String: Any] = [
//             CBCentralManagerScanOptionAllowDuplicatesKey: false,
//         ]

//         centralManager.scanForPeripherals(
//             withServices: [FRAME_SERVICE_UUID],
//             options: scanOptions
//         )

//         Bridge.log("\(FrameManager.TAG): Started scanning for Frame devices")

//         // Stop scan after 10 seconds
//         DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
//             if self?.isScanning == true {
//                 self?.stopScanning()
//             }
//         }
//     }

//     func stopScanning() {
//         guard isScanning else { return }

//         centralManager?.stopScan()
//         isScanning = false
//         Bridge.log("\(FrameManager.TAG): Stopped scanning")
//     }

//     func connect(deviceName: String? = nil) {
//         let targetDevice = deviceName ?? savedDeviceName

//         guard let name = targetDevice else {
//             Bridge.log("\(FrameManager.TAG): No device name available for connection")
//             startScanning()
//             return
//         }

//         if isConnecting {
//             Bridge.log("\(FrameManager.TAG): Already connecting")
//             return
//         }

//         isConnecting = true
//         connectionState = "CONNECTING"

//         // Start targeted scan for specific device
//         startTargetedScan(deviceName: name)
//     }

//     func disconnect() {
//         guard let peripheral = framePeripheral else { return }

//         centralManager?.cancelPeripheralConnection(peripheral)
//         cleanup()
//     }

//     // MARK: - Display Methods

//     func sendTextWall(_ text: String) {
//         guard isConnected else {
//             Bridge.log("\(FrameManager.TAG): Cannot display text - not connected")
//             return
//         }

//         // Clear queue for new text display
//         queueLock.lock()
//         commandQueue.removeAll()
//         isProcessingQueue = false
//         queueLock.unlock()

//         let escapedText = escapeForLua(text)
//         let words = escapedText.split(separator: " ")

//         let maxLineLength = 30
//         let lineHeight = 55
//         let startY = 20
//         let maxLines = 3

//         var lines = [String]()
//         var currentLine = ""

//         for word in words {
//             if lines.count >= maxLines { break }

//             let wordStr = String(word)
//             if currentLine.count + wordStr.count + 1 > maxLineLength {
//                 if !currentLine.isEmpty {
//                     lines.append(currentLine.trimmingCharacters(in: .whitespaces))
//                     currentLine = ""
//                 }
//             }

//             if !currentLine.isEmpty {
//                 currentLine += " "
//             }
//             currentLine += wordStr
//         }

//         if !currentLine.isEmpty, lines.count < maxLines {
//             lines.append(currentLine.trimmingCharacters(in: .whitespaces))
//         }

//         // Build commands - lines are already escaped
//         var batchCommand = ""
//         for (index, line) in lines.enumerated() {
//             let yPos = startY + (index * lineHeight)
//             batchCommand += "frame.display.text('\(line)', 10, \(yPos));"
//         }
//         batchCommand += "frame.display.show();print(nil)"

//         // Send as single command if it fits, otherwise send separately
//         if batchCommand.count < 240 {
//             queueCommand(batchCommand)
//         } else {
//             for (index, line) in lines.enumerated() {
//                 let yPos = startY + (index * lineHeight)
//                 let lineCommand = "frame.display.text('\(line)', 10, \(yPos));print(nil)"
//                 queueCommand(lineCommand)
//             }
//             queueCommand("frame.display.show();print(nil)")
//         }
//     }

//     func displayTextLine(_ text: String) {
//         let escapedText = escapeForLua(text)
//         let command = "frame.display.text('\(escapedText)', 50, 200);frame.display.show();print(nil)"
//         queueCommand(command)
//     }

//     func clearDisplay() {
//         queueCommand("frame.display.text(' ', 1, 1);frame.display.show();print(nil)")
//     }

//     // MARK: - Private Methods

//     private func startTargetedScan(deviceName: String) {
//         guard let centralManager = centralManager,
//               centralManager.state == .poweredOn
//         else {
//             Bridge.log("\(FrameManager.TAG): BLE not ready for targeted scan")
//             isConnecting = false
//             connectionState = "DISCONNECTED"
//             return
//         }

//         // Store target name for scan callback
//         savedDeviceName = deviceName

//         centralManager.scanForPeripherals(
//             withServices: [FRAME_SERVICE_UUID],
//             options: nil
//         )

//         // Timeout after 10 seconds
//         DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
//             guard let self = self else { return }
//             if self.isConnecting, self.framePeripheral == nil {
//                 self.centralManager?.stopScan()
//                 self.isConnecting = false
//                 self.connectionState = "DISCONNECTED"
//                 Bridge.log("\(FrameManager.TAG): Connection timeout - device not found")
//             }
//         }
//     }

//     private func queueCommand(_ command: String, completion: ((Bool) -> Void)? = nil) {
//         queueLock.lock()
//         commandQueue.append(FrameCommand(command: command, completion: completion))
//         Bridge.log("\(FrameManager.TAG): Queued command (queue size: \(commandQueue.count))")
//         queueLock.unlock()

//         processQueue()
//     }

//     private func processQueue() {
//         queueLock.lock()

//         if isProcessingQueue || commandQueue.isEmpty {
//             queueLock.unlock()
//             return
//         }

//         guard let command = commandQueue.first else {
//             queueLock.unlock()
//             return
//         }

//         isProcessingQueue = true
//         commandQueue.removeFirst()
//         queueLock.unlock()

//         sendLuaCommand(command.command) { [weak self] success in
//             command.completion?(success)

//             // If failed, clear queue and stop processing
//             if !success {
//                 self?.queueLock.lock()
//                 self?.commandQueue.removeAll()
//                 self?.isProcessingQueue = false
//                 self?.queueLock.unlock()
//                 return
//             }

//             // Schedule next command
//             DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
//                 self?.queueLock.lock()
//                 self?.isProcessingQueue = false
//                 self?.queueLock.unlock()
//                 self?.processQueue()
//             }
//         }
//     }

//     private func sendLuaCommand(_ command: String, completion: @escaping (Bool) -> Void) {
//         guard let txCharacteristic = txCharacteristic,
//               let peripheral = framePeripheral
//         else {
//             Bridge.log("\(FrameManager.TAG): Cannot send command - not connected")
//             completion(false)
//             return
//         }

//         var finalCommand = command

//         // Add print(nil) if not present
//         if !command.contains("print(") {
//             if !command.contains(";") {
//                 finalCommand = command + ";print(nil)"
//             }
//         }

//         // Add newline
//         if !finalCommand.hasSuffix("\n") {
//             finalCommand += "\n"
//         }

//         guard var data = finalCommand.data(using: .utf8) else {
//             Bridge.log("\(FrameManager.TAG): Failed to encode command")
//             completion(false)
//             return
//         }

//         // Handle MTU limitation
//         if data.count > 247 {
//             Bridge.log("\(FrameManager.TAG): Command too long, truncating")
//             data = data.prefix(247)
//         }

//         Bridge.log("\(FrameManager.TAG): Sending Lua command: \(finalCommand.trimmingCharacters(in: .whitespacesAndNewlines))")

//         // Store completion for delegate callback
//         currentWriteCompletion = completion
//         peripheral.writeValue(data, for: txCharacteristic, type: .withResponse)
//     }

//     private func initializeFrame() {
//         Bridge.log("\(FrameManager.TAG): Initializing Frame display")

//         // Send break signal to stop any running main.lua
//         sendBreakSignal()

//         // Wait then send welcome message
//         DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
//             self?.queueCommand("frame.display.text('MentraOS Connected!', 100, 100);frame.display.show();print(nil)")
//         }
//     }

//     private func sendBreakSignal() {
//         guard let txCharacteristic = txCharacteristic,
//               let peripheral = framePeripheral else { return }

//         let breakSignal = Data([0x03])
//         peripheral.writeValue(breakSignal, for: txCharacteristic, type: .withResponse)
//         Bridge.log("\(FrameManager.TAG): Sent break signal")
//     }

//     private func escapeForLua(_ text: String) -> String {
//         return text
//             .replacingOccurrences(of: "\\", with: "\\\\")
//             .replacingOccurrences(of: "'", with: "\\'")
//             .replacingOccurrences(of: "\"", with: "\\\"")
//             .replacingOccurrences(of: "\n", with: " ")
//             .replacingOccurrences(of: "\r", with: " ")
//             .replacingOccurrences(of: "\t", with: " ")
//     }

//     func cleanup() {
//         txCharacteristic = nil
//         rxCharacteristic = nil
//         framePeripheral = nil
//         isConnected = false
//         isConnecting = false
//         connectionState = "DISCONNECTED"

//         queueLock.lock()
//         commandQueue.removeAll()
//         isProcessingQueue = false
//         queueLock.unlock()
//     }

//     private func loadSavedDeviceName() {
//         savedDeviceName = UserDefaults.standard.string(forKey: "FrameDeviceName")
//     }

//     private func saveDeviceName(_ name: String) {
//         savedDeviceName = name
//         UserDefaults.standard.set(name, forKey: "FrameDeviceName")
//     }
// }

// // MARK: - CBCentralManagerDelegate

// extension FrameManager: CBCentralManagerDelegate {
//     func centralManagerDidUpdateState(_ central: CBCentralManager) {
//         switch central.state {
//         case .poweredOn:
//             Bridge.log("\(FrameManager.TAG): Bluetooth powered on")
//         case .poweredOff:
//             Bridge.log("\(FrameManager.TAG): Bluetooth powered off")
//             cleanup()
//         default:
//             Bridge.log("\(FrameManager.TAG): Bluetooth state: \(central.state.rawValue)")
//         }
//     }

//     func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
//                         advertisementData _: [String: Any], rssi _: NSNumber)
//     {
//         let deviceName = peripheral.name ?? "Unknown"
//         let address = peripheral.identifier.uuidString

//         // Check if this is a Frame device
//         if deviceName.contains("Frame") || deviceName.contains("frame") {
//             if !discoveredDevices.contains(address) {
//                 discoveredDevices.insert(address)
//                 Bridge.log("\(FrameManager.TAG): Found Frame device: \(deviceName) (\(address))")
//                 onDeviceDiscovered?(deviceName)

//                 // If we're doing targeted scan, connect to matching device
//                 if isConnecting, let targetName = savedDeviceName, deviceName == targetName {
//                     central.stopScan()
//                     framePeripheral = peripheral
//                     peripheral.delegate = self
//                     central.connect(peripheral, options: nil)
//                     Bridge.log("\(FrameManager.TAG): Connecting to \(deviceName)")
//                 }
//             }
//         }
//     }

//     func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
//         Bridge.log("\(FrameManager.TAG): Connected to Frame - negotiating MTU")
//         isConnecting = false

//         // Save device name
//         if let name = peripheral.name {
//             saveDeviceName(name)
//         }

//         // Request larger MTU
//         peripheral.maximumWriteValueLength(for: .withResponse)

//         // Discover services
//         peripheral.discoverServices([FRAME_SERVICE_UUID])
//     }

//     func centralManager(_: CBCentralManager, didDisconnectPeripheral _: CBPeripheral, error _: Error?) {
//         Bridge.log("\(FrameManager.TAG): Disconnected from Frame")
//         cleanup()
//         onConnectionStateChanged?()
//     }

//     func centralManager(_: CBCentralManager, didFailToConnect _: CBPeripheral, error: Error?) {
//         Bridge.log("\(FrameManager.TAG): Failed to connect: \(error?.localizedDescription ?? "Unknown error")")
//         isConnecting = false
//         connectionState = "DISCONNECTED"
//         cleanup()
//     }
// }

// // MARK: - CBPeripheralDelegate

// extension FrameManager: CBPeripheralDelegate {
//     func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
//         guard error == nil else {
//             Bridge.log("\(FrameManager.TAG): Service discovery failed: \(error!)")
//             return
//         }

//         guard let services = peripheral.services else { return }

//         for service in services {
//             if service.uuid == FRAME_SERVICE_UUID {
//                 Bridge.log("\(FrameManager.TAG): Found Frame service")
//                 peripheral.discoverCharacteristics([FRAME_TX_CHAR_UUID, FRAME_RX_CHAR_UUID], for: service)
//             }
//         }
//     }

//     func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
//         guard error == nil else {
//             Bridge.log("\(FrameManager.TAG): Characteristic discovery failed: \(error!)")
//             return
//         }

//         guard let characteristics = service.characteristics else { return }

//         for characteristic in characteristics {
//             if characteristic.uuid == FRAME_TX_CHAR_UUID {
//                 txCharacteristic = characteristic
//                 Bridge.log("\(FrameManager.TAG): Found TX characteristic")
//             } else if characteristic.uuid == FRAME_RX_CHAR_UUID {
//                 rxCharacteristic = characteristic
//                 peripheral.setNotifyValue(true, for: characteristic)
//                 Bridge.log("\(FrameManager.TAG): Found RX characteristic, enabling notifications")
//             }
//         }

//         // Check if we have both characteristics
//         if txCharacteristic != nil, rxCharacteristic != nil {
//             isConnected = true
//             connectionState = "CONNECTED"
//             Bridge.log("\(FrameManager.TAG): Frame fully connected")
//             onConnectionStateChanged?()
//             initializeFrame()
//         }
//     }

//     func peripheral(_: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error _: Error?) {
//         guard characteristic.uuid == FRAME_RX_CHAR_UUID,
//               let data = characteristic.value else { return }

//         if let response = String(data: data, encoding: .utf8) {
//             Bridge.log("\(FrameManager.TAG): Received from Frame: \(response)")
//         }
//     }

//     func peripheral(_: CBPeripheral, didWriteValueFor _: CBCharacteristic, error: Error?) {
//         if let error = error {
//             Bridge.log("\(FrameManager.TAG): Write failed: \(error)")
//             currentWriteCompletion?(false)
//         } else {
//             Bridge.log("\(FrameManager.TAG): Successfully wrote to Frame")
//             currentWriteCompletion?(true)
//         }
//         currentWriteCompletion = nil
//     }
// }

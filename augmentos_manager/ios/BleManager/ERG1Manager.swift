//
//  ERG1Manager.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/3/25.
//

import Combine
import CoreBluetooth
import Foundation
import UIKit
import React

extension Data {
  func chunked(into size: Int) -> [Data] {
    var chunks = [Data]()
    var index = 0
    while index < count {
      let chunkSize = Swift.min(size, count - index)
      let chunk = subdata(in: index..<(index + chunkSize))
      chunks.append(chunk)
      index += chunkSize
    }
    return chunks
  }
  
  func hexEncodedString() -> String {
    return map { String(format: "%02x", $0) }.joined()
  }
}

struct BufferedCommand {
  let chunks: [[UInt8]]
  let sendLeft: Bool
  let sendRight: Bool
  let waitTime: Int
  let ignoreAck: Bool
  
  init(chunks: [[UInt8]], sendLeft: Bool = true, sendRight: Bool = true, waitTime: Int = -1, ignoreAck: Bool = false) {
    self.chunks = chunks
    self.sendLeft = sendLeft
    self.sendRight = sendRight
    self.waitTime = waitTime
    self.ignoreAck = ignoreAck
  }
}

// Simple struct to hold app info
struct AppInfo {
  let id: String
  let name: String
}

enum GlassesError: Error {
  case missingGlasses(String)
}


@objc(ERG1Manager) class ERG1Manager: NSObject {
  
  // todo: we probably don't need this
  @objc static func requiresMainQueueSetup() -> Bool { return true }
  
  var onConnectionStateChanged: (() -> Void)?
  private var _g1Ready: Bool = false
  public var g1Ready: Bool {
    get { return _g1Ready }
    set {
      let oldValue = _g1Ready
      _g1Ready = newValue
      if oldValue != newValue {
        // Call the callback when state changes
        onConnectionStateChanged?()
      }
      if (!newValue) {
        // Reset battery levels when disconnected
        batteryLevel = -1
        leftBatteryLevel = -1
        rightBatteryLevel = -1
      }
    }
  }
  
  public var leftReady: Bool = false
  public var rightReady: Bool = false
  
  @Published public var compressedVoiceData: Data = Data()
  @Published public var aiListening: Bool = false
  @Published public var batteryLevel: Int = -1
  @Published public var caseBatteryLevel: Int = -1
  @Published public var leftBatteryLevel: Int = -1
  @Published public var rightBatteryLevel: Int = -1
  @Published public var caseCharging = false
  @Published public var caseOpen = false
  public var isDisconnecting = false
  private var reconnectionTimer: Timer?
  private var reconnectionAttempts: Int = 0
  private let maxReconnectionAttempts: Int = -1 // unlimited reconnection attempts
  private let reconnectionInterval: TimeInterval = 30.0 // Seconds between reconnection attempts
  
  enum AiMode: String {
    case AI_REQUESTED
    case AI_MIC_ON
    case AI_IDLE
  }
  
  let UART_SERVICE_UUID = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
  let UART_TX_CHAR_UUID = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
  let UART_RX_CHAR_UUID = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
  
  // synchronization:
  private let commandQueue = CommandQueue()
  private let queueLock = DispatchSemaphore(value: 1)
  private let leftSemaphore = DispatchSemaphore(value: 0)  // Start at 0 to block
  private let rightSemaphore = DispatchSemaphore(value: 0)  // Start at 0 to block
  private var leftAck = false
  private var rightAck = false
  
  // Constants
  var DEVICE_SEARCH_ID = "NOT_SET"
  let DELAY_BETWEEN_CHUNKS_SEND: UInt64 = 16_000_000 // 16ms
  let DELAY_BETWEEN_SENDS_MS: UInt64 = 8_000_000 // 8ms
  let INITIAL_CONNECTION_DELAY_MS: UInt64 = 350_000_000 // 350ms
  public var textHelper = G1Text()
  var msgId = 100;
  
  public static let _bluetoothQueue = DispatchQueue(label: "BluetoothG1", qos: .userInitiated)
  
  private var aiMode: AiMode = .AI_IDLE {
    didSet {
      if aiMode == .AI_MIC_ON {
        aiListening = true
      } else {
        aiListening = false
      }
    }
  }
  
  private var centralManager: CBCentralManager?
  private var leftPeripheral: CBPeripheral?
  private var rightPeripheral: CBPeripheral?
  private var connectedDevices: [String: (CBPeripheral?, CBPeripheral?)] = [:]
  var lastConnectionTimestamp: Date = Date.distantPast
  private var heartbeatTimer: Timer?
  private var heartbeatQueue: DispatchQueue?
  private var leftInitialized: Bool = false
  private var rightInitialized: Bool = false
  @Published public var isHeadUp = false
  
  private var leftGlassUUID: UUID? {
      get {
          if let uuidString = UserDefaults.standard.string(forKey: "leftGlassUUID") {
              return UUID(uuidString: uuidString)
          }
          return nil
      }
      set {
          if let newValue = newValue {
              UserDefaults.standard.set(newValue.uuidString, forKey: "leftGlassUUID")
          } else {
              UserDefaults.standard.removeObject(forKey: "leftGlassUUID")
          }
      }
  }
  
  private var rightGlassUUID: UUID? {
      get {
          if let uuidString = UserDefaults.standard.string(forKey: "rightGlassUUID") {
              return UUID(uuidString: uuidString)
          }
          return nil
      }
      set {
          if let newValue = newValue {
              UserDefaults.standard.set(newValue.uuidString, forKey: "rightGlassUUID")
          } else {
              UserDefaults.standard.removeObject(forKey: "rightGlassUUID")
          }
      }
  }
  
  override init() {
    super.init()
    startHeartbeatTimer()
  }
  
  deinit {
      // Stop the heartbeat timer
      heartbeatTimer?.invalidate()
      heartbeatTimer = nil
      
      // Stop the reconnection timer if active
      stopReconnectionTimer()
      
      // Clean up central manager delegate
      centralManager?.delegate = nil
      
      // Clean up peripheral delegates
      leftPeripheral?.delegate = nil
      rightPeripheral?.delegate = nil
      
      print("ERG1Manager deinitialized")
  }
  
  // @@@ REACT NATIVE FUNCTIONS @@@
  
  @objc func RN_setSearchId(_ searchId: String) {
    print("SETTING SEARCH_ID: \(searchId)")
    DEVICE_SEARCH_ID = searchId
  }
  
  // this scans for new (un-paired) glasses to connect to:
  @objc func RN_startScan() -> Bool {

    if centralManager == nil {
      centralManager = CBCentralManager(delegate: self, queue: ERG1Manager._bluetoothQueue)
      setupCommandQueue()
    }

    self.isDisconnecting = false// reset intentional disconnect flag
    guard centralManager!.state == .poweredOn else {
      print("Bluetooth is not powered on.")
      return false
    }
    
    print("startScan()")
    
    // send our already connected devices to RN:
    let devices = getConnectedDevices()
    print("connnectedDevices.count: (\(devices.count))")
    for device in devices {
      if let name = device.name {
        print("Connected to device: \(name)")
        if name.contains("_L_") && name.contains(DEVICE_SEARCH_ID) {
          leftPeripheral = device
          device.delegate = self
          device.discoverServices([UART_SERVICE_UUID])
        } else if name.contains("_R_") && name.contains(DEVICE_SEARCH_ID) {
          rightPeripheral = device
          device.delegate = self
          device.discoverServices([UART_SERVICE_UUID])
        }
        emitDiscoveredDevice(name);
      }
    }
    
    
//    // First try: Connect by UUID (works in background)
    if connectByUUID() {
        print("🔄 Found and attempting to connect to stored glasses UUIDs")
        // Wait for connection to complete - no need to scan
        return true
    }
//
    let scanOptions: [String: Any] = [
        CBCentralManagerScanOptionAllowDuplicatesKey: false,  // Don't allow duplicate advertisements
    ]
    
    centralManager!.scanForPeripherals(withServices: nil, options: scanOptions)
    return true
  }
  
  @objc public func RN_pairById(_ id: String) -> Bool {
    self.DEVICE_SEARCH_ID = "_" + id + "_"
    RN_startScan();
    return true
  }
  
  // connect to glasses we've discovered:
  @objc public func RN_connectGlasses() -> Bool {
    print("RN_connectGlasses()")
    
    if let side = leftPeripheral {
      centralManager!.connect(side, options: nil)
    }
    
    if let side = rightPeripheral {
      centralManager!.connect(side, options: nil)
    }
    
    // just return if we don't have both a left and right arm:
    guard leftPeripheral != nil && rightPeripheral != nil else {
      return false;
    }
    
    print("found both glasses \(leftPeripheral!.name ?? "(unknown)"), \(rightPeripheral!.name ?? "(unknown)") stopping scan");
//    startHeartbeatTimer();
    RN_stopScan();
    return true
  }
  
  @objc public func RN_sendText(_ text: String) -> Void {


//    if (text == " " || text == "") {
//      let command: [UInt8] = [0x18]
////      let command: [UInt8] = [0x20, 0xCA]
//      queueChunks([command])
//      return;
//    }

    Task {
      let displayText = "\(text)"
      guard let textData = displayText.data(using: .utf8) else { return }
      
      var command: [UInt8] = [
        0x4E,           // SEND_RESULT command
        0x00,           // sequence number
        0x01,           // total packages
        0x00,           // current package
        0x71,           // screen status (0x70 Text Show | 0x01 New Content)
        0x00,           // char position 0
        0x00,           // char position 1
        0x01,           // page number
        0x01            // max pages
      ]
      command.append(contentsOf: Array(textData))
      self.queueChunks([command])
    }
    
    // @@@@@@@@ just for testing:
//    Task {
//      msgId += 1
//      let ncsNotification = NCSNotification(
//          msgId: msgId,
//          appIdentifier: "io.heckel.ntfy",
//          title: "Notification Title",
//          subtitle: "Notification Subtitle",
//          message: text,
//          displayName: "Example App"
//      )
//
//      let notification = G1Notification(ncsNotification: ncsNotification)
//      let encodedChunks = await notification.constructNotification()
//      print("encodedChunks: \(encodedChunks.count)")
//      self.queueChunks(encodedChunks)
//    }
  }
  
  @objc public func RN_sendTextWall(_ text: String) -> Void {
    let chunks = textHelper.createTextWallChunks(text)
    queueChunks(chunks, sleepAfterMs: 50)
  }
  
  
  @objc public func RN_sendDoubleTextWall(_ top: String, _ bottom: String) -> Void {
    let chunks = textHelper.createDoubleTextWallChunks(textTop: top, textBottom: bottom)
    queueChunks(chunks, sleepAfterMs: 50)
  }
  
  public func setReadiness(left: Bool?, right: Bool?) {
    let prevLeftReady = leftReady
    let prevRightReady = rightReady
    
    if left != nil {
      leftReady = left!
      if (!prevLeftReady) {
        print("Left ready!")
      }
    }
    if right != nil {
      rightReady = right!
      if (!prevRightReady) {
        print("Right ready!")
      }
    }
    
    // print("g1Ready set to \(leftReady) \(rightReady) \(leftReady && rightReady)")
    g1Ready = leftReady && rightReady
    if g1Ready {
      stopReconnectionTimer()
    }
  }
  
  @objc func RN_stopScan() {
    centralManager!.stopScan()
    print("Stopped scanning for devices")
  }
  
  @objc func disconnect() {
    self.isDisconnecting = true
    leftGlassUUID = nil
    rightGlassUUID = nil
    stopReconnectionTimer()
    if let left = leftPeripheral {
      centralManager!.cancelPeripheralConnection(left)
    }
    
    if let right = rightPeripheral {
      centralManager!.cancelPeripheralConnection(right)
    }
    
    leftPeripheral = nil
    rightPeripheral = nil
    setReadiness(left: false, right: false)
    print("Disconnected from glasses")
  }
  
  // @@@ END REACT NATIVE FUNCTIONS
  
  
  actor CommandQueue {
    private var commands: [BufferedCommand] = []
    
    func enqueue(_ command: BufferedCommand) {
      commands.append(command)
    }
    
    func dequeue() -> BufferedCommand? {
      guard !commands.isEmpty else { return nil }
      return commands.removeFirst()
    }
  }
  
  private func setupCommandQueue() {
    Task.detached { [weak self] in
      guard let self = self else { return }
      
      while true {
        let command = await self.getNextCommand()
        await self.processCommand(command)
      }
    }
  }
  
  private func getNextCommand() async -> BufferedCommand {
    while true {
      if let command = await commandQueue.dequeue() {
        return command
      }
      try? await Task.sleep(nanoseconds: 100 * 1_000_000)// 100ms
    }
  }
  
  func resetSemaphoreToZero(_ semaphore: DispatchSemaphore) {
    // First, try to acquire the semaphore with a minimal timeout
    let result = semaphore.wait(timeout: .now() + 0.001)
    if result == .success {
      // We acquired it, meaning it was at least 1
      // Release it to get back to where we were (if it was 1) or to increment it by 1 (if it was >1)
      semaphore.signal()
      // Try to acquire it again to see if it's still available (meaning it was >1 before)
      while semaphore.wait(timeout: .now() + 0.001) == .success {
        // Keep signaling until we're sure we're at 1
        semaphore.signal()
        break
      }
    } else {
      // Timeout occurred, meaning the semaphore was at 0 or less
      // Signal once to try to bring it to 1
      semaphore.signal()
    }
    // bring it down to 0:
    semaphore.wait(timeout: .now() + 0.001)
  }
  
  private func attemptSend(chunks: [[UInt8]], side: String) async {
    var maxAttempts = 5
    var attempts: Int = 0
    var result: Bool = false
    var semaphore = side == "left" ? leftSemaphore : rightSemaphore
    
    while attempts < maxAttempts && !result {
      if (attempts > 0) {
        print("trying again to send to left: \(attempts)")
      }
      if self.isDisconnecting {
        // forget whatever we were doing since we're disconnecting:
        break
      }
      
      for i in 0..<chunks.count-1 {
        let chunk = chunks[i]
        await sendCommandToSide(chunk, side: side)
        try? await Task.sleep(nanoseconds: 50 * 1_000_000)// 50ms
      }
      
      let lastChunk = chunks.last!
      await sendCommandToSide(lastChunk, side: side)
      
      result = waitForSemaphore(semaphore: semaphore, timeout: 0.1)
      
      attempts += 1
      if !result && (attempts >= maxAttempts) {
        semaphore.signal()// increment the count
        startReconnectionTimer()
        break
      }
    }
  }
  
  // Process a single number with timeouts
  private func processCommand(_ command: BufferedCommand) async {
    
    //    print("@@@ processing command \(command.chunks[0][0]),\(command.chunks[0][1]) @@@")
    
    // TODO: this is a total hack but in theory ensure semaphores are at count 1:
    // in theory this shouldn't be necesarry but in practice this helps ensure weird
    // race conditions don't lead me down debugging the wrong thing for hours:
    resetSemaphoreToZero(leftSemaphore)
    resetSemaphoreToZero(rightSemaphore)
    
    if command.chunks.isEmpty {
      print("@@@ chunks was empty! @@@")
      return
    }
    
    // first send to the left:
    if command.sendLeft {
      await attemptSend(chunks: command.chunks, side: "left")
    }
    
    //    print("@@@ sent (or failed) to left, now trying right @@@")
    
    if command.sendRight {
      await attemptSend(chunks: command.chunks, side: "right")
    }
    
    if command.waitTime > 0 {
      // wait waitTime milliseconds before moving on to the next command:
      try? await Task.sleep(nanoseconds: UInt64(command.waitTime) * 1_000_000)
    } else {
      // sleep for a min amount of time unless otherwise specified
      try? await Task.sleep(nanoseconds: 100 * 1_000_000)// Xms
    }
  }
  
  private func waitForSemaphore(semaphore: DispatchSemaphore, timeout: TimeInterval) -> Bool {
    let result = semaphore.wait(timeout: .now() + timeout)
    return result == .success
  }
  
  func startHeartbeatTimer() {
    
    // Check if a timer is already running
    if heartbeatTimer != nil && heartbeatTimer!.isValid {
        print("Heartbeat timer already running")
        return
    }
    
    // Create a new queue if needed
    if heartbeatQueue == nil {
        heartbeatQueue = DispatchQueue(label: "com.sample.heartbeatTimerQueue", qos: .background)
    }
    
    heartbeatQueue!.async { [weak self] in
      self?.heartbeatTimer = Timer(timeInterval: 15.0, repeats: true) { [weak self] _ in
        guard let self = self else { return }
        self.sendHeartbeat()
      }
      
      RunLoop.current.add(self!.heartbeatTimer!, forMode: .default)
      RunLoop.current.run()
    }
  }
  
  private func findCharacteristic(uuid: CBUUID, peripheral: CBPeripheral) -> CBCharacteristic? {
    for service in peripheral.services ?? [] {
      for characteristic in service.characteristics ?? [] {
        if characteristic.uuid == uuid {
          return characteristic
        }
      }
    }
    return nil
  }
  
  private func getConnectedDevices() -> [CBPeripheral] {
    let connectedPeripherals = centralManager!.retrieveConnectedPeripherals(withServices: [UART_SERVICE_UUID])
    return connectedPeripherals
  }
  
  private func handleAck(from peripheral: CBPeripheral, success: Bool) {
    if !success { return }
    if peripheral == self.leftPeripheral {
      leftSemaphore.signal()
      setReadiness(left: true, right: nil)
    }
    if peripheral == self.rightPeripheral {
      rightSemaphore.signal()
      setReadiness(left: nil, right: true)
    }
  }
  
  private func handleNotification(from peripheral: CBPeripheral, data: Data) {
    guard let command = data.first else { return }// ensure the data isn't empty
    
    let side = peripheral == leftPeripheral ? "left" : "right"
    print("received from G1 (\(side)): \(data.hexEncodedString())")
    
    switch Commands(rawValue: command) {
    case .BLE_REQ_INIT:
      handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
      handleInitResponse(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
    case .BLE_REQ_MIC_ON:
      handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
    case .BRIGHTNESS:
      handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
    case .BLE_EXIT_ALL_FUNCTIONS:
      handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
    case .WHITELIST:
      // TODO: ios no idea why the glasses send 0xCB before sending ACK:
      handleAck(from: peripheral, success: data[1] == 0xCB || data[1] == CommandResponse.ACK.rawValue)
    case .DASHBOARD_LAYOUT_COMMAND:
      // 0x06 seems arbitrary :/
      handleAck(from: peripheral, success: data[1] == 0x06)
    case .DASHBOARD_SHOW:
      handleAck(from: peripheral, success: data[1] == 0x07)
    case .HEAD_UP_ANGLE:
      handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
    // head up angle ack
    // position ack
    case .BLE_REQ_TRANSFER_MIC_DATA:
      self.compressedVoiceData = data
      //                print("Got voice data: " + String(data.count))
      break
    case .BLE_REQ_HEARTBEAT:
      // TODO: ios handle semaphores correctly here
      // battery info
      guard data.count >= 6 && data[1] == 0x66 else {
        break
      }
      
      handleAck(from: peripheral, success: data[1] == 0x66)
      
      // Response format: 2C 66 [battery%] [flags] [voltage_low] [voltage_high] ...
      let batteryPercent = Int(data[2])
      let flags = data[3]
      let voltageLow = Int(data[4])
      let voltageHigh = Int(data[5])
      let rawVoltage = (voltageHigh << 8) | voltageLow
      let voltage = rawVoltage / 10  // Scale down by 10 to get actual millivolts
      
      //      print("Raw battery data - Battery: \(batteryPercent)%, Voltage: \(voltage)mV, Flags: 0x\(String(format: "%02X", flags))")
      
      // if left, update left battery level, if right, update right battery level
      if peripheral == leftPeripheral {
        if leftBatteryLevel != batteryPercent {
          print("Left glass battery: \(batteryPercent)%")
          leftBatteryLevel = batteryPercent
        }
      } else if peripheral == rightPeripheral {
        if rightBatteryLevel != batteryPercent {
          print("Right glass battery: \(batteryPercent)%")
          rightBatteryLevel = batteryPercent
        }
      }
      
      // update the main battery level as the lower of the two
      let newBatteryLevel = min(leftBatteryLevel, rightBatteryLevel)
      if (self.batteryLevel != newBatteryLevel) {
        self.batteryLevel = min(leftBatteryLevel, rightBatteryLevel)
      }
      break
    case .BLE_REQ_EVENAI:
      guard data.count > 1 else { break }
      handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
    case .BLE_REQ_DEVICE_ORDER:
      let order = data[1]
      switch DeviceOrders(rawValue: order) {
      case .HEAD_UP:
        print("HEAD_UP")
        isHeadUp = true
        break
      case .HEAD_UP2:
        print("HEAD_UP2")
        isHeadUp = true
        break
      case .HEAD_DOWN:
        print("HEAD_DOWN")
        isHeadUp = false
        break
      case .HEAD_DOWN2:
        print("HEAD_DOWN2")
        isHeadUp = false
        break
      case .ACTIVATED:
        print("ACTIVATED")
      case .SILENCED:
        print("SILENCED")
      case .DISPLAY_READY:
        print("DISPLAY_READY")
//        sendInitCommand(to: peripheral)// experimental
      case .TRIGGER_FOR_AI:
        print("TRIGGER AI")
      case .TRIGGER_FOR_STOP_RECORDING:
        print("STOP RECORDING")
      case .TRIGGER_CHANGE_PAGE:
        print("TRIGGER_CHANGE_PAGE")
      case .CASE_OPEN:
        self.caseOpen = true
        print("CASE OPEN");
      case .CASE_CLOSED:
        self.caseOpen = false
        print("CASE CLOSED");
      case .CASE_CHARGING_STATUS:
        guard data.count >= 3 else { break }
        let status = data[2]
        if status == 0x01 {
          self.caseCharging = true
          print("CASE CHARGING")
        } else {
          self.caseCharging = false
          print("CASE NOT CHARGING")
        }
      case .CASE_CHARGE_INFO:
        print("CASE CHARGE INFO")
        guard data.count >= 3 else { break }
        caseBatteryLevel = Int(data[2])
        print("Case battery level: \(caseBatteryLevel)%")
      case .DOUBLE_TAP:
        print("DOUBLE TAP / display turned off")
//        Task {
////          RN_sendText("DOUBLE TAP DETECTED")
////          queueChunks([[UInt8(0x00), UInt8(0x01)]])
//          try? await Task.sleep(nanoseconds: 1500 * 1_000_000) // 2s delay after sending
//          sendInit()
//          clearState()
//        }
      default:
        print("Received device order: \(data.subdata(in: 1..<data.count).hexEncodedString())")
        break
      }
    default:
      //          print("received from G1(not handled): \(data.hexEncodedString())")
      break
    }
  }
}
// MARK: Commands
extension ERG1Manager {
  
  // Handle whitelist functionality
  func getWhitelistChunks() -> [[UInt8]] {
    // Define the hardcoded whitelist JSON
    let apps = [
      AppInfo(id: "com.augment.os", name: "AugmentOS"),
      AppInfo(id: "io.heckel.ntfy", name: "ntfy")
    ]
    let whitelistJson = createWhitelistJson(apps: apps)
    
    print("Creating chunks for hardcoded whitelist: \(whitelistJson)")
    
    // Convert JSON to bytes and split into chunks
    return createWhitelistChunks(json: whitelistJson)
  }
  
  private func createWhitelistJson(apps: [AppInfo]) -> String {
    do {
      // Create app list array
      var appList: [[String: Any]] = []
      for app in apps {
        let appDict: [String: Any] = [
          "id": app.id,
          "name": app.name
        ]
        appList.append(appDict)
      }
      
      // Create the whitelist dictionary
      let whitelistDict: [String: Any] = [
        "calendar_enable": true,
        "call_enable": true,
        "msg_enable": true,
        "ios_mail_enable": true,
        "app": [
          "list": appList,
          "enable": true
        ]
      ]
      
      // Convert to JSON string
      let jsonData = try JSONSerialization.data(withJSONObject: whitelistDict, options: [])
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        return jsonString
      } else {
        return "{}"
      }
    } catch {
      print("Error creating whitelist JSON: \(error.localizedDescription)")
      return "{}"
    }
  }
  
  // Helper function to split JSON into chunks
  private func createWhitelistChunks(json: String) -> [[UInt8]] {
    let MAX_CHUNK_SIZE = 180 - 4 // Reserve space for the header
    guard let jsonData = json.data(using: .utf8) else { return [] }
    
    let totalChunks = Int(ceil(Double(jsonData.count) / Double(MAX_CHUNK_SIZE)))
    var chunks: [Data] = []
    
    print("jsonData.count = \(jsonData.count), totalChunks = \(totalChunks)")
    
    for i in 0..<totalChunks {
      let start = i * MAX_CHUNK_SIZE
      let end = min(start + MAX_CHUNK_SIZE, jsonData.count)
      let range = start..<end
      let payloadChunk = jsonData.subdata(in: range)
      
      // Create the header: [WHITELIST_CMD, total_chunks, chunk_index]
      var headerData = Data()
      headerData.append(Commands.WHITELIST.rawValue)
      headerData.append(UInt8(totalChunks))
      headerData.append(UInt8(i))
      
      // Combine header and payload
      var chunkData = Data()
      chunkData.append(headerData)
      chunkData.append(payloadChunk)
      
      chunks.append(chunkData)
    }
    
    var uintChunks: [[UInt8]] = []
    for chunk in chunks {
      uintChunks.append(Array(chunk))
    }
    return uintChunks
    //    return chunks.flatMap { Array($0) }
  }
  
  func exitAllFunctions(to peripheral: CBPeripheral, characteristic: CBCharacteristic) {
    var data = Data()
    data.append(Commands.BLE_EXIT_ALL_FUNCTIONS.rawValue)
    peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
  }
  
  private func sendInitCommand(to peripheral: CBPeripheral) {
    let initData = Data([Commands.BLE_REQ_INIT.rawValue, 0x01])
    let initDataArray = initData.map { UInt8($0) }
    
    if (leftPeripheral == peripheral) {
      queueChunks([initDataArray], sendLeft: true, sendRight: false)
    } else if (rightPeripheral == peripheral) {
      queueChunks([initDataArray], sendLeft: false, sendRight: true)
    }
  }
  
  private func sendInit() {
    let initData = Data([Commands.BLE_REQ_INIT.rawValue, 0x01])
    let initDataArray = initData.map { UInt8($0) }
    queueChunks([initDataArray])
  }
  
  // don't call semaphore signals here as it's handled elswhere:
  private func handleInitResponse(from peripheral: CBPeripheral, success: Bool) {
    if peripheral == leftPeripheral {
      leftInitialized = success
      // print("Left arm initialized: \(success)")
      setReadiness(left: true, right: nil)
    } else if peripheral == rightPeripheral {
      rightInitialized = success
      // print("Right arm initialized: \(success)")
      setReadiness(left: nil, right: true)
    }
    
    // Only proceed if both glasses are initialized
    if leftInitialized && rightInitialized {
      setReadiness(left: true, right: true)
    }
  }
  
  private func sendHeartbeat() {
    var heartbeatData = Data()
    heartbeatData.append(Commands.BLE_REQ_HEARTBEAT.rawValue)
    heartbeatData.append(UInt8(0x02 & 0xFF))
    
    var heartbeatArray = heartbeatData.map { UInt8($0) }
    
    if g1Ready {
      queueChunks([heartbeatArray])
    }
//    if let txChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: peripheral) {
//      let hexString = heartbeatData.map { String(format: "%02X", $0) }.joined()
//      peripheral.writeValue(heartbeatData, for: txChar, type: .withoutResponse)
//    }
  }
  
  public func sendCommandToSide(_ command: [UInt8], side: String) async {
    // Ensure command is exactly 20 bytes
    var paddedCommand = command
    while paddedCommand.count < 20 {
      paddedCommand.append(0x00)
    }
    
    // Convert to Data
    let commandData = Data(paddedCommand)
    //    print("Sending command to glasses: \(paddedCommand.map { String(format: "%02X", $0) }.joined(separator: " "))")
    
    if (side == "left") {
      // send to left
      if let leftPeripheral = leftPeripheral,
         let characteristic = leftPeripheral.services?
        .first(where: { $0.uuid == UART_SERVICE_UUID })?
        .characteristics?
        .first(where: { $0.uuid == UART_TX_CHAR_UUID }) {
        leftPeripheral.writeValue(commandData, for: characteristic, type: .withResponse)
      }
    } else {
      // send to right
      if let rightPeripheral = rightPeripheral,
         let characteristic = rightPeripheral.services?
        .first(where: { $0.uuid == UART_SERVICE_UUID })?
        .characteristics?
        .first(where: { $0.uuid == UART_TX_CHAR_UUID }) {
        rightPeripheral.writeValue(commandData, for: characteristic, type: .withResponse)
      }
    }
  }
  
  
  public func sendCommand(_ command: [UInt8]) async {
    // Ensure command is exactly 20 bytes
    var paddedCommand = command
    while paddedCommand.count < 20 {
      paddedCommand.append(0x00)
    }
    
    // Convert to Data
    let commandData = Data(paddedCommand)
    //    print("Sending command to glasses: \(paddedCommand.map { String(format: "%02X", $0) }.joined(separator: " "))")
    
    
    // send to left
    if let leftPeripheral = leftPeripheral,
       let characteristic = leftPeripheral.services?
      .first(where: { $0.uuid == UART_SERVICE_UUID })?
      .characteristics?
      .first(where: { $0.uuid == UART_TX_CHAR_UUID }) {
      leftPeripheral.writeValue(commandData, for: characteristic, type: .withResponse)
      try? await Task.sleep(nanoseconds: 50 * 1_000_000) // 50ms delay after sending
    }
    
    // send to right
    if let rightPeripheral = rightPeripheral,
       let characteristic = rightPeripheral.services?
      .first(where: { $0.uuid == UART_SERVICE_UUID })?
      .characteristics?
      .first(where: { $0.uuid == UART_TX_CHAR_UUID }) {
      rightPeripheral.writeValue(commandData, for: characteristic, type: .withResponse)
      try? await Task.sleep(nanoseconds: 50 * 1_000_000) // 50ms delay after sending
    }
  }
  
  public func queueChunks(_ chunks: [[UInt8]], sendLeft: Bool = true, sendRight: Bool = true, sleepAfterMs: Int = 0) {
    let bufferedCommand = BufferedCommand(chunks: chunks, sendLeft: sendLeft, sendRight: sendRight, waitTime: sleepAfterMs);
    Task {
      await commandQueue.enqueue(bufferedCommand)
    }
  }
  
  
  @objc func RN_sendWhitelist() {
    print("RN_sendWhitelist()")
    let whitelistChunks = getWhitelistChunks()
    queueChunks(whitelistChunks, sendLeft: true, sendRight: true, sleepAfterMs: 100)
  }
  
  @objc public func RN_setBrightness(_ level: Int, autoMode: Bool = false) {
    // Convert from percentage (0-100) to the correct range (0-41)
    let mappedLevel = min(41, max(0, Int((Double(level) / 100.0) * 41.0)))
    
    // Create and capture the UInt8 value
    let brightnessLevel = UInt8(mappedLevel)
    
    // Call the async function from a non-async context
    Task {
      let success = await setBrightness(brightnessLevel, autoMode: autoMode)
      if !success {
        NSLog("Failed to set brightness to level \(level)% (mapped to \(mappedLevel))")
      }
    }
  }
  
  public func setBrightness(_ level: UInt8, autoMode: Bool = false) async -> Bool {
    print("setBrightness()")
    // Ensure level is between 0x00 and 0x29 (0-41)
    var lvl: UInt8 = level
    if (level > 0x29) {
      lvl = 0x29
    }
    
    let command: [UInt8] = [Commands.BRIGHTNESS.rawValue, lvl, autoMode ? 0x01 : 0x00]
    queueChunks([command])
    
    // buried data point testing:
//    let command: [UInt8] = [0x3E]
//    queueChunks([command])
    
    //    // Send to both glasses with proper timing
    //    if let rightGlass = rightPeripheral,
    //       let rightTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: rightGlass) {
    //      rightGlass.writeValue(Data(command), for: rightTxChar, type: .withResponse)
    //      try? await Task.sleep(nanoseconds: 50 * 1_000_000) // 50ms delay
    //    }
    //
    //    if let leftGlass = leftPeripheral,
    //       let leftTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: leftGlass) {
    //      leftGlass.writeValue(Data(command), for: leftTxChar, type: .withResponse)
    //    }
    
    return true
  }
  
  @objc public func RN_setHeadUpAngle(_ angle: Int) {
    var agl: Int = angle
    if (angle < 0) {
      agl = 0;
    } else if (angle > 60) {
      agl = 60;
    }
    
    // Call the async function from a non-async context
    Task {
      let success = await setHeadUpAngle(UInt8(agl))
      if !success {
        NSLog("Failed to set angle to \(angle)")
      }
    }
  }
  
  public func setHeadUpAngle(_ angle: UInt8) async -> Bool {
    print("setHeadUpAngle()")
    let command: [UInt8] = [Commands.HEAD_UP_ANGLE.rawValue, angle, 0x01]
    queueChunks([command])
    return true
  }
  
  @objc public func RN_getBatteryStatus() {
    Task {
      await getBatteryStatus()
    }
  }
  
  public func getBatteryStatus() async {
    print("getBatteryStatus()")
    let command: [UInt8] = [0x2C, 0x01]
    queueChunks([command])
  }
  
  public func setSilentMode(_ enabled: Bool) async -> Bool {
    let command: [UInt8] = [Commands.SILENT_MODE.rawValue, enabled ? 0x0C : 0x0A, 0x00]
    queueChunks([command])
    return true
  }
  
  @objc public func RN_setDashboardPosition(_ height: Int, _ depth: Int) {
    Task {
      await setDashboardPosition(UInt8(height), UInt8(depth))
    }
  }
  
  public func setDashboardPosition(_ height: UInt8, _ depth: UInt8) async -> Bool {
    guard let rightGlass = rightPeripheral,
          let leftGlass = leftPeripheral,
          let rightTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: rightGlass),
          let leftTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: leftGlass) else {
      return false
    }
    
    let showDashboard: [UInt8] = [0x06, 0x07, 0x00, 0x02, 0x06, 0x00, 0x00]
    queueChunks([showDashboard], sleepAfterMs: 300)
    
    let h: UInt8 = min(max(height, 1), 8)
    let d: UInt8 = min(max(depth, 1), 9)
    
    // Build dashboard position command
//    var command = Data()
//    command.append(Commands.DASHBOARD_LAYOUT_COMMAND.rawValue)
//    command.append(0x08) // Length
//    command.append(0x00) // Sequence
//    command.append(0x01) // Fixed value
//    command.append(0x02) // Fixed value
//    command.append(0x01) // State ON
//    command.append(h.rawValue) // height
//    command.append(d.rawValue) // depth
    
    print("height \(h)")
    
    var command = Data()
    command.append(Commands.DASHBOARD_LAYOUT_COMMAND.rawValue)
//    command.append(0x80) // Length high byte
//    command.append(0x00) // Length low byte
//    command.append(0x00) // Sequence number
//    command.append(0x02) // Sub-command
//    command.append(0x01) // Active state
//    command.append(0x04) // height
//    command.append(d) // depth
    command.append(0x07) // Length
    command.append(0x00) // Sequence
    command.append(0x01) // Fixed value
    command.append(0x02) // Fixed value
    command.append(0x01) // State ON
    command.append(h) // height
////    command.append(d.rawValue) // depthself.isSearching = false
    
    // convert command to array of UInt8
    let commandArray = command.map { $0 }
    queueChunks([commandArray])
    
    //    // Send command to both glasses with proper timing
    //    rightGlass.writeValue(command, for: rightTxChar, type: .withResponse)
    //    try? await Task.sleep(nanoseconds: 50 * 1_000_000) // 50ms delay
    //    leftGlass.writeValue(command, for: leftTxChar, type: .withResponse)
    return true
  }
  
  @objc public func RN_setMicEnabled(_ enabled: Bool) {
    print("RN_setMicEnabled()")
    Task {
      await setMicEnabled(enabled: enabled)
    }
  }
  
  public func setMicEnabled(enabled: Bool) async -> Bool {
    guard let rightGlass = rightPeripheral,
          let rightTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: rightGlass) else {
      return false
    }
    
    var micOnData = Data()
    micOnData.append(Commands.BLE_REQ_MIC_ON.rawValue)
    if enabled {
      micOnData.append(0x01)
    } else {
      micOnData.append(0x00)
    }
    
    let micOnDataArray: [UInt8] = micOnData.map { UInt8($0) }
    
    queueChunks([micOnDataArray], sendLeft: false, sendRight: true)
    
    //    if let txChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: peripheral) {
    //      peripheral.writeValue(micOnData, for: txChar, type: .withResponse)
    //    }
    return true
  }
  
  
}

// MARK: BLE Stubs
extension ERG1Manager: CBCentralManagerDelegate, CBPeripheralDelegate {
  
  func getWriteCharacteristic(for peripheral: CBPeripheral?) -> CBCharacteristic? {
    guard let peripheral = peripheral else { return nil }
    for service in peripheral.services ?? [] {
      if service.uuid == UART_SERVICE_UUID {
        for characteristic in service.characteristics ?? [] where characteristic.uuid == UART_TX_CHAR_UUID {
          return characteristic
        }
      }
    }
    return nil
  }
  
  func extractIdNumber(_ string: String) -> Int? {
    // Pattern to match "G1_" followed by digits, followed by "_"
    let pattern = "G1_(\\d+)_"
    
    // Create a regular expression
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
      return nil
    }
    
    // Look for matches in the input string
    let range = NSRange(string.startIndex..<string.endIndex, in: string)
    guard let match = regex.firstMatch(in: string, options: [], range: range) else {
      return nil
    }
    
    // Extract the captured group (the digits)
    if let matchRange = Range(match.range(at: 1), in: string) {
      let idString = String(string[matchRange])
      return Int(idString)
    }
    
    return nil
  }
  
  public func emitDiscoveredDevice(_ name: String) {
    if name.contains("_L_") || name.contains("_R_") {
      // exampleName = "Even G1_74_L_57863C", "Even G1_3_L_57863C", "Even G1_100_L_57863C"
      guard let extractedNum = extractIdNumber(name) else { return }
      let res: [String: Any] = [
        "model_name": "Even Realities G1",
        "device_name": "\(extractedNum)",
      ]
      let eventBody: [String: Any] = [
        "compatible_glasses_search_result": res,
      ]
      
      // must convert to string before sending:
      do {
        let jsonData = try JSONSerialization.data(withJSONObject: eventBody, options: [])
        if let jsonString = String(data: jsonData, encoding: .utf8) {
          CoreCommsService.emitter.sendEvent(withName: "CoreMessageEvent", body: jsonString)
        }
      } catch {
        print("Error converting to JSON: \(error)")
      }
    }
  }
  
  // On BT discovery, automatically connect to both arms if we have them:
  public func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String : Any], rssi RSSI: NSNumber) {
    
    guard let name = peripheral.name else { return }
    guard name.contains("Even G1") else { return }
    
    print("found peripheral: \(name) - SEARCH_ID: \(DEVICE_SEARCH_ID)")
    
    if name.contains("_L_") && name.contains(DEVICE_SEARCH_ID) {
      print("Found left arm: \(name)")
      leftPeripheral = peripheral
    } else if name.contains("_R_") && name.contains(DEVICE_SEARCH_ID) {
      print("Found right arm: \(name)")
      rightPeripheral = peripheral
    }
    
    emitDiscoveredDevice(name);
    
    if leftPeripheral != nil && rightPeripheral != nil {
      //      central.stopScan()
      RN_connectGlasses()
    }
    
  }
  
  public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    print("centralManager(_:didConnect:) device connected!: \(peripheral.name ?? "Unknown")")
    peripheral.delegate = self
    peripheral.discoverServices([UART_SERVICE_UUID])

    // Store the UUIDs for future reconnection
    if peripheral == leftPeripheral || (peripheral.name?.contains("_L_") ?? false) {
        print("🔵 Storing left glass UUID: \(peripheral.identifier.uuidString)")
        leftGlassUUID = peripheral.identifier
        leftPeripheral = peripheral
    }

    if peripheral == rightPeripheral || (peripheral.name?.contains("_R_") ?? false) {
        print("🔵 Storing right glass UUID: \(peripheral.identifier.uuidString)")
        rightGlassUUID = peripheral.identifier
        rightPeripheral = peripheral
    }
    
    // Update the last connection timestamp
    lastConnectionTimestamp = Date()
    print("Connected to peripheral: \(peripheral.name ?? "Unknown")")
    
    // Emit connection event
    let isLeft = peripheral == leftPeripheral
    let eventBody: [String: Any] = [
      "side": isLeft ? "left" : "right",
      "name": peripheral.name ?? "Unknown",
      "id": peripheral.identifier.uuidString
    ]
    
    // tell iOS to reconnect to this, even from the background
//    central.connect(peripheral, options: [
//        CBConnectPeripheralOptionNotifyOnConnectionKey: true,
//        CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
//        CBConnectPeripheralOptionNotifyOnNotificationKey: true
//    ])
    
    // TODO: ios not actually used for anything yet, but we should trigger a re-connect if it was disconnected:
    //    CoreCommsService.emitter.sendEvent(withName: "onConnectionStateChanged", body: eventBody)
  }
  
  public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: (any Error)?) {
    let side = peripheral == leftPeripheral ? "LEFT" : peripheral == rightPeripheral ? "RIGHT" : "unknown"
    print("@@@@@ \(side) PERIPHERAL DISCONNECTED @@@@@")
    
    // only reconnect if we're not intentionally disconnecting:
    if self.isDisconnecting {
      return
    }
    
    if peripheral == leftPeripheral || peripheral == rightPeripheral {
      // force reconnection to both before considering us ready again:
      leftPeripheral = nil
      rightPeripheral = nil
      setReadiness(left: false, right: false)
      startReconnectionTimer()// Start periodic reconnection attempts
    }
  }
  
  private func startReconnectionTimer() {
      // Cancel any existing timer
      stopReconnectionTimer()
      
      // Reset attempt counter
      reconnectionAttempts = 0
      
      // Create a new timer on a background queue
      let queue = DispatchQueue(label: "com.sample.reconnectionTimerQueue", qos: .background)
      queue.async { [weak self] in
          guard let self = self else {
            return
          }
          self.reconnectionTimer = Timer.scheduledTimer(
              timeInterval: self.reconnectionInterval,
              target: self,
              selector: #selector(self.attemptReconnection),
              userInfo: nil,
              repeats: true
          )
        
          guard let recon = reconnectionTimer else {
            return
          }
          
          // Fire immediately for first attempt
          recon.fire()
          
          // Add timer to the run loop
          RunLoop.current.add(recon, forMode: .default)
          RunLoop.current.run()
      }
  }

  private func stopReconnectionTimer() {
      reconnectionTimer?.invalidate()
      reconnectionTimer = nil
  }
  
  // Connect by UUID
  @objc public func connectByUUID() -> Bool {
      print("🔵 Attempting to connect by UUID")
      var foundAny = false
      
      if let leftUUID = leftGlassUUID {
          print("🔵 Found stored left glass UUID: \(leftUUID.uuidString)")
          let leftDevices = centralManager!.retrievePeripherals(withIdentifiers: [leftUUID])
          
          if let leftDevice = leftDevices.first {
              print("🔵 Successfully retrieved left glass: \(leftDevice.name ?? "Unknown")")
              foundAny = true
              leftPeripheral = leftDevice
              leftDevice.delegate = self
              centralManager!.connect(leftDevice, options: [
                  CBConnectPeripheralOptionNotifyOnConnectionKey: true,
                  CBConnectPeripheralOptionNotifyOnDisconnectionKey: true
              ])
          }
      }
      
      if let rightUUID = rightGlassUUID {
          print("🔵 Found stored right glass UUID: \(rightUUID.uuidString)")
          let rightDevices = centralManager!.retrievePeripherals(withIdentifiers: [rightUUID])
          
          if let rightDevice = rightDevices.first {
              print("🔵 Successfully retrieved right glass: \(rightDevice.name ?? "Unknown")")
              foundAny = true
              rightPeripheral = rightDevice
              rightDevice.delegate = self
              centralManager!.connect(rightDevice, options: [
                  CBConnectPeripheralOptionNotifyOnConnectionKey: true,
                  CBConnectPeripheralOptionNotifyOnDisconnectionKey: true
              ])
          }
      }
      
      return foundAny
  }

  @objc private func attemptReconnection() {
      // Check if we're already connected
      if g1Ready {
          stopReconnectionTimer()
          return
      }
      
      // Check if we've exceeded maximum attempts
      if maxReconnectionAttempts > 0 && reconnectionAttempts >= maxReconnectionAttempts {
          print("Maximum reconnection attempts reached. Stopping reconnection timer.")
          stopReconnectionTimer()
          return
      }
    
      reconnectionAttempts += 1
      print("Attempting reconnection (attempt \(reconnectionAttempts))...")
      
      // Start a new scan
      RN_startScan()
  }
  
  public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if let services = peripheral.services {
      for service in services where service.uuid == UART_SERVICE_UUID {
        peripheral.discoverCharacteristics([UART_TX_CHAR_UUID, UART_RX_CHAR_UUID], for: service)
      }
    }
  }
  
  // Update peripheral(_:didDiscoverCharacteristicsFor:error:) to set services waiters
  public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard let characteristics = service.characteristics else { return }
    
    if service.uuid.isEqual(UART_SERVICE_UUID) {
      for characteristic in characteristics {
        if characteristic.uuid == UART_TX_CHAR_UUID {
          sendInitCommand(to: peripheral)
        } else if characteristic.uuid == UART_RX_CHAR_UUID {
          peripheral.setNotifyValue(true, for: characteristic)
          
          // enable notification (needed for pairing from scracth!)
          Thread.sleep(forTimeInterval: 0.5) // 500ms delay
          let CLIENT_CHARACTERISTIC_CONFIG_UUID = CBUUID(string: "00002902-0000-1000-8000-00805f9b34fb");
          if let descriptor = characteristic.descriptors?.first(where: { $0.uuid == CLIENT_CHARACTERISTIC_CONFIG_UUID }) {
            let value = Data([0x01, 0x00]) // ENABLE_NOTIFICATION_VALUE in iOS
            peripheral.writeValue(value, for: descriptor)
          } else {
            print("PROC_QUEUE - descriptor not found")
          }
        }
      }
      
      // Mark the services as ready
      if peripheral == leftPeripheral {
        print("Left glass services discovered and ready")
      } else if peripheral == rightPeripheral {
        print("Right glass services discovered and ready")
      }
    }
  }
  
  // called whenever bluetooth is initialized / turned on or off:
  public func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if central.state == .poweredOn {
      print("Bluetooth powered on")
      setReadiness(left: false, right: false)
      // only automatically start scanning if we have a SEARCH_ID, otherwise wait for RN to call startScan() itself
      if (DEVICE_SEARCH_ID != "NOT_SET" && !DEVICE_SEARCH_ID.isEmpty) {
        RN_startScan()
      }
    } else {
      print("Bluetooth is not available.")
    }
  }
  
  // called when we get data from the glasses:
  public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    if let error = error {
      print("Error updating value for characteristic: \(error.localizedDescription)")
      return
    }
    
    guard let data = characteristic.value else {
      print("Characteristic value is nil.")
      return
    }
    
    // Process the notification data
    handleNotification(from: peripheral, data: data)
  }
}

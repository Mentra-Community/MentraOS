//
//  ServerComms.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/5/25.
//

import Foundation
import Combine

protocol ServerCommsCallback {
  func onConnectionAck()
  func onAppStateChange(_ apps: [ThirdPartyCloudApp]/*, _ whatToStream: [String]*/)
  func onConnectionError(_ error: String)
  func onAuthError()
  func onMicrophoneStateChange(_ isEnabled: Bool)
  func onDisplayEvent(_ event: [String: Any])
  func onRequestSingle(_ dataType: String)
}

class ServerComms {
  private static var instance: ServerComms?
  
  public let wsManager = WebSocketManager()
  private var speechRecCallback: ((([String: Any]) -> Void))?
  private var serverCommsCallback: ServerCommsCallback?
  private var coreToken: String = ""
  private var userid: String = ""
  private var serverUrl: String = ""
  
  // Audio queue system
  private let audioQueue = DispatchQueue(label: "com.augmentos.audioQueue")
  private var audioBuffer = ArrayBlockingQueue<Data>(capacity: 100) // 10 seconds of audio assuming similar frame rates
  private var audioSenderThread: Thread?
  private var audioSenderRunning = false
  private var cancellables = Set<AnyCancellable>()
  
  private var reconnecting: Bool = false
  private var reconnectionAttempts: Int = 0
  public let calendarManager = CalendarManager()
  public let locationManager = LocationManager()
  public let mediaManager = MediaManager()
  
  static func getInstance() -> ServerComms {
    if instance == nil {
      instance = ServerComms()
    }
    return instance!
  }
  
  private init() {
    // Subscribe to WebSocket messages
    wsManager.messages
      .sink { [weak self] message in
        self?.handleIncomingMessage(message)
      }
      .store(in: &cancellables)
    
    // Subscribe to WebSocket status changes
    wsManager.status
      .sink { [weak self] status in
        self?.handleStatusChange(status)
      }
      .store(in: &cancellables)
    
    startAudioSenderThread()
    
    // every hour send calendar events again:
    let oneHour: TimeInterval = 1 * 60 * 60// 1hr
    Timer.scheduledTimer(withTimeInterval: oneHour, repeats: true) { [weak self] _ in
      print("Periodic calendar sync")
      self?.sendCalendarEvents()
    }
    
    // send location updates every 15 minutes:
    // TODO: ios (left out for now for battery savings)
//    let fifteenMinutes: TimeInterval = 15 * 60
//    Timer.scheduledTimer(withTimeInterval: fifteenMinutes, repeats: true) { [weak self] _ in
//      print("Periodic location update")
//      self?.sendLocationUpdates()
//    }
    
    // Setup calendar change notifications
    calendarManager.setCalendarChangedCallback { [weak self] in
      self?.sendCalendarEvents()
    }
    
    // setup location change notification:
    locationManager.setLocationChangedCallback { [weak self] in
      self?.sendLocationUpdates()
    }
    
  }
  
  func setAuthCredentials(_ userid: String, _ coreToken: String) {
    self.coreToken = coreToken
    self.userid = userid
  }

  private func getWsUrl() -> String {

    // extract host, port, and secure from the serverUrl:
    let url = URL(string: self.serverUrl)!
    let host = url.host!
    let port = url.port!
    let secure = url.scheme == "https"
    let wsUrl = "\(secure ? "wss" : "ws")://\(host):\(port)/glasses-ws"
    print("ServerComms: getWsUrl(): \(wsUrl)")
    return wsUrl
  }

  func setServerUrl(_ url: String) {
    self.serverUrl = url
    print("ServerComms: setServerUrl: \(url)")
    if self.wsManager.isConnected() {
      wsManager.disconnect()
      connectWebSocket()
    }
  }
  
  func setServerCommsCallback(_ callback: ServerCommsCallback) {
    self.serverCommsCallback = callback
  }
  
  func setSpeechRecCallback(_ callback: @escaping ([String: Any]) -> Void) {
    self.speechRecCallback = callback
  }
  
  // MARK: - Connection Management
  
  func connectWebSocket() {
    guard let url = URL(string: getWsUrl()) else {
      print("Invalid server URL")
      return
    }
    wsManager.connect(url: url, coreToken: self.coreToken)
  }
  
  func isWebSocketConnected() -> Bool {
    return wsManager.isConnected()
  }
  
  // MARK: - Audio / VAD
  
  func sendAudioChunk(_ audioData: Data) {
    // If the queue is full, remove the oldest entry before adding a new one
    audioBuffer.offer(audioData)
  }
  
  private func sendConnectionInit(coreToken: String) {
    do {
      let initMsg: [String: Any] = [
        "type": "connection_init",
        "coreToken": coreToken
      ]
      
      let jsonData = try JSONSerialization.data(withJSONObject: initMsg)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
        print("ServerComms: Sent connection_init message")
      }
    } catch {
      print("ServerComms: Error building connection_init JSON: \(error)")
    }
  }
  
  func sendVadStatus(_ isSpeaking: Bool) {
    let vadMsg: [String: Any] = [
      "type": "VAD",
      "status": isSpeaking
    ]
    
    let jsonData = try! JSONSerialization.data(withJSONObject: vadMsg)
    if let jsonString = String(data: jsonData, encoding: .utf8) {
      wsManager.sendText(jsonString)
    }
  }
  
  
  func sendBatteryStatus(level: Int, charging: Bool) {
    let vadMsg: [String: Any] = [
      "type": "glasses_battery_update",
      "level": level,
      "charging": charging,
      "timestamp": Date().timeIntervalSince1970 * 1000,
      // TODO: time remaining
    ]
    
    let jsonData = try! JSONSerialization.data(withJSONObject: vadMsg)
    if let jsonString = String(data: jsonData, encoding: .utf8) {
      wsManager.sendText(jsonString)
    }
  }
  
  func sendCalendarEvent(_ calendarItem: CalendarItem) {
    guard wsManager.isConnected() else {
      print("Cannot send calendar event: not connected.")
      return
    }
    
    do {
      let event: [String: Any] = [
        "type": "calendar_event",
        "title": calendarItem.title,
        "eventId": calendarItem.eventId,
        "dtStart": calendarItem.dtStart,
        "dtEnd": calendarItem.dtEnd,
        "timeZone": calendarItem.timeZone,
        "timestamp": Int(Date().timeIntervalSince1970)
      ]
      
      let jsonData = try JSONSerialization.data(withJSONObject: event)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
      }
    } catch {
      print("Error building calendar_event JSON: \(error)")
    }
  }
  
  public func sendCalendarEvents() {
    guard self.wsManager.isConnected() else { return }
    let calendarManager = CalendarManager()
    Task {
      if let events = await calendarManager.fetchUpcomingEvents(days: 2) {
        guard events.count > 0 else { return }
        // Send up to 5 events
        let eventsToSend = events.prefix(5)
        for event in eventsToSend {
          let calendarItem = convertEKEventToCalendarItem(event)
          print("CALENDAR EVENT \(calendarItem)")
          self.sendCalendarEvent(calendarItem)
        }
      }
    }
  }
  
  
  func sendLocationUpdate(lat: Double, lng: Double) {
    do {
      let event: [String: Any] = [
        "type": "location_update",
        "lat": lat,
        "lng": lng,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
      
      let jsonData = try JSONSerialization.data(withJSONObject: event)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
      }
    } catch {
      print("ServerComms: Error building location_update JSON: \(error)")
    }
  }
  
  public func sendLocationUpdates() {
    guard self.wsManager.isConnected() else {
      print("Cannot send location updates: WebSocket not connected")
      return
    }
    
    if let locationData = locationManager.getCurrentLocation() {
      print("Sending location update: lat=\(locationData.latitude), lng=\(locationData.longitude)")
      sendLocationUpdate(lat: locationData.latitude, lng: locationData.longitude)
    } else {
      print("Cannot send location update: No location data available")
    }
  }
  
  public func sendGlassesConnectionState(modelName: String, status: String) {
    do {
      let event: [String: Any] = [
        "type": "glasses_connection_state",
        "modelName": modelName,
        "status": status,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
      let jsonData = try JSONSerialization.data(withJSONObject: event)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
      }
    } catch {
      print("ServerComms: Error building location_update JSON: \(error)")
    }
  }

  
  func updateAsrConfig(languages: [[String: Any]]) {
    guard wsManager.isConnected() else {
      print("Cannot send ASR config: not connected.")
      return
    }
    
    do {
      let configMsg: [String: Any] = [
        "type": "config",
        "streams": languages
      ]
      
      let jsonData = try JSONSerialization.data(withJSONObject: configMsg)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
      }
    } catch {
      print("Error building config message: \(error)")
    }
  }
  
  // MARK: - App Lifecycle
  
  func startApp(packageName: String) {
    do {
      let msg: [String: Any] = [
        "type": "start_app",
        "packageName": packageName,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
      
      let jsonData = try JSONSerialization.data(withJSONObject: msg)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
      }
    } catch {
      print("Error building start_app JSON: \(error)")
    }
  }
  
  func stopApp(packageName: String) {
    do {
      let msg: [String: Any] = [
        "type": "stop_app",
        "packageName": packageName,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
      
      let jsonData = try JSONSerialization.data(withJSONObject: msg)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
      }
    } catch {
      print("Error building stop_app JSON: \(error)")
    }
  }
  
  // MARK: - Hardware Events
  
  func sendButtonPress(buttonId: String, pressType: String) {
    do {
      let event: [String: Any] = [
        "type": "button_press",
        "buttonId": buttonId,
        "pressType": pressType,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
      ]
      
      let jsonData = try JSONSerialization.data(withJSONObject: event)
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        wsManager.sendText(jsonString)
      }
    } catch {
      print("ServerComms: Error building button_press JSON: \(error)")
    }
  }
  
  // Add other event methods as needed (sendHeadPosition, sendGlassesBatteryUpdate, etc.)
  
  // MARK: - Message Handling
  
  private func handleIncomingMessage(_ msg: [String: Any]) {
    guard let type = msg["type"] as? String else { return }
    
    print("Received message of type: \(type)")
    
    switch type {
    case "connection_ack":
      startAudioSenderThread()
      if let callback = serverCommsCallback {
        callback.onAppStateChange(parseAppList(msg)/*, parseWhatToStream(msg)*/)
        callback.onConnectionAck()
      }
      
    case "app_state_change":
      if let callback = serverCommsCallback {
        callback.onAppStateChange(parseAppList(msg)/*, parseWhatToStream(msg)*/)
      }
      
    case "connection_error":
      let errorMsg = msg["message"] as? String ?? "Unknown error"
      if let callback = serverCommsCallback {
        callback.onConnectionError(errorMsg)
      }
      
    case "auth_error":
      if let callback = serverCommsCallback {
        callback.onAuthError()
      }
      
    case "microphone_state_change":
      print("ServerComms: microphone_state_change: \(msg)")
      let isMicrophoneEnabled = msg["isMicrophoneEnabled"] as? Bool ?? true
      if let callback = serverCommsCallback {
        callback.onMicrophoneStateChange(isMicrophoneEnabled)
      }
      
    case "display_event":
      if let view = msg["view"] as? String {
        if let callback = serverCommsCallback {
          callback.onDisplayEvent(msg)
        }
      }
      
    case "request_single":
      if let dataType = msg["data_type"] as? String, let callback = serverCommsCallback {
        callback.onRequestSingle(dataType)
      }
      
    case "interim", "final":
      // Pass speech messages to speech recognition callback
      if let callback = speechRecCallback {
        callback(msg)
      } else {
        print("ServerComms: Received speech message but speechRecCallback is null!")
      }
      
    case "reconnect":
      print("ServerComms: Server is requesting a reconnect.")
      
    default:
      print("ServerComms: Unknown message type: \(type) / full: \(msg)")
    }
  }
  
  private func attemptReconnect(_ override: Bool = false) {
    if self.reconnecting && !override { return }
    self.reconnecting = true
    
    self.connectWebSocket()
    
    // if after some time we're still not connected, run this function again:
    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
      if self.wsManager.isConnected() {
        self.reconnectionAttempts = 0
        self.reconnecting = false
        return
      }
      self.reconnectionAttempts += 1
      self.attemptReconnect(true)
    }
  }
  
  private func handleStatusChange(_ status: WebSocketStatus) {
    print("handleStatusChange: \(status)")
    
    if status == .disconnected || status == .error {
      stopAudioSenderThread()
      attemptReconnect()
    }
    
    if status == .connected {
      // Wait a second before sending connection_init (similar to the Java code)
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
        self.sendConnectionInit(coreToken: self.coreToken)
        
        self.sendCalendarEvents()
        self.sendLocationUpdates()
      }
    }
  }
  
  // MARK: - Audio Queue Sender Thread
  
  private func startAudioSenderThread() {
    if audioSenderThread != nil { return }
    
    audioSenderRunning = true
    audioSenderThread = Thread {
      while self.audioSenderRunning {
        if let chunk = self.audioBuffer.poll() {
          if self.wsManager.isConnected() {
            self.wsManager.sendBinary(chunk)
          } else {
            // Re-enqueue the chunk if not connected, then wait a bit
            self.audioBuffer.offer(chunk)
            Thread.sleep(forTimeInterval: 0.1)
          }
        } else {
          // No data in queue, wait a bit
          Thread.sleep(forTimeInterval: 0.01)
        }
      }
    }
    
    audioSenderThread?.name = "AudioSenderThread"
    audioSenderThread?.start()
  }
  
  private func stopAudioSenderThread() {
    print("stopping audio sender thread")
    audioSenderRunning = false
    audioSenderThread = nil
  }
  
  // MARK: - Helper methods
  
  private func getServerUrl() -> String {
    let host = RNCConfig.env(for: "AUGMENTOS_HOST")!;
    let port = RNCConfig.env(for: "AUGMENTOS_PORT")!;
    let secure = RNCConfig.env(for: "AUGMENTOS_SECURE")!
    let secureServer = secure.contains("true")
    let url = "\(secureServer ? "wss" : "ws")://\(host):\(port)/glasses-ws"
    print("ServerComms: getServerUrl(): \(url)")
    return url
  }
  
  func parseWhatToStream(_ msg: [String: Any]) -> [String] {
    if let userSession = msg["userSession"] as? [String: Any],
       let whatToStream = userSession["whatToStream"] as? [String] {
      return whatToStream
    }
    print("ServerComms: whatToStream was not found in server message!")
    return []
  }
  
  func parseAppList(_ msg: [String: Any]) -> [ThirdPartyCloudApp] {
    var installedApps: [[String: Any]]?
    var activeAppPackageNames: [String]?
    
    // Try to grab installedApps at the top level
    installedApps = msg["installedApps"] as? [[String: Any]]
    
    // If not found, look for "userSession.installedApps"
    if installedApps == nil {
      if let userSession = msg["userSession"] as? [String: Any] {
        installedApps = userSession["installedApps"] as? [[String: Any]]
      }
    }
    
    // Similarly, try to find activeAppPackageNames at top level or under userSession
    activeAppPackageNames = msg["activeAppPackageNames"] as? [String]
    if activeAppPackageNames == nil {
      if let userSession = msg["userSession"] as? [String: Any] {
        activeAppPackageNames = userSession["activeAppPackageNames"] as? [String]
      }
    }
    
    // Convert activeAppPackageNames into a Set for easy lookup
    var runningPackageNames = Set<String>()
    if let activeApps = activeAppPackageNames {
      for packageName in activeApps {
        if !packageName.isEmpty {
          runningPackageNames.insert(packageName)
        }
      }
    }
    
    // Build a list of ThirdPartyCloudApp objects from installedApps
    var appList: [ThirdPartyCloudApp] = []
    if let apps = installedApps {
      for appJson in apps {
        // Extract packageName first so we can check isRunning
        let packageName = appJson["packageName"] as? String ?? "unknown.package"
        
        // Check if package is in runningPackageNames
        let isRunning = runningPackageNames.contains(packageName)
        
        // Create the ThirdPartyCloudApp
        let app = ThirdPartyCloudApp(
          packageName: packageName,
          name: appJson["name"] as? String ?? "Unknown App",
          description: appJson["description"] as? String ?? "No description available.",
          webhookURL: appJson["webhookURL"] as? String ?? "",
          logoURL: appJson["logoURL"] as? String ?? "",
          isRunning: isRunning
        )
        appList.append(app)
      }
    }
    
    return appList
  }
}

// A simple implementation of ArrayBlockingQueue for Swift
class ArrayBlockingQueue<T> {
  private let queue = DispatchQueue(label: "ArrayBlockingQueue", attributes: .concurrent)
  private var array: [T] = []
  private let capacity: Int
  
  init(capacity: Int) {
    self.capacity = capacity
  }
  
  func offer(_ element: T) -> Bool {
    var result = false
    
    queue.sync(flags: .barrier) {
      if self.array.count < self.capacity {
        self.array.append(element)
        result = true
      } else if self.array.count > 0 {
        // If queue is full, remove the oldest item
        self.array.removeFirst()
        self.array.append(element)
        result = true
      }
    }
    
    return result
  }
  
  func poll() -> T? {
    var result: T?
    
    queue.sync(flags: .barrier) {
      if !self.array.isEmpty {
        result = self.array.removeFirst()
      }
    }
    
    return result
  }
  
  func take() -> T? {
    // Simple implementation - in a real blocking queue, this would actually block
    // until an element is available
    return poll()
  }
}

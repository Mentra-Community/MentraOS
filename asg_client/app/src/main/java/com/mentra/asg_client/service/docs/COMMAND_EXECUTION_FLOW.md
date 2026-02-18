# 🔄 Command Execution Flow in AsgClientService

## 📊 **Visual Flow Overview**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           COMMAND EXECUTION FLOW                            │
└─────────────────────────────────────────────────────────────────────────────┘

📱 PHONE (BLE) → 🔵 ASG CLIENT SERVICE → 🎯 COMMAND PROCESSOR → 🎪 HANDLERS
```

## 🎯 **Step-by-Step Visual Flow**

### **1. 📱 Data Reception (Entry Point)**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           onDataReceived(byte[] data)                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  📱 Bluetooth Data Received                                                 │
│  ├── Check if data is null/empty ❌ → Return                               │
│  ├── Check for K900 Protocol (##...##) ✅ → handleK900ProtocolMessage()   │
│  └── Check for JSON Message ({...}) ✅ → processJsonCommand()              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### **2. 🔄 Protocol Processing**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Protocol Detection & Parsing                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  🔍 K900 Protocol Detection:                                                │
│  ├── Check: data[0] == 0x23 && data[1] == 0x23                            │
│  ├── Find end marker: data[i] == 0x24 && data[i+1] == 0x24                │
│  ├── Extract JSON payload from position 5 to end marker                   │
│  └── Parse JSON and call processJsonCommand()                             │
│                                                                             │
│  📄 JSON Protocol Detection:                                                │
│  ├── Check: data[0] == '{'                                                 │
│  ├── Convert to String using UTF-8                                         │
│  └── Parse JSON and call processJsonCommand()                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### **3. 🎯 Command Processing (CommandProcessor)**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        processJsonCommand(JSONObject json)                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  📋 Command Processing Steps:                                              │
│  ├── 1️⃣ Extract data from command (handle C field)                        │
│  ├── 2️⃣ Send ACK if messageId present                                     │
│  ├── 3️⃣ Extract command type from "type" field                           │
│  ├── 4️⃣ Find appropriate handler in commandHandlers Map                   │
│  ├── 5️⃣ Execute handler.handleCommand(data)                              │
│  └── 6️⃣ Fallback to handleLegacyCommand() if no handler found            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### **4. 🎪 Command Handler Routing**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Command Handler Map                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  📋 Registered Handlers:                                                    │
│  ├── "phone_ready" → PhoneReadyCommandHandler                              │
│  ├── "auth_token" → AuthTokenCommandHandler                                │
│  ├── "take_photo" → PhotoCommandHandler                                    │
│  ├── "start_video_recording" → VideoCommandHandler                         │
│  ├── "ping" → PingCommandHandler                                           │
│  ├── "start_rtmp_stream" → RtmpCommandHandler                              │
│  ├── "set_wifi_credentials" → WifiCommandHandler                           │
│  ├── "battery_status" → BatteryCommandHandler                              │
│  ├── "request_version" → VersionCommandHandler                             │
│  ├── "set_photo_mode" → SettingsCommandHandler                             │
│  └── "ota_update_response" → OtaCommandHandler                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 🎯 **Command Type Categories & Flow**

### **📡 COMMUNICATION Commands**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           COMMUNICATION CATEGORY                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  📱 phone_ready:                                                           │
│  ├── PhoneReadyCommandHandler                                              │
│  ├── Update state: phoneReady = true                                       │
│  ├── Send: glasses_ready response                                          │
│  └── Response: {"type": "glasses_ready", "timestamp": ...}                 │
│                                                                             │
│  🔐 auth_token:                                                            │
│  ├── AuthTokenCommandHandler                                               │
│  ├── Save token via ConfigurationManager                                   │
│  ├── Send: token_status response                                           │
│  └── Response: {"type": "token_status", "success": true}                   │
│                                                                             │
│  🏓 ping:                                                                   │
│  ├── PingCommandHandler                                                    │
│  ├── Send: pong response                                                   │
│  └── Response: {"type": "pong", "timestamp": ...}                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### **📸 MEDIA Commands**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MEDIA CATEGORY                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  📷 take_photo:                                                            │
│  ├── PhotoCommandHandler                                                   │
│  ├── Call: MediaCaptureService.takePhoto()                                 │
│  ├── Upload: via MediaUploadService                                        │
│  └── Response: {"type": "photo_uploaded", "url": "..."}                    │
│                                                                             │
│  🎥 start_video_recording:                                                 │
│  ├── VideoCommandHandler                                                   │
│  ├── Call: MediaCaptureService.startVideoRecording()                      │
│  ├── Monitor: recording status                                             │
│  └── Response: {"type": "video_recording_status", "recording": true}       │
│                                                                             │
│  📺 start_rtmp_stream:                                                     │
│  ├── RtmpCommandHandler                                                    │
│  ├── Validate: WiFi connection                                             │
│  ├── Call: RtmpStreamingService.startStreaming()                          │
│  └── Response: {"type": "rtmp_status", "streaming": true}                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### **⚙️ SYSTEM Commands**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SYSTEM CATEGORY                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  📶 set_wifi_credentials:                                                  │
│  ├── WifiCommandHandler                                                    │
│  ├── Call: NetworkManager.connectToWifi()                                  │
│  ├── Update: WiFi state via StateManager                                   │
│  └── Response: {"type": "wifi_status", "connected": true}                  │
│                                                                             │
│  🔋 battery_status:                                                        │
│  ├── BatteryCommandHandler                                                 │
│  ├── Get: battery level from system                                        │
│  ├── Update: battery state via StateManager                                │
│  └── Response: {"type": "battery_status", "level": 85, "charging": false}  │
│                                                                             │
│  📋 request_version:                                                       │
│  ├── VersionCommandHandler                                                 │
│  ├── Get: app version, build number                                        │
│  ├── Include: device model, Android version                                │
│  └── Response: {"type": "version_info", "app_version": "1.0.0", ...}      │
│                                                                             │
│  ⚙️ set_photo_mode:                                                        │
│  ├── SettingsCommandHandler                                                │
│  ├── Update: photo mode setting                                            │
│  ├── Save: via ConfigurationManager                                        │
│  └── Response: {"type": "photo_mode_ack", "success": true}                 │
│                                                                             │
│  🔄 ota_update_response:                                                   │
│  ├── OtaCommandHandler                                                     │
│  ├── Process: OTA update response                                          │
│  ├── Trigger: download/installation                                        │
│  └── Response: {"type": "ota_progress", "status": "downloading"}           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 🔄 **Complete Flow Diagram**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           COMPLETE COMMAND FLOW                            │
└─────────────────────────────────────────────────────────────────────────────┘

📱 PHONE (BLE)
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AsgClientService.onDataReceived()                       │
│  ├── Validate data                                                         │
│  ├── Detect protocol (K900 vs JSON)                                       │
│  └── Parse and extract JSON payload                                        │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 CommandProcessor.processJsonCommand()                      │
│  ├── Extract command data                                                  │
│  ├── Send ACK if messageId present                                         │
│  ├── Extract command type                                                  │
│  └── Route to appropriate handler                                          │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Handler Selection                                │
│                                                                             │
│  📡 COMMUNICATION:                                                         │
│  ├── phone_ready → PhoneReadyCommandHandler                                │
│  ├── auth_token → AuthTokenCommandHandler                                  │
│  └── ping → PingCommandHandler                                             │
│                                                                             │
│  📸 MEDIA:                                                                 │
│  ├── take_photo → PhotoCommandHandler                                      │
│  ├── start_video_recording → VideoCommandHandler                           │
│  └── start_rtmp_stream → RtmpCommandHandler                                │
│                                                                             │
│  ⚙️ SYSTEM:                                                                │
│  ├── set_wifi_credentials → WifiCommandHandler                             │
│  ├── battery_status → BatteryCommandHandler                                │
│  ├── request_version → VersionCommandHandler                               │
│  ├── set_photo_mode → SettingsCommandHandler                               │
│  └── ota_update_response → OtaCommandHandler                               │
│                                                                             │
│  🔄 LEGACY:                                                                │
│  └── Unhandled commands → LegacyCommandHandler                             │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Handler Execution                                   │
│  ├── Validate command parameters                                           │
│  ├── Execute business logic                                                │
│  ├── Update system state                                                   │
│  └── Send response via CommunicationManager                                │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Response Flow                                       │
│  ├── CommunicationManager.sendBluetoothResponse()                         │
│  ├── Format JSON response                                                  │
│  └── Send back to phone via BLE                                            │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
📱 PHONE (BLE) ← Response Received
```

## 🎯 **Handler Execution Examples**

### **📷 Photo Command Flow**

```
📱 take_photo → PhotoCommandHandler
    ├── Extract: requestId, photoMode
    ├── Call: MediaCaptureService.takePhoto()
    ├── Upload: via MediaUploadService
    ├── Send: success/error response
    └── 📱 Response: {"type": "photo_uploaded", "url": "..."}
```

### **📶 WiFi Command Flow**

```
📱 set_wifi_credentials → WifiCommandHandler
    ├── Extract: ssid, password, authToken
    ├── Call: NetworkManager.connectToWifi()
    ├── Update: WiFi state via StateManager
    ├── Send: connection status
    └── 📱 Response: {"type": "wifi_status", "connected": true}
```

### **🔋 Battery Command Flow**

```
📱 battery_status → BatteryCommandHandler
    ├── Get: battery level from system
    ├── Update: battery state via StateManager
    ├── Send: battery status
    └── 📱 Response: {"type": "battery_status", "level": 85, "charging": false}
```

## 🔧 **Key Components in Flow**

### **1. ServiceContainer (Dependency Injection)**

- **Purpose**: Manages all dependencies and managers
- **Role**: Provides access to handlers, managers, and services
- **Flow**: Initializes all components and provides them to handlers

### **2. CommandProcessor (Command Router)**

- **Purpose**: Routes commands to appropriate handlers
- **Role**: Maintains handler registry and executes commands
- **Flow**: Receives JSON, extracts type, finds handler, executes

### **3. CommunicationManager (Response Handler)**

- **Purpose**: Handles all Bluetooth communication
- **Role**: Sends responses back to phone
- **Flow**: Formats and sends JSON responses via BLE

### **4. StateManager (State Management)**

- **Purpose**: Manages system state (WiFi, battery, etc.)
- **Role**: Updates and provides current system state
- **Flow**: Handlers update state, other components read state

### **5. ResponseBuilder (Response Creation)**

- **Purpose**: Creates standardized JSON responses
- **Role**: Ensures consistent response format
- **Flow**: Handlers use to create responses

## 🎯 **Benefits of This Architecture**

### **✅ SOLID Principles**

- **Single Responsibility**: Each handler handles one command type
- **Open/Closed**: Easy to add new handlers without modifying existing code
- **Liskov Substitution**: All handlers implement same interface
- **Interface Segregation**: Focused interfaces for each concern
- **Dependency Inversion**: Depends on abstractions, not concretions

### **✅ Maintainability**

- **Modular**: Each command type is isolated
- **Testable**: Handlers can be tested independently
- **Extensible**: Easy to add new command types
- **Debuggable**: Clear flow and logging at each step

### **✅ Performance**

- **Efficient**: Direct routing to handlers
- **Scalable**: Can handle many command types
- **Responsive**: Quick command processing and response

This architecture provides a clean, maintainable, and extensible command execution system that follows SOLID principles and provides excellent separation of concerns.

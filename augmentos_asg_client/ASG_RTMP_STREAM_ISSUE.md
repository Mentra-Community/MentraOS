# ASG RTMP Stream Issue Analysis

## **ANSWER: Complete BLE Receive Failure - NO Data Reached Glasses**

**Keep-alives AND heartbeats both failed** after 14:41:09. The glasses stopped receiving **ALL BLE data**.

- ✅ Phone successfully sent 3 keep-alives + 4 heartbeats via BLE
- ❌ Glasses received **ZERO BLE data** of any kind after 14:41:09
- ❌ No "UART read" logs, no ComManager activity, no K900MessageParser activity
- ❌ **Complete BLE receive shutdown** - not selective message failure

## Problem Summary
RTMP streams from ASG client consistently stop after 5-7 minutes due to **complete BLE receive failure** on the glasses side. The glasses can still SEND data to the phone (unidirectional failure), but cannot RECEIVE any data after ~14:41:09.

## Timeline of Investigation

### Initial Hypothesis (Incorrect)
- Thought BLE communication completely failed after 5-7 minutes
- Assumed hardware-level Bluetooth connection dropped

### Actual Root Cause (Confirmed)
- BLE connection remains functional throughout the session
- ASG client stops processing keep-alive messages specifically after ~14:41:09
- Other message types (heartbeats, battery requests) continue to work normally
- This indicates a **software-level selective message processing failure**

## Critical Timeline - June 8, 2025 14:41-14:42

### Last Successful Keep-Alive Exchange
**14:41:09** - Everything working normally:

**Phone logs:**
```
2025-06-08 14:41:09.183 SGM_Manager: Sending RTMP stream keep alive to glasses
2025-06-08 14:41:09.183 WearableAi...traLiveSGC: Sending RTMP stream keep alive
2025-06-08 14:41:09.184 WearableAi...traLiveSGC: Sending data to glasses: {"C":"{\"type\":\"keep_rtmp_stream_alive\",\"sessionId\":\"alex1115alex@gmail.com\",\"streamId\":\"d5edf945-9620-46aa-a4b8-4a3c5bbd3156\",\"ackId\":\"4e435b8b-49e6-406d-839b-40973559b250\",\"timestamp\":\"2025-06-08T21:40:54.073Z\"}","W":1}
```

**ASG Client logs:**
```
2025-06-08 14:41:09.412 K900MessageParser: Received: {"type":"keep_rtmp_stream_alive","sessionId":"alex1115alex@gmail.com","streamId":"d5edf945-9620-46aa-a4b8-4a3c5bbd3156","ackId":"4e435b8b-49e6-406d-839b-40973559b250","timestamp":"2025-06-08T21:40:54.073Z"}
2025-06-08 14:41:09.427 RtmpStreamingService: Sent: {"type":"keep_alive_ack","streamId":"d5edf945-9620-46aa-a4b8-4a3c5bbd3156","ackId":"4e435b8b-49e6-406d-839b-40973559b250","timestamp":1749418869412}
2025-06-08 14:41:09.427 RtmpStreamingService: Processed keep-alive for stream: d5edf945-9620-46aa-a4b8-4a3c5bbd3156, ackId: 4e435b8b-49e6-406d-839b-40973559b250
```

**Phone receives ACK:**
```
2025-06-08 14:41:09.696 WearableAi_ServerComms: Received keep_alive_ack from glasses, forwarding to cloud
```

---

### Failed Keep-Alive #1 - 14:41:24

**Phone sends (successfully):**
```
2025-06-08 14:41:24.141 WearableAi_ServerComms: Received KEEP_RTMP_STREAM_ALIVE: {"type":"keep_rtmp_stream_alive","sessionId":"alex1115alex@gmail.com","streamId":"d5edf945-9620-46aa-a4b8-4a3c5bbd3156","ackId":"d6f98e1c-3b32-4b96-9c6a-9d64971d4944","timestamp":"2025-06-08T21:41:24.073Z"}
2025-06-08 14:41:24.141 MentraOSService: RTMP stream keep alive received
2025-06-08 14:41:24.141 SGM_Manager: Sending RTMP stream keep alive to glasses
2025-06-08 14:41:24.142 WearableAi...traLiveSGC: Sending data to glasses: {"C":"{\"type\":\"keep_rtmp_stream_alive\",\"sessionId\":\"alex1115alex@gmail.com\",\"streamId\":\"d5edf945-9620-46aa-a4b8-4a3c5bbd3156\",\"ackId\":\"d6f98e1c-3b32-4b96-9c6a-9d64971d4944\",\"timestamp\":\"2025-06-08T21:41:24.073Z\"}","W":1}
2025-06-08 14:41:24.163 WearableAi...traLiveSGC: Characteristic write successful
```

**ASG Client (NO RESPONSE):**
```
# Last K900MessageParser activity: 14:41:09.390
# NO logs showing receipt of this keep-alive message
# NO ACK sent back to phone
```

---

### Failed Keep-Alive #2 - 14:41:39

**Phone sends (successfully):**
```
2025-06-08 14:41:39.281 WearableAi_ServerComms: Received KEEP_RTMP_STREAM_ALIVE: {"type":"keep_rtmp_stream_alive","sessionId":"alex1115alex@gmail.com","streamId":"d5edf945-9620-46aa-a4b8-4a3c5bbd3156","ackId":"df60b9a1-ee4f-4cf9-a138-173980d9fec3","timestamp":"2025-06-08T21:41:39.074Z"}
2025-06-08 14:41:39.282 MentraOSService: RTMP stream keep alive received
2025-06-08 14:41:39.282 SGM_Manager: Sending RTMP stream keep alive to glasses
2025-06-08 14:41:39.301 WearableAi...traLiveSGC: Characteristic write successful
```

**ASG Client (NO RESPONSE):**
```
# Still NO K900MessageParser activity
# NO ACK sent back to phone
```

---

### Failed Keep-Alive #3 - 14:41:54

**Phone sends (successfully):**
```
2025-06-08 14:41:54.147 WearableAi_ServerComms: Received KEEP_RTMP_STREAM_ALIVE: {"type":"keep_rtmp_stream_alive","sessionId":"alex1115alex@gmail.com","streamId":"d5edf945-9620-46aa-a4b8-4a3c5bbd3156","ackId":"27fc9f5e-f861-4cca-bf8b-8ae5e7c0ca2e","timestamp":"2025-06-08T21:41:54.074Z"}
2025-06-08 14:41:54.147 MentraOSService: RTMP stream keep alive received
2025-06-08 14:41:54.147 SGM_Manager: Sending RTMP stream keep alive to glasses
2025-06-08 14:41:54.167 WearableAi...traLiveSGC: Characteristic write successful
```

**ASG Client (NO RESPONSE):**
```
# Still NO K900MessageParser activity
# NO ACK sent back to phone
```

---

### Stream Timeout - 14:42:09

**ASG Client detects timeout (60 seconds after last ACK):**
```
2025-06-08 14:42:09.415 RtmpStreamingService: Stream timeout for streamId: d5edf945-9620-46aa-a4b8-4a3c5bbd3156
2025-06-08 14:42:09.415 RtmpStreamingService: Last keep-alive received: 1749418869412 (60 seconds ago)
2025-06-08 14:42:09.415 RtmpStreamingService: Sending timeout notification to cloud
```

**Phone receives timeout notification:**
```
2025-06-08 14:42:09.668 WearableAi...traLiveSGC: Thread-717: 🎉 onCharacteristicChanged CALLBACK TRIGGERED!
2025-06-08 14:42:09.674 WearableAi...traLiveSGC: Thread-717: 🔍 Extracted payload: {"C":"{\"type\":\"rtmp_stream_status\",\"status\":\"error\",\"errorDetails\":\"Stream timed out - no keep-alive from cloud\",\"streamId\":\"d5edf945-9620-46aa-a4b8-4a3c5bbd3156\"}","V":1,"B":{}}
2025-06-08 14:42:09.676 WearableAi_ServerComms: Sent RTMP stream status: {"type":"rtmp_stream_status","status":"error","errorDetails":"Stream timed out - no keep-alive from cloud","streamId":"d5edf945-9620-46aa-a4b8-4a3c5bbd3156"}
```

## **CRITICAL DISCOVERY: The Keep-Alive Data NEVER Reached the Glasses**

### ASG Client BLE Receive Activity Analysis

**Last successful BLE data received by glasses:**
```
2025-06-08 14:41:09.389  ComManager: UART read: 247 bytes
2025-06-08 14:41:09.390  K900MessageParser: Removed 247 bytes from buffer, 0 remaining
# This was the last keep-alive that was successfully processed
```

**After 14:41:09 - ZERO BLE Data Received:**
```
# NO MORE "UART read" entries in logs
# NO MORE K900MessageParser activity
# NO MORE CircleBuffer "Added bytes" entries
# The ASG client NEVER received the subsequent keep-alive messages from the phone
```

**Phone sending activity (confirmed working):**
```
# 14:41:24 - Phone sends keep-alive, BLE write successful
# 14:41:39 - Phone sends keep-alive, BLE write successful
# 14:41:54 - Phone sends keep-alive, BLE write successful
```

**Result: Complete BLE receive failure on glasses side after 14:41:09**

## **CLARIFICATION: Heartbeats Also Failed - Complete BLE Receive Shutdown**

### Timeline of BLE Receive Failure

**Last successful heartbeat (BEFORE failure):**
```
14:41:06 - Phone sends ping → Glasses receives & responds with pong ✅
14:41:09 - Last successful keep-alive processing ✅
```

**After 14:41:09 - TOTAL BLE RECEIVE FAILURE:**
```
14:41:36 - Phone sends ping → NO response from glasses ❌
14:42:06 - Phone sends ping + battery request → NO response from glasses ❌
14:42:36 - Phone sends ping → NO response from glasses ❌
14:43:06 - Phone sends ping → NO response from glasses ❌
```

**Phone perspective (misleading evidence):**
```
# Phone logs show "onCharacteristicChanged" at 14:42:06, 14:42:09
# BUT these are glasses SENDING data (stream timeout notification)
# NOT glasses responding to phone's pings/battery requests
```

**ASG Client perspective (definitive proof):**
```
# ZERO "UART read" logs after 14:41:09.389
# ZERO ComManager receive activity
# Glasses never received the pings sent at 14:41:36, 14:42:06, 14:42:36, 14:43:06
```

## Analysis

### What's NOT the Problem
- ❌ ~~Selective message processing failure~~
- ❌ ~~Message parsing issues~~
- ❌ ~~Software-level message filtering~~
- ❌ Phone-side sending issues

### What IS the Problem
- ✅ **COMPLETE BLE RECEIVE FAILURE** on glasses side after 14:41:09
- ✅ **Hardware-level issue** - glasses stopped receiving ANY BLE data
- ✅ **Unidirectional failure** - glasses can still SEND data to phone
- ✅ **Data never reached ComManager/UART layer** - not a parsing issue

### Implications
This points to a **hardware-level or low-level BLE driver issue**:

1. **BLE Receive Path Failure**: Hardware/driver stopped accepting incoming data
2. **UART/Serial Port Issue**: Communication path from BLE chip to main processor failed
3. **Buffer Overflow**: Low-level receive buffer got stuck/corrupted
4. **Power Management**: BLE receiver may have entered power-saving mode incorrectly
5. **Driver Bug**: Android BLE stack or K900 driver issue causing unidirectional failure

## Next Steps for Investigation

### Immediate Actions
1. **Check Android BLE logs** for connection/receive errors around 14:41:09
2. **Monitor ComManager/UART layer** for low-level receive failures
3. **Examine K900 BLE driver** for buffer management issues
4. **Test BLE receive reliability** under sustained data transmission
5. **Check power management settings** that might affect BLE receive

### Code Areas to Investigate
1. **ComManager.java** - UART/serial port communication layer
2. **K900BluetoothManager.java** - BLE driver and connection management
3. **Android BLE stack configuration** - buffer sizes, connection parameters
4. **Power management settings** - BLE receiver power states

### Reproduction Steps
1. Start RTMP stream
2. Monitor both phone and ASG logs closely
3. Look for the exact moment K900MessageParser stops processing messages
4. Check if issue occurs at consistent timeframes or message counts

## Pattern Analysis
- **Consistent timing**: Issue occurs after 5-7 minutes consistently
- **Selective failure**: Only affects keep-alive messages, not heartbeats
- **Clean failure**: No partial messages or corruption
- **Recovery**: BLE connection remains available for other operations

This suggests a **deterministic software bug** rather than hardware instability.
# UDP Audio Streaming Implementation Plan

## Overview

Replace LiveKit/WebSocket audio transport with direct UDP for lowest latency, no backpressure, truly lossy semantics. Includes automatic fallback to WebSocket when UDP is unavailable (e.g., local dev with ngrok).

## Background

### Why UDP?

1. **LiveKit Issues:** The LiveKit SDK has a bug where `OnDataPacket` stops receiving data when participant SID changes during internal WebRTC reconnections
2. **WebSocket Backpressure:** TCP-based WebSocket causes backpressure on poor connections - audio buffers up instead of dropping stale packets
3. **Cannot Fix WebSocket Backpressure:** As confirmed by our engineer, `bufferedAmount` checks only reflect the browser/app's outgoing buffer, not TCP's kernel buffer. TCP still retransmits under the hood, causing the exact backpressure problem.

### Why Not WebTransport?

- WebTransport would be ideal (UDP-like with TLS built-in)
- **Blocker:** No React Native client library exists for iOS/Android
- Would require weeks of native module development

### Infrastructure Context

- **Porter/AKS:** Our deployment uses Porter which runs on Azure Kubernetes Service (AKS)
- **AKS supports UDP:** Unlike Azure Container Apps, AKS can expose UDP LoadBalancer services
- **ngrok doesn't support UDP:** Local development with ngrok won't work with UDP, hence the fallback mechanism

---

## Architecture

### Startup Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              STARTUP FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Mobile connects WebSocket (existing flow)                               │
│  2. Server sends CONNECTION_ACK with new UDP info:                          │
│     { ..., udpEndpoint: { host, port, userIdHash } }                        │
│  3. React Native calls CoreModule.configureUdpAudio(host, port, hash)       │
│  4. Native sends UDP ping packet                                            │
│  5. Go bridge receives ping, tells TypeScript cloud                         │
│  6. Cloud sends { type: "udp_ping_ack" } over WebSocket                     │
│  7. React Native receives ack → tells native to use UDP                     │
│     OR timeout (2s) → tells native to use WebSocket fallback                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Audio Flow (UDP Active)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AUDIO FLOW (UDP)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Native (Android/iOS)                                                        │
│      │                                                                       │
│      │ PCM audio from mic                                                   │
│      ▼                                                                       │
│  UdpAudioSender.sendAudio(pcmData)                                          │
│      │                                                                       │
│      │ UDP packet: [userIdHash(4) + seq(2) + pcmData]                       │
│      ▼                                                                       │
│  ─────────────────── Internet ───────────────────                           │
│      │                                                                       │
│      ▼                                                                       │
│  Go UDP Listener (cloud-livekit-bridge:8000)                                │
│      │                                                                       │
│      │ Parse userIdHash, lookup user, forward audio                         │
│      ▼                                                                       │
│  gRPC stream to TypeScript cloud                                            │
│      │                                                                       │
│      ▼                                                                       │
│  AudioManager.processAudioData() (existing)                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Fallback Flow (WebSocket)

When UDP probe fails (timeout after 2 seconds), audio continues to flow through the existing path:

```
Native → Bridge.sendMicData() → React Native → MantleBridge →
  → LiveKit (if connected) OR WebSocket binary
```

---

## UDP Packet Format

### Audio Packet

```
┌────────────────┬────────────┬─────────────────────┐
│  userIdHash    │  sequence  │  PCM audio data     │
│  (4 bytes)     │  (2 bytes) │  (variable length)  │
│  big-endian    │  big-endian│                     │
└────────────────┴────────────┴─────────────────────┘
```

- **userIdHash:** FNV-1a hash of userId string, used to identify the user without exposing userId
- **sequence:** Rolling counter 0-65535 for detecting packet loss/reordering
- **PCM data:** Raw 16-bit PCM audio (same format as current)

### Ping Packet

```
┌────────────────┬────────────┬──────────┐
│  userIdHash    │  sequence  │  "PING"  │
│  (4 bytes)     │  (2 bytes) │  (4 bytes)│
└────────────────┴────────────┴──────────┘
```

- sequence is 0 for ping packets
- "PING" magic bytes identify this as a probe packet

---

## File Changes

### 1. Go Bridge - UDP Listener

#### NEW: `cloud/packages/cloud-livekit-bridge/udp_audio.go`

```go
package main

import (
	"encoding/binary"
	"log"
	"net"
	"sync"
)

const (
	UDP_PORT        = 8000
	PING_MAGIC      = "PING"
	MAX_PACKET_SIZE = 4096
)

type UdpAudioListener struct {
	conn          *net.UDPConn
	bridgeService *LiveKitBridgeService
	logger        *logger.BetterStackLogger
	userSessions  map[uint32]string // userIdHash -> userId
	mu            sync.RWMutex
}

func NewUdpAudioListener(bridgeService *LiveKitBridgeService, lg *logger.BetterStackLogger) (*UdpAudioListener, error) {
	addr := net.UDPAddr{Port: UDP_PORT, IP: net.ParseIP("0.0.0.0")}
	conn, err := net.ListenUDP("udp", &addr)
	if err != nil {
		return nil, err
	}

	return &UdpAudioListener{
		conn:          conn,
		bridgeService: bridgeService,
		logger:        lg,
		userSessions:  make(map[uint32]string),
	}, nil
}

func (l *UdpAudioListener) RegisterUser(userIdHash uint32, userId string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.userSessions[userIdHash] = userId
	log.Printf("UDP: Registered user %s with hash %d", userId, userIdHash)
}

func (l *UdpAudioListener) UnregisterUser(userIdHash uint32) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.userSessions, userIdHash)
}

func (l *UdpAudioListener) Start() {
	log.Printf("✅ UDP Audio Listener started on port %d", UDP_PORT)
	l.logger.LogInfo("UDP Audio Listener started", map[string]interface{}{
		"port": UDP_PORT,
	})

	buf := make([]byte, MAX_PACKET_SIZE)

	for {
		n, remoteAddr, err := l.conn.ReadFromUDP(buf)
		if err != nil {
			log.Printf("UDP read error: %v", err)
			continue
		}

		if n < 6 {
			continue // Too small (need at least userIdHash + seq)
		}

		// Parse header
		userIdHash := binary.BigEndian.Uint32(buf[0:4])
		seq := binary.BigEndian.Uint16(buf[4:6])

		// Check if this is a ping packet
		if n >= 10 && string(buf[6:10]) == PING_MAGIC {
			l.handlePing(userIdHash, remoteAddr)
			continue
		}

		// Get userId from hash
		l.mu.RLock()
		userId, ok := l.userSessions[userIdHash]
		l.mu.RUnlock()

		if !ok {
			// Unknown user, drop packet
			continue
		}

		// Extract PCM data
		pcmData := buf[6:n]

		// Forward to bridge service for processing
		l.bridgeService.HandleUdpAudio(userId, seq, pcmData)
	}
}

func (l *UdpAudioListener) handlePing(userIdHash uint32, addr *net.UDPAddr) {
	l.mu.RLock()
	userId, ok := l.userSessions[userIdHash]
	l.mu.RUnlock()

	if !ok {
		log.Printf("UDP: Ping from unknown userIdHash %d", userIdHash)
		return
	}

	log.Printf("UDP: Ping received from user %s (hash %d) at %s", userId, userIdHash, addr.String())

	// Notify TypeScript cloud to send udp_ping_ack over WebSocket
	l.bridgeService.NotifyUdpPingReceived(userId)
}

func (l *UdpAudioListener) Close() {
	if l.conn != nil {
		l.conn.Close()
	}
}
```

#### MODIFY: `cloud/packages/cloud-livekit-bridge/service.go`

Add to `LiveKitBridgeService` struct:

```go
type LiveKitBridgeService struct {
	// ... existing fields ...
	udpListener   *UdpAudioListener
	udpPingChan   map[string]chan struct{} // userId -> ping notification channel
	udpPingChanMu sync.RWMutex
}
```

Add methods:

```go
func (s *LiveKitBridgeService) HandleUdpAudio(userId string, seq uint16, pcmData []byte) {
	// Find the active stream for this user and forward audio
	// Similar to how LiveKit audio is handled in StreamAudio
	s.mu.RLock()
	stream, ok := s.activeStreams[userId]
	s.mu.RUnlock()

	if !ok {
		return
	}

	// Forward to the gRPC stream
	stream.Send(&pb.AudioChunk{
		UserId:    userId,
		Sequence:  uint32(seq),
		AudioData: pcmData,
		Timestamp: time.Now().UnixMilli(),
	})
}

func (s *LiveKitBridgeService) NotifyUdpPingReceived(userId string) {
	// This will be called via gRPC to the TypeScript cloud
	// to trigger sending udp_ping_ack over WebSocket
	s.logger.LogInfo("UDP ping received", map[string]interface{}{
		"userId": userId,
	})

	// Notify via existing gRPC mechanism or add new RPC
}
```

#### MODIFY: `cloud/packages/cloud-livekit-bridge/main.go`

Add UDP listener startup:

```go
func main() {
	// ... existing code ...

	// Create bridge service
	bridgeService := NewLiveKitBridgeService(config, bsLogger)
	pb.RegisterLiveKitBridgeServer(grpcServer, bridgeService)

	// NEW: Start UDP audio listener
	udpListener, err := NewUdpAudioListener(bridgeService, bsLogger)
	if err != nil {
		log.Printf("Warning: Failed to start UDP listener: %v", err)
		bsLogger.LogWarn("UDP listener failed to start", map[string]interface{}{
			"error": err.Error(),
		})
	} else {
		bridgeService.udpListener = udpListener
		go udpListener.Start()
	}

	// ... rest of existing code ...
}
```

---

### 2. Proto Definition Update

#### MODIFY: `cloud/packages/cloud-livekit-bridge/proto/livekit_bridge.proto`

Add new messages and RPC:

```protobuf
import "google/protobuf/empty.proto";

// Add to existing messages
message RegisterUdpUserRequest {
  string user_id = 1;
  uint32 user_id_hash = 2;
}

message RegisterUdpUserResponse {
  bool success = 1;
}

message UdpPingNotification {
  string user_id = 1;
}

// Add to LiveKitBridge service
service LiveKitBridge {
  // ... existing RPCs ...

  // UDP user registration
  rpc RegisterUdpUser(RegisterUdpUserRequest) returns (RegisterUdpUserResponse);

  // Stream for UDP ping notifications (server -> client streaming)
  rpc SubscribeUdpPings(google.protobuf.Empty) returns (stream UdpPingNotification);
}
```

---

### 3. TypeScript Cloud Changes

#### MODIFY: `cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts`

Add UDP registration and ping subscription:

```typescript
// Add to class
private udpPingSubscription?: grpc.ClientReadableStream<UdpPingNotification>;

async registerUdpUser(userId: string, userIdHash: number): Promise<void> {
  return new Promise((resolve, reject) => {
    this.client.registerUdpUser(
      { userId, userIdHash },
      (err, response) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

subscribeToUdpPings(onPing: (userId: string) => void): void {
  this.udpPingSubscription = this.client.subscribeUdpPings({});

  this.udpPingSubscription.on('data', (notification: UdpPingNotification) => {
    onPing(notification.userId);
  });

  this.udpPingSubscription.on('error', (err) => {
    this.logger.error({ err }, 'UDP ping subscription error');
  });
}
```

#### MODIFY: `cloud/packages/cloud/src/services/session/UserSession.ts`

Add userId hash computation and UDP ping handling:

```typescript
// Add to class properties
public readonly userIdHash: number;

// Add to constructor
this.userIdHash = this.computeUserIdHash(userId);

// Add method
private computeUserIdHash(userId: string): number {
  // FNV-1a hash
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0; // Ensure unsigned 32-bit
}

// Add method to send UDP ping ack
sendUdpPingAck(): void {
  this.sendMessage({ type: 'udp_ping_ack' });
}
```

#### MODIFY: `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts`

Add UDP registration on session init:

```typescript
async handleLiveKitInit(userSession: UserSession): Promise<ConnectionAckLivekit> {
  // ... existing code ...

  // Register user for UDP audio
  await this.grpcClient.registerUdpUser(
    userSession.userId,
    userSession.userIdHash
  );

  return {
    url: this.livekitUrl,
    roomName: userSession.userId,
    token: token,
    // NEW: Add UDP endpoint info
    udpEndpoint: {
      host: process.env.UDP_AUDIO_HOST || this.getPublicHost(),
      port: 8000,
      userIdHash: userSession.userIdHash,
    },
  };
}
```

#### MODIFY: `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`

Set up UDP ping listener on startup:

```typescript
// In initialization
livekitGrpcClient.subscribeToUdpPings((userId: string) => {
  const session = UserSession.sessions.get(userId)
  if (session) {
    session.sendUdpPingAck()
  }
})
```

---

### 4. Android Native Module

#### NEW: `mobile/modules/core/android/src/main/java/com/mentra/core/services/UdpAudioSender.kt`

```kotlin
package com.mentra.core.services

import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class UdpAudioSender {
    companion object {
        private const val TAG = "UdpAudioSender"
        private const val PING_MAGIC = "PING"

        @Volatile
        private var instance: UdpAudioSender? = null

        @JvmStatic
        fun getInstance(): UdpAudioSender {
            return instance ?: synchronized(this) {
                instance ?: UdpAudioSender().also { instance = it }
            }
        }
    }

    private var socket: DatagramSocket? = null
    private var serverAddress: InetAddress? = null
    private var serverPort: Int = 8000
    private var userIdHash: Int = 0
    private var sequence: AtomicInteger = AtomicInteger(0)
    private var isConfigured: AtomicBoolean = AtomicBoolean(false)
    private var useUdp: AtomicBoolean = AtomicBoolean(false)
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    fun configure(host: String, port: Int, userIdHash: Int) {
        executor.execute {
            try {
                close()
                serverAddress = InetAddress.getByName(host)
                serverPort = port
                this.userIdHash = userIdHash
                socket = DatagramSocket()
                isConfigured.set(true)
                Log.d(TAG, "Configured UDP sender: $host:$port, hash=$userIdHash")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to configure UDP sender", e)
                isConfigured.set(false)
            }
        }
    }

    fun sendPing() {
        if (!isConfigured.get()) return

        executor.execute {
            try {
                // Packet: [userIdHash(4) + seq(2) + "PING"]
                val buffer = ByteBuffer.allocate(10)
                    .order(ByteOrder.BIG_ENDIAN)
                    .putInt(userIdHash)
                    .putShort(0) // seq not used for ping
                    .put(PING_MAGIC.toByteArray())

                val packet = DatagramPacket(
                    buffer.array(),
                    buffer.capacity(),
                    serverAddress,
                    serverPort
                )
                socket?.send(packet)
                Log.d(TAG, "Sent UDP ping")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send UDP ping", e)
            }
        }
    }

    fun setUseUdp(use: Boolean) {
        useUdp.set(use)
        Log.d(TAG, "UDP audio ${if (use) "enabled" else "disabled"}")
    }

    fun shouldUseUdp(): Boolean {
        return isConfigured.get() && useUdp.get()
    }

    fun sendAudio(pcmData: ByteArray) {
        if (!shouldUseUdp()) return

        executor.execute {
            try {
                val seq = (sequence.incrementAndGet() and 0xFFFF).toShort()

                // Packet: [userIdHash(4) + seq(2) + pcmData]
                val buffer = ByteBuffer.allocate(6 + pcmData.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .putInt(userIdHash)
                    .putShort(seq)
                    .put(pcmData)

                val packet = DatagramPacket(
                    buffer.array(),
                    buffer.capacity(),
                    serverAddress,
                    serverPort
                )
                socket?.send(packet)
            } catch (e: Exception) {
                // Fire and forget - don't log every failure
            }
        }
    }

    fun close() {
        try {
            socket?.close()
        } catch (e: Exception) {
            // Ignore
        }
        socket = null
        isConfigured.set(false)
        useUdp.set(false)
    }
}
```

#### MODIFY: `mobile/modules/core/android/src/main/java/com/mentra/core/Bridge.kt`

Add UDP methods:

```kotlin
// Add import at top
import com.mentra.core.services.UdpAudioSender

// Add to companion object

@JvmStatic
fun configureUdpAudio(host: String, port: Int, userIdHash: Int) {
    UdpAudioSender.getInstance().configure(host, port, userIdHash)
}

@JvmStatic
fun sendUdpPing() {
    UdpAudioSender.getInstance().sendPing()
}

@JvmStatic
fun setUseUdpAudio(use: Boolean) {
    UdpAudioSender.getInstance().setUseUdp(use)
}

// MODIFY existing sendMicData - replace the function
@JvmStatic
fun sendMicData(data: ByteArray) {
    // Try UDP first
    if (UdpAudioSender.getInstance().shouldUseUdp()) {
        UdpAudioSender.getInstance().sendAudio(data)
        return
    }

    // Fallback to WebSocket via React Native
    val base64String = Base64.encodeToString(data, Base64.NO_WRAP)
    val body = HashMap<String, Any>()
    body["base64"] = base64String
    sendTypedMessage("mic_data", body as Map<String, Any>)
}
```

#### MODIFY: `mobile/modules/core/android/src/main/java/com/mentra/core/CoreModule.kt`

Add UDP functions to definition() block:

```kotlin
AsyncFunction("configureUdpAudio") { host: String, port: Int, userIdHash: Int ->
    Bridge.configureUdpAudio(host, port, userIdHash)
}

AsyncFunction("sendUdpPing") {
    Bridge.sendUdpPing()
}

AsyncFunction("setUseUdpAudio") { use: Boolean ->
    Bridge.setUseUdpAudio(use)
}
```

---

### 5. iOS Native Module

#### NEW: `mobile/modules/core/ios/Source/services/UdpAudioSender.swift`

```swift
import Foundation
import Network

class UdpAudioSender {
    static let shared = UdpAudioSender()

    private var connection: NWConnection?
    private var userIdHash: UInt32 = 0
    private var sequence: UInt16 = 0
    private var isConfigured = false
    private var useUdp = false
    private let queue = DispatchQueue(label: "UdpAudioSender", qos: .userInteractive)
    private let pingMagic = "PING"

    private init() {}

    func configure(host: String, port: UInt16, userIdHash: UInt32) {
        queue.async { [weak self] in
            self?.close()

            guard let self = self else { return }

            self.userIdHash = userIdHash

            let endpoint = NWEndpoint.hostPort(
                host: NWEndpoint.Host(host),
                port: NWEndpoint.Port(rawValue: port)!
            )

            self.connection = NWConnection(to: endpoint, using: .udp)
            self.connection?.start(queue: self.queue)
            self.isConfigured = true

            Bridge.log("UdpAudioSender: Configured for \(host):\(port), hash=\(userIdHash)")
        }
    }

    func sendPing() {
        guard isConfigured, let conn = connection else { return }

        queue.async { [weak self] in
            guard let self = self else { return }

            var packet = Data(capacity: 10)

            // Header: userIdHash(4) + seq(2) + "PING"
            var hash = self.userIdHash.bigEndian
            var seq: UInt16 = 0

            packet.append(Data(bytes: &hash, count: 4))
            packet.append(Data(bytes: &seq, count: 2))
            packet.append(self.pingMagic.data(using: .utf8)!)

            conn.send(content: packet, completion: .idempotent)
            Bridge.log("UdpAudioSender: Sent ping")
        }
    }

    func setUseUdp(_ use: Bool) {
        useUdp = use
        Bridge.log("UdpAudioSender: UDP audio \(use ? "enabled" : "disabled")")
    }

    func shouldUseUdp() -> Bool {
        return isConfigured && useUdp
    }

    func sendAudio(_ pcmData: Data) {
        guard shouldUseUdp(), let conn = connection, conn.state == .ready else { return }

        queue.async { [weak self] in
            guard let self = self else { return }

            var packet = Data(capacity: 6 + pcmData.count)

            // Header: userIdHash(4) + seq(2)
            var hash = self.userIdHash.bigEndian
            self.sequence &+= 1
            var seq = self.sequence.bigEndian

            packet.append(Data(bytes: &hash, count: 4))
            packet.append(Data(bytes: &seq, count: 2))
            packet.append(pcmData)

            conn.send(content: packet, completion: .idempotent)
        }
    }

    func close() {
        connection?.cancel()
        connection = nil
        isConfigured = false
        useUdp = false
    }
}
```

#### MODIFY: `mobile/modules/core/ios/Source/Bridge.swift`

Add UDP methods:

```swift
// Add methods to Bridge class

static func configureUdpAudio(_ host: String, _ port: UInt16, _ userIdHash: UInt32) {
    UdpAudioSender.shared.configure(host: host, port: port, userIdHash: userIdHash)
}

static func sendUdpPing() {
    UdpAudioSender.shared.sendPing()
}

static func setUseUdpAudio(_ use: Bool) {
    UdpAudioSender.shared.setUseUdp(use)
}

// MODIFY existing sendMicData - replace the function
static func sendMicData(_ data: Data) {
    // Try UDP first
    if UdpAudioSender.shared.shouldUseUdp() {
        UdpAudioSender.shared.sendAudio(data)
        return
    }

    // Fallback to WebSocket via React Native
    let base64String = data.base64EncodedString()
    let body = ["base64": base64String]
    Bridge.sendTypedMessage("mic_data", body: body)
}
```

#### MODIFY: `mobile/modules/core/ios/CoreModule.swift`

Add UDP functions to definition():

```swift
AsyncFunction("configureUdpAudio") { (host: String, port: Int, userIdHash: Int) in
    Bridge.configureUdpAudio(host, UInt16(port), UInt32(userIdHash))
}

AsyncFunction("sendUdpPing") {
    Bridge.sendUdpPing()
}

AsyncFunction("setUseUdpAudio") { (use: Bool) in
    Bridge.setUseUdpAudio(use)
}
```

---

### 6. React Native - UDP Probe & Fallback

#### MODIFY: `mobile/src/services/SocketComms.ts`

Add UDP handling:

```typescript
// Add import at top
import CoreModule from "core"

// Add to class properties
private udpProbeTimeout: NodeJS.Timeout | null = null

// MODIFY handle_connection_ack method
private async handle_connection_ack(msg: any) {
  console.log("SOCKET: connection ack received")

  // Handle UDP endpoint if provided
  if (msg.udpEndpoint) {
    await this.probeUdp(msg.udpEndpoint)
  }

  // Existing LiveKit connection (still needed for non-UDP fallback)
  const isChina = await useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)
  if (!isChina) {
    await livekit.connect()
  }

  GlobalEventEmitter.emit("APP_STATE_CHANGE", msg)
}

// Add new method
private async probeUdp(endpoint: { host: string; port: number; userIdHash: number }): Promise<void> {
  console.log("SOCKET: Probing UDP endpoint", endpoint)

  // Configure native UDP sender
  await CoreModule.configureUdpAudio(endpoint.host, endpoint.port, endpoint.userIdHash)

  return new Promise((resolve) => {
    // Set up timeout for fallback
    this.udpProbeTimeout = setTimeout(() => {
      console.log("SOCKET: UDP probe timeout - falling back to WebSocket")
      CoreModule.setUseUdpAudio(false)
      resolve()
    }, 2000)

    // Listen for UDP ping ack
    const handleAck = () => {
      if (this.udpProbeTimeout) {
        clearTimeout(this.udpProbeTimeout)
        this.udpProbeTimeout = null
      }
      console.log("SOCKET: UDP probe successful - using UDP for audio")
      CoreModule.setUseUdpAudio(true)
      GlobalEventEmitter.off("UDP_PING_ACK", handleAck)
      resolve()
    }

    GlobalEventEmitter.on("UDP_PING_ACK", handleAck)

    // Send UDP ping
    CoreModule.sendUdpPing()
  })
}

// Add to handle_message switch statement
case "udp_ping_ack":
  GlobalEventEmitter.emit("UDP_PING_ACK", {})
  break
```

---

### 7. Porter/Kubernetes Configuration

#### MODIFY: `cloud/porter-livekit.yaml`

```yaml
version: v2
namespace: ${PORTER_NAMESPACE}

build:
  method: docker
  context: ./cloud/.
  dockerfile: ./cloud/docker/Dockerfile.livekit

services:
  - name: cloud
    type: web
    run: ./start.sh
    port: 80
    cpuCores: 5
    ramMegabytes: 4096
    env:
      HOST: "0.0.0.0"
      SERVICE_NAME: "cloud"
      RTMP_RELAY_URLS: "rtmp-relay-uscentral.mentra.glass:1935"
      LIVEKIT_GRPC_SOCKET: "/tmp/livekit-bridge.sock"
      LIVEKIT_PCM_ENDIAN: "off"
      LOG_LEVEL: "info"
      BETTERSTACK_SOURCE_TOKEN: "${BETTERSTACK_SOURCE_TOKEN}"
      BETTERSTACK_INGESTING_HOST: "s1311181.eu-nbg-2.betterstackdata.com"

  # NEW: UDP audio service
  - name: audio-udp
    type: worker
    run: "" # Uses same container, Go listens on UDP
    port: 8000
    protocol: udp # KEY: This tells Porter/K8s to create UDP LoadBalancer
    env: {}
```

**Note:** Verify Porter's exact syntax for UDP services. May require different service type or annotations.

---

### 8. Environment Variables

**No new environment variables needed!**

The UDP host is the same as the cloud host - mobile already knows this from `backend_url` setting. The server just needs to return the hostname extracted from the incoming WebSocket connection or use the same `HOST` env var.

In `LiveKitManager.ts`, extract host from the WebSocket URL or env:

```typescript
// In handleLiveKitInit:
udpEndpoint: {
  host: process.env.HOST || this.extractHostFromRequest(userSession),
  port: 8000,
  userIdHash: userSession.userIdHash,
}
```

Or even simpler - the mobile can derive it:

```typescript
// In SocketComms.ts probeUdp:
// The backend_url is already known (e.g., https://cloud.augmentos.org)
// UDP endpoint is just the same host on port 8000
const backendUrl = useSettingsStore.getState().getSetting(SETTINGS.backend_url.key)
const url = new URL(backendUrl)
const udpHost = url.hostname // "cloud.augmentos.org"
```

This way:

- No new env vars needed
- Works automatically with custom backend URLs for dev
- Single source of truth for the server address

---

## Summary of All File Changes

| Component            | Files Changed                                                                     | New Files                       |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| **Go Bridge**        | `main.go`, `service.go`, `proto/livekit_bridge.proto`                             | `udp_audio.go`                  |
| **TypeScript Cloud** | `LiveKitGrpcClient.ts`, `LiveKitManager.ts`, `UserSession.ts`, `bun-websocket.ts` | -                               |
| **Android Native**   | `Bridge.kt`, `CoreModule.kt`                                                      | `services/UdpAudioSender.kt`    |
| **iOS Native**       | `Bridge.swift`, `CoreModule.swift`                                                | `services/UdpAudioSender.swift` |
| **React Native**     | `SocketComms.ts`                                                                  | -                               |
| **Porter Config**    | `porter-livekit.yaml`                                                             | -                               |

---

## Testing Plan

### Local Development (ngrok)

1. Start cloud locally with ngrok
2. Connect mobile app
3. UDP probe should timeout after 2 seconds
4. Falls back to WebSocket
5. Audio/transcription works as before

### Staging (AKS with UDP)

1. Deploy to staging with UDP LoadBalancer
2. Connect mobile app
3. UDP probe should succeed
4. Audio flows over UDP
5. Check logs for UDP packet reception
6. Verify transcription quality

### Edge Cases

1. **Network switch mid-session:** UDP continues (connectionless)
2. **Server restart:** Next CONNECTION_ACK re-probes UDP
3. **Firewall blocks UDP:** Probe times out, falls back to WebSocket
4. **Poor network:** UDP packets drop gracefully, transcription handles gaps

---

## Security Considerations

### Current Approach (Minimal)

- **userIdHash** provides minimal obfuscation (not security)
- Acceptable for internal beta
- Attacker would need to know server IP, port, AND valid hash

### Future Improvements (If Needed)

1. **HMAC signature:** Add 16-byte HMAC to each packet
2. **Rate limiting:** Limit packets per source IP
3. **Session tokens:** Include rotating session token in packets

---

## Rollback Plan

If UDP causes issues:

1. Set `UDP_AUDIO_HOST` to empty/invalid → all clients fall back to WebSocket
2. Or: Comment out `udpEndpoint` from CONNECTION_ACK response
3. No client-side changes needed - fallback is automatic

---

## Timeline Estimate

| Phase       | Tasks                                                        |
| ----------- | ------------------------------------------------------------ |
| **Phase 1** | Go UDP listener, proto updates, basic TypeScript integration |
| **Phase 2** | Android native module, iOS native module                     |
| **Phase 3** | React Native probe/fallback, Porter config                   |
| **Phase 4** | Testing, debugging, deployment                               |

---

## Open Questions

1. **Porter UDP syntax:** Need to verify exact configuration for UDP services
2. **Public hostname:** How to get public IP/hostname for UDP endpoint in CONNECTION_ACK
3. **Monitoring:** How to monitor UDP packet loss / audio quality metrics

# UDP Client Improvements (Cloud-Side)

Sub-issue for cloud changes to support dynamic UDP host discovery and packet reordering.

## 1. Dynamic UDP Host Discovery

### Problem

Mobile needs UDP host configured manually. Cloud should send UDP endpoint in `connection_ack`.

### Cloud Changes

**Add to `connection_ack` response:**

```json
{
  "type": "connection_ack",
  "udpHost": "172.168.226.103",
  "udpPort": 8000,
  ...existing fields
}
```

**Implementation:**

1. Add env vars to porter configs:
   - `UDP_HOST` - LoadBalancer IP for this environment
   - `UDP_PORT` - Always `8000`

2. Update `connection_ack` handler to include UDP fields:
   - `packages/cloud/src/services/session/handlers/glasses-message-handler.ts`
   - Read from `process.env.UDP_HOST` and `process.env.UDP_PORT`

**Per-Environment UDP Hosts (porter.yaml):**

| Environment   | Cluster | UDP_HOST          |
| ------------- | ------- | ----------------- |
| debug         | 4689    | `172.168.226.103` |
| dev           | 4689    | TBD               |
| staging       | 4689    | TBD               |
| prod (US)     | 4689    | TBD               |
| prod (France) | 4696    | TBD               |
| prod (Asia)   | 4754    | TBD               |

---

## 2. Packet Reordering

### Problem

UDP packets arrive out of order. Need server-side reorder buffer.

### Design

```
Packet arrives (seq=5) → buffer, wait for seq=4
Packet arrives (seq=4) → process 4, then 5 from buffer
```

**Parameters:**

- Buffer size: 10 packets max
- Timeout: 20ms (don't delay more than one chunk)
- Max gap: 50 (if gap > 50, reset sequence tracking)

### Implementation

New file: `packages/cloud/src/services/udp/UdpReorderBuffer.ts`

```typescript
interface BufferedPacket {
  sequence: number;
  data: Buffer;
  receivedAt: number;
}

class UdpReorderBuffer {
  private buffer: Map<number, BufferedPacket>;
  private expectedSeq: number;

  addPacket(seq: number, data: Buffer): Buffer[] {
    // Returns packets to process in order
  }

  flush(): Buffer[] {
    // Flush on timeout
  }
}
```

**Integration:**

- One `UdpReorderBuffer` per registered session
- Call `addPacket()` in `UdpAudioServer.handlePacket()`
- Process returned packets in order

**Edge cases:**

- Sequence wraps at 65535
- First packet sets initial expected sequence
- Large gap → assume loss, reset and continue

---

## Status

- [x] Add `UDP_HOST`/`UDP_PORT` env vars to porter configs (via `porter env set`)
- [x] Include `udpHost`/`udpPort` in `connection_ack` response (`bun-websocket.ts`)
- [x] Create `UdpReorderBuffer` class (`services/udp/UdpReorderBuffer.ts`)
- [x] Integrate reorder buffer into `UdpAudioServer`
- [ ] Test with out-of-order packets

## Priority

1. **Dynamic host in connection_ack** - Unblocks mobile
2. **Packet reordering** - Improves audio quality

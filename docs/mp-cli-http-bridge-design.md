# MP-CLI HTTP Bridge Design

## Purpose

Expose mp-cli commands via HTTP API so MentraOS mobile app can execute them from the G1 glasses interface.

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐         ┌──────────┐
│  G1 Glasses │ ◄─BLE─► │ MentraOS App │ ◄─HTTP─► │ HTTP Bridge │ ◄─CLI─► │  mp-cli  │
│             │         │   (Phone)    │         │  (Mac/Local)│         │ (Python) │
└─────────────┘         └──────────────┘         └─────────────┘         └──────────┘
```

## Design Principles

1. **Stateless** - Each request is independent
2. **Secure** - Local network only, token-based auth
3. **Fast** - < 500ms response time for common commands
4. **Simple** - RESTful API, JSON responses
5. **Observable** - Logging and metrics for debugging

## API Design

### Base URL
```
http://localhost:8421/api/v1
```

Port `8421` chosen to avoid conflicts (84 = MP, 21 = CLI)

### Authentication

**Token-based auth** - Generate token on first run, store in both server and mobile app.

```http
Authorization: Bearer <token>
```

Token stored in:
- Server: `~/.mp-cli-bridge/token`
- Mobile: Secure storage (Keychain/KeyStore)

### Endpoints

#### 1. Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "mp_cli_version": "0.1.0"
}
```

**Use case:** Verify server is running before making requests

---

#### 2. Execute Command
```http
POST /execute
Content-Type: application/json
Authorization: Bearer <token>

{
  "command": "next",
  "args": [],
  "options": {}
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "tasks": [...],
    "stakeholders": [...]
  },
  "execution_time_ms": 234,
  "timestamp": "2026-02-17T19:55:00Z"
}
```

**Error Response:**
```json
{
  "success": false,
  "error": {
    "code": "COMMAND_FAILED",
    "message": "Command 'next' failed: ...",
    "details": "..."
  },
  "execution_time_ms": 123,
  "timestamp": "2026-02-17T19:55:00Z"
}
```

**Use case:** Execute any mp-cli command

---

#### 3. Batch Execute
```http
POST /batch
Content-Type: application/json
Authorization: Bearer <token>

{
  "commands": [
    {"command": "next", "args": []},
    {"command": "sh", "args": ["list"]},
    {"command": "calendar", "args": ["today"]}
  ]
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {"success": true, "data": {...}},
    {"success": true, "data": {...}},
    {"success": true, "data": {...}}
  ],
  "execution_time_ms": 456,
  "timestamp": "2026-02-17T19:55:00Z"
}
```

**Use case:** Fetch dashboard data in one request

---

#### 4. Stream Command (WebSocket)
```
ws://localhost:8421/api/v1/stream?token=<token>
```

**Client sends:**
```json
{
  "command": "sh",
  "args": ["m", "c", "--days", "1"],
  "stream": true
}
```

**Server streams:**
```json
{"type": "progress", "message": "Loading messages..."}
{"type": "data", "chunk": {...}}
{"type": "data", "chunk": {...}}
{"type": "complete", "total": 42}
```

**Use case:** Long-running commands with progress updates

---

#### 5. Subscribe to Events (WebSocket)
```
ws://localhost:8421/api/v1/events?token=<token>
```

**Server pushes:**
```json
{
  "type": "new_message",
  "data": {
    "from": "Alice",
    "preview": "Hey, are we still on for...",
    "timestamp": "2026-02-17T19:55:00Z"
  }
}
```

```json
{
  "type": "calendar_reminder",
  "data": {
    "event": "Meeting with Bob",
    "starts_in_minutes": 15
  }
}
```

**Use case:** Push notifications to G1

---

#### 6. Get Available Commands
```http
GET /commands
Authorization: Bearer <token>
```

**Response:**
```json
{
  "commands": [
    {
      "name": "next",
      "description": "Show what needs to happen next",
      "args": [],
      "options": []
    },
    {
      "name": "sh",
      "description": "Stakeholder commands",
      "subcommands": ["list", "brief", "signals", ...]
    },
    ...
  ]
}
```

**Use case:** Dynamic command discovery for UI

---

#### 7. Voice Command Parser
```http
POST /parse-voice
Content-Type: application/json
Authorization: Bearer <token>

{
  "text": "what's next",
  "context": {
    "location": "home",
    "time": "morning"
  }
}
```

**Response:**
```json
{
  "command": "next",
  "args": [],
  "confidence": 0.95,
  "alternatives": [
    {"command": "calendar", "args": ["today"], "confidence": 0.3}
  ]
}
```

**Use case:** Convert natural language to mp-cli commands

## Command Mapping

### Voice → Command Examples

| Voice Input | Parsed Command | mp-cli Command |
|------------|----------------|----------------|
| "What's next?" | `next` | `mp next` |
| "Show stakeholders" | `sh list` | `mp sh list` |
| "Brief for Alice" | `sh brief alice` | `mp sh brief alice` |
| "Today's messages" | `sh m c --days 1` | `mp sh m c --days 1` |
| "Calendar today" | `calendar today` | `mp calendar today` |
| "What did Alice say?" | `sh m c alice` | `mp sh m c alice` |
| "Who do I need to follow up with?" | `sh list --ball-in-court me` | `mp sh list --ball-in-court me` |

## Data Format Standards

### Task Object
```json
{
  "id": "task-123",
  "title": "Follow up with Alice",
  "project": "Project X",
  "due_date": "2026-02-18",
  "completion": 0.98,
  "ball_in_court": "me",
  "priority": "high"
}
```

### Stakeholder Object
```json
{
  "id": "sh-456",
  "name": "Alice Johnson",
  "phone": "+1234567890",
  "email": "alice@example.com",
  "last_contact": "2026-02-17T10:30:00Z",
  "ball_in_court": "them",
  "relationship_strength": 0.85,
  "tags": ["client", "priority"]
}
```

### Message Object
```json
{
  "id": "msg-789",
  "from": "Alice Johnson",
  "from_phone": "+1234567890",
  "text": "Hey, are we still on for tomorrow?",
  "timestamp": "2026-02-17T14:30:00Z",
  "is_from_me": false,
  "read": true
}
```

### Calendar Event Object
```json
{
  "id": "cal-012",
  "title": "Meeting with Bob",
  "start": "2026-02-17T15:00:00Z",
  "end": "2026-02-17T16:00:00Z",
  "location": "Office",
  "attendees": ["bob@example.com"],
  "notes": "Discuss Q1 goals"
}
```

## Error Codes

| Code | Description | HTTP Status |
|------|-------------|-------------|
| `INVALID_TOKEN` | Authentication failed | 401 |
| `COMMAND_NOT_FOUND` | Unknown command | 404 |
| `COMMAND_FAILED` | Command execution error | 500 |
| `INVALID_ARGS` | Invalid arguments | 400 |
| `RATE_LIMITED` | Too many requests | 429 |
| `SERVER_ERROR` | Internal server error | 500 |

## Security

### 1. Network Security
- **Bind to localhost only** - No external access
- **Optional:** Support local network (192.168.x.x) with explicit opt-in

### 2. Authentication
- **Token-based** - 256-bit random token
- **Token rotation** - Optional periodic rotation
- **Token revocation** - Endpoint to invalidate tokens

### 3. Rate Limiting
- **Per-token limits** - 100 requests/minute
- **Burst allowance** - 10 requests/second
- **Backoff** - Exponential backoff on rate limit

### 4. Input Validation
- **Command whitelist** - Only allow known commands
- **Argument sanitization** - Prevent command injection
- **Size limits** - Max request size 1MB

## Performance

### Caching Strategy

1. **Command Results** - Cache for 30 seconds
   - `next` → 30s
   - `sh list` → 60s
   - `calendar today` → 300s (5 min)

2. **Cache Invalidation**
   - Manual: `POST /cache/clear`
   - Automatic: On data modification commands

3. **Cache Headers**
   ```http
   Cache-Control: max-age=30
   ETag: "abc123"
   ```

### Response Time Targets

| Command | Target | Max |
|---------|--------|-----|
| `next` | 100ms | 500ms |
| `sh list` | 150ms | 500ms |
| `sh brief <name>` | 200ms | 1s |
| `sh m c --days 1` | 300ms | 2s |
| `calendar today` | 100ms | 500ms |

## Logging

### Log Levels
- **DEBUG** - All requests/responses
- **INFO** - Command execution, timing
- **WARN** - Slow commands, rate limits
- **ERROR** - Failed commands, exceptions

### Log Format
```json
{
  "timestamp": "2026-02-17T19:55:00Z",
  "level": "INFO",
  "command": "next",
  "execution_time_ms": 234,
  "success": true,
  "client_ip": "127.0.0.1"
}
```

### Log Storage
- **Location:** `~/.mp-cli-bridge/logs/`
- **Rotation:** Daily, keep 7 days
- **Size limit:** 100MB per file

## Monitoring

### Metrics to Track
1. **Request count** - Total requests per command
2. **Response time** - P50, P95, P99
3. **Error rate** - Errors per command
4. **Cache hit rate** - Cache effectiveness
5. **Active connections** - WebSocket connections

### Health Checks
- **Liveness:** Server is running
- **Readiness:** Can execute commands
- **Startup:** Time to first request

## Configuration

### Config File: `~/.mp-cli-bridge/config.json`

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8421,
    "allow_local_network": false
  },
  "auth": {
    "token_file": "~/.mp-cli-bridge/token",
    "require_auth": true
  },
  "cache": {
    "enabled": true,
    "ttl_seconds": 30,
    "max_size_mb": 100
  },
  "rate_limit": {
    "enabled": true,
    "requests_per_minute": 100,
    "burst": 10
  },
  "logging": {
    "level": "INFO",
    "file": "~/.mp-cli-bridge/logs/bridge.log",
    "rotation": "daily",
    "retention_days": 7
  },
  "mp_cli": {
    "path": "/usr/local/bin/mp",
    "timeout_seconds": 30
  }
}
```

## Deployment

### Installation
```bash
# Install bridge server
cd mp-cli
pip install -e ".[bridge]"

# Generate token
mp-bridge init

# Start server
mp-bridge start

# Run as daemon
mp-bridge start --daemon

# Stop server
mp-bridge stop
```

### Auto-start (macOS)
```bash
# Create LaunchAgent
mp-bridge install-service

# Start on login
launchctl load ~/Library/LaunchAgents/com.mp-cli.bridge.plist
```

## Testing Strategy

### Unit Tests
- Command parsing
- Authentication
- Rate limiting
- Cache logic

### Integration Tests
- End-to-end command execution
- WebSocket connections
- Error handling

### Load Tests
- 100 requests/second
- 1000 concurrent WebSocket connections
- Cache performance under load

## Open Questions

1. **WebSocket vs SSE?** - WebSocket for bidirectional, SSE for server push only
2. **GraphQL instead of REST?** - More flexible but more complex
3. **gRPC for performance?** - Faster but harder to debug
4. **Embed in mp-cli or separate service?** - Separate for now, merge later?

## Next Steps

1. **Review this design** - Get feedback on API structure
2. **Create OpenAPI spec** - Formal API documentation
3. **Design mobile client** - How MentraOS app will consume this API
4. **Design G1 display format** - How to render data on glasses
5. **Prototype one endpoint** - Start with `/execute` for `mp next`

## Success Criteria

- [ ] Can execute all core mp-cli commands via HTTP
- [ ] < 500ms response time for common commands
- [ ] Secure (localhost only, token auth)
- [ ] Reliable (99.9% uptime during development)
- [ ] Observable (logs, metrics, health checks)
- [ ] Easy to deploy (one command to start)

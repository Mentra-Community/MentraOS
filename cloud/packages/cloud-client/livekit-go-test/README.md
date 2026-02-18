# LiveKit Go SDK Test

This test verifies if the Go SDK can establish WebRTC connections better than the Node/Bun SDK.

## Setup

1. Install Go dependencies:

```bash
go mod tidy
```

2. Copy the example environment file and edit it:

```bash
cp .env.example .env
# Edit .env with your LiveKit credentials
```

3. Run the test:

```bash
go run simple-test.go
```

## Environment Variables

The following can be set in `.env` file or as environment variables:

- `LIVEKIT_API_KEY` - Your LiveKit API key (required)
- `LIVEKIT_API_SECRET` - Your LiveKit API secret (required)
- `LIVEKIT_URL` - LiveKit server URL (optional, defaults to test server)
- `LIVEKIT_ROOM_NAME` - Room name to join (optional, defaults to "user@example.com")

## Results

✅ **Go SDK successfully connects as publisher** where Node/Bun SDK fails

- This proves the network supports WebRTC publishing
- The issue is specific to the Node/Bun LiveKit SDK implementation

## Security Note

Never commit `.env` files with real credentials. The `.gitignore` file is configured to exclude them.

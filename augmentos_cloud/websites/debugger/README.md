# AugmentOS Debugger

A web-based debugger for monitoring and debugging AugmentOS sessions and TPAs.

## Features

- Real-time monitoring of active sessions
- Detailed session state inspection
- TPA (Third-Party Application) management
- Display state monitoring
- Audio and transcription status
- System-wide statistics

## Getting Started

### Prerequisites

- Node.js 16 or later
- npm 7 or later

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

1. Start the mock server (for development):
   ```bash
   npm run mock-server
   ```

2. In a separate terminal, start the development server:
   ```bash
   npm run dev
   ```

3. Open [http://localhost:6173](http://localhost:6173) in your browser

### Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Project Structure

```
src/
  ├── pages/
  │   ├── debugger/
  │   │   ├── components/
  │   │   │   ├── StateTreeNode.tsx
  │   │   │   ├── SystemOverview.tsx
  │   │   │   ├── SessionList.tsx
  │   │   │   └── SessionInspector.tsx
  │   │   └── Debugger.tsx
  │   └── api/
  │       └── debug/
  │           └── sessions.ts
  └── mock-server.ts
```

## API

### GET /api/debug/sessions

Returns a list of active and inactive sessions along with system statistics.

Response:
```typescript
{
  sessions: Array<{
    sessionId: string;
    userId: string;
    startTime: string;
    disconnectedAt: string | null;
    activeAppSessions: string[];
    // ... other session properties
  }>;
  stats: {
    activeSessions: number;
    totalSessions: number;
    activeTpas: number;
    totalTpas: number;
  };
}
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is proprietary and confidential. Unauthorized copying, distribution, or use is strictly prohibited. 
# MentraOS Cloud Development Guide

## Build Commands

- **Build**: `bun run build` (Builds sdk, utils, and agents packages)
- **Dev**: `bun run dev` (Starts Docker dev environment)
- **Dev Rebuild**: `bun run dev:rebuild` (Rebuilds and starts Docker containers)
- **Lint**: `cd packages/cloud && bun run lint` (ESLint for cloud package)
- **App Dev**: `cd packages/apps/<app-name> && bun run dev` (Start App in dev mode)

## Environment Setup

- **Quick Setup**: `./scripts/docker-setup.sh` (Sets up network, cleans resources, and starts services)
- **Setup Dependencies**: `bun run setup-deps` (Install dependencies with optimizations)
- **Dev Network**: `bun run dev:setup-network` (Create Docker network)
- **Dev Logs**:
  - `bun run logs` (View all Docker logs)
  - `bun run logs:cloud` (View cloud service logs)
  - `bun run logs:service <service-name>` (View specific service logs)
- **Clean Environment**: `bun run dev:clean` (Remove volumes and prune unused resources)
- **Debugging**: `docker-compose -f docker-compose.dev.yml -p dev logs -f <service-name>`

## Docker Tips

- Each service uses a shared node_modules volume to prevent duplicate installations
- The shared-packages service builds all dependencies first
- Use `--no-link` flag with bun install to prevent "Failed to link" errors
- Use Dockerfile.dev for development (more optimized for local development)
- Use `dev:rebuild` when changing dependencies or Docker configuration

## Code Style Guidelines

- **TypeScript**: Strict typing with interfaces for message types
- **Imports**: Group external/internal, sort alphabetically
- **Naming**: PascalCase for classes/interfaces/types, camelCase for variables/functions
- **Error Handling**: Use try/catch with appropriate logger.error calls
- **Formatting**: 2-space indentation, semicolons
- **Documentation**: JSDoc comments for functions/classes
- **Logging**: Use logger from @mentra/utils package
- **WebSockets**: Follow the message type patterns from the SDK

## Communication Architecture

- **Glasses → Cloud**: Smart glasses connect via websocket to send events
- **Cloud → Apps**: Cloud routes events to third-party apps via websockets
- **Apps → UI**: Apps can display content via layouts API in the SDK
- **Subscription Model**: Apps subscribe to specific event streams (audio, notifications, etc.)

## Project Structure

- **/packages/cloud**: Server implementation (Express routes, WebSocket)
- **/packages/sdk**: TypeScript interfaces and App communication framework
- **/packages/utils**: Shared utilities (logger, LLM provider)
- **/packages/agents**: Agent implementation (Mira, News, Notifications)
- **/packages/apps**: Third-party applications using the SDK

## Recent Improvements

The following improvements have been implemented to enhance system reliability:

### App Server Registration System

- Apps can register their servers with MentraOS Cloud
- Tracks sessions by App server to enable recovery after restarts
- Provides automatic reconnection when App servers restart
- Documentation in `/docs/App-SERVER-REGISTRATION.md`

### Enhanced Error Handling in SDK

- Prevents Apps from crashing when receiving invalid data
- Adds robust validation and sanitization of all messages
- Improves error recovery for WebSocket connections
- Documentation in `/docs/sdk/ERROR-HANDLING-ENHANCEMENTS.md`

### Automatic Resource Management

- Automatically tracks and cleans up resources to prevent memory leaks
- Provides a unified API for managing timers, event handlers, and connections
- Integrated with AppSession for better connection management
- Documentation in `/docs/sdk/RESOURCE-TRACKER.md`

### Connection Health Monitoring

- Implements WebSocket ping/pong heartbeat mechanism
- Tracks connection activity and detects stale connections
- Automatically closes dead connections to prevent resource wastage
- Provides system health statistics for monitoring
- Documentation in `/docs/CONNECTION-HEALTH-MONITORING.md`

## Planned Improvements

### Display System Enhancements (In Progress)

- ✅ Created configuration system for DisplayManager
- ✅ Added enhanced logging and metrics collection
- ✅ Improved request validation and error handling
- ✅ Implemented robust throttling with proper queue management
- ◻️ Complete integration and testing
- ◻️ Optimize performance based on metrics
- Documentation in `/docs/DISPLAY-MANAGER-IMPROVEMENTS.md`

## Working with Smart Glasses Hardware

- **Display Limitations**: Single color (green) text-only displays
- **Update Frequency**: Must respect 200-300ms minimum delay between updates
- **Bandwidth**: Bluetooth connection has limited bandwidth and can drop if overloaded
- **Verification**: No confirmation mechanism to verify display updates were received

This project uses Bun as the package manager and runtime.

# MentraOS Logging System

## Overview

This document outlines the improved logging infrastructure for the MentraOS Cloud system. We use Pino for logging with BetterStack as our log management service and PostHog for error tracking.

## Design Goals

1. **Traceability**: Every log message is traced back to its source module
2. **Structured**: All logs are structured (JSON) for easy filtering and searching
3. **Consistent**: Log levels are used consistently across the codebase
4. **Contextualized**: Logs contain relevant context (user IDs, module names)
5. **Performant**: Logging has minimal impact on application performance

## Implementation

### Base Logger Configuration

- Pino logger with BetterStack transport for all logs
- PostHog transport for warnings and errors only
- Log levels adapt based on environment (debug in dev, info in prod)

### Log Levels

| Level | Usage |
|-------|-------|
| `fatal` | Application crashes, unrecoverable errors |
| `error` | Exceptions, errors that affect functionality |
| `warn` | Unusual events, deprecated features, soft failures |
| `info` | Important events, service start/stop, connections |
| `debug` | Detailed information for troubleshooting (development only) |
| `trace` | Very detailed tracing information (rarely used) |

## Usage Guidelines

### Basic Usage

```typescript
import { logger } from '../services/logging';

// Simple logging
logger.info('Server started');

// With context
logger.info({ port: 8080, env: 'production' }, 'Server started');

// Error logging
try {
  // some code
} catch (error) {
  logger.error({ error }, 'Failed to process request');
}
```

### Child Loggers

Create child loggers to add context to all logs from a module:

```typescript
// Create a module-specific logger
const moduleLogger = logger.child({ service: 'websocket.service' });

// All logs now include the module name
moduleLogger.info('WebSocket server initialized');
```

### User Session Logging

For user-specific logging, create a child logger with user context:

```typescript
// In session service
const sessionLogger = logger.child({
  userId: userSession.userId,
  service: 'session.service'
});

// All logs now include user ID
sessionLogger.info('User session created');
```

### Structured Data vs Messages

- Use structured data as the first parameter
- Keep message strings short and descriptive
- Don't concatenate values into messages; use structured data

```typescript
// Good
logger.info({ userId, action: 'login' }, 'User login successful');

// Bad
logger.info(`User ${userId} logged in successfully`);
```

### Error Logging

Always include error objects when logging errors:

```typescript
try {
  // code that might throw
} catch (error) {
  logger.error({ error }, 'Failed to process request');
}
```

## BetterStack Integration

Logs are automatically sent to BetterStack when the `BETTERSTACK_SOURCE_TOKEN` environment variable is set.

## PostHog Integration

Warnings and errors are automatically sent to PostHog when the `POSTHOG_PROJECT_API_KEY` environment variable is set.

## Migration Steps

1. Replace all `console.log` calls with appropriate logger calls
2. Create module-specific child loggers at the top of each file
3. Add proper context to all logs
4. Review log levels for appropriate usage (use debug for verbose logs, not info)
5. Switch from Winston to Pino where needed
# AugmentOS Logging System

## Overview

This document outlines the logging infrastructure and best practices for the AugmentOS Cloud system. We use Pino for logging with BetterStack as our log management service.

## Design Goals

1. **Traceability**: Every log message should be easily traced back to its source (file, service, session)
2. **Structured**: All logs should be structured (JSON) for easy filtering and searching
3. **Consistent**: Log levels should be used consistently across the codebase
4. **Contextualized**: Logs should contain relevant context (user sessions, request info, etc.)
5. **Performant**: Logging should have minimal impact on application performance

## Implementation

### Base Logger Configuration

- Uses Pino with BetterStack transport
- Sets appropriate log levels based on environment
- Configured with source token from BetterStack
- Maintains PostHog error tracking for critical errors

### Logger Hierarchy

1. **Root Logger** - The base logger instance for the application
2. **Service Loggers** - Child loggers for each service with service name context
3. **File Loggers** - Child loggers for individual files with file name context
4. **Session Loggers** - Child loggers for user sessions with session/user context

### Log Levels

| Level | Usage |
|-------|-------|
| `fatal` | Application crashes, unrecoverable errors |
| `error` | Exceptions, errors that affect functionality |
| `warn` | Unusual events, deprecated features, soft failures |
| `info` | Important events, service start/stop, connections |
| `debug` | Detailed information for troubleshooting |
| `trace` | Very detailed tracing information (high volume) |

## Usage Guidelines

### Creating Loggers

**Service Logger:**
```typescript
// At the top of a service file
import { createServiceLogger } from '@augmentos/utils';
const logger = createServiceLogger('websocket.service');
```

**Session Logger:**
```typescript
// When creating a user session
const sessionLogger = createSessionLogger({
  sessionId: session.sessionId,
  userId: session.userId
});
```

### Contextual Logging

Always include relevant context with logs:

```typescript
// Good - with context
logger.info({ appId, requestId }, 'Processing display request');

// Bad - no context
logger.info('Processing display request');
```

### Structured Data vs Messages

- Use structured data as the first parameter 
- Keep message strings short and descriptive
- Don't concatenate values into messages; use structured data

```typescript
// Good
logger.info({ userId, action: 'login', source: 'api' }, 'User login successful');

// Bad
logger.info(`User ${userId} logged in successfully via the API`);
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

### Service Identification

All logs should identify their source service:

```typescript
// Automatically included with service loggers
const logger = createServiceLogger('display.manager');

// Or manually when needed
logger.info({ service: 'websocket.handler' }, 'Connection established');
```

## Migration Guidelines

1. Replace all `console.log` calls with appropriate logger calls
2. Convert all Winston logger instances to Pino
3. Add service context to all loggers
4. Ensure all user session code uses session loggers
5. Review log levels for appropriate usage

## Integration with Error Tracking

Critical errors will still be sent to PostHog for error tracking:

```typescript
try {
  // code that might throw
} catch (error) {
  // Log to BetterStack
  logger.error({ error }, 'Critical operation failed');
  
  // Also track in PostHog for analytics/alerting
  PosthogService.trackException(error, { 
    service: 'display.manager',
    operation: 'updateDisplay' 
  });
}
```
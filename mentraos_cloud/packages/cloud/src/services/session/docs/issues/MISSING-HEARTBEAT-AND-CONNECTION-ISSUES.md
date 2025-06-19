# Missing Heartbeat System and Connection Stability Issues

## Overview

Investigation revealed that the new refactored system is missing the comprehensive heartbeat/ping-pong connection management that existed in the old system, causing frequent client disconnections and cascading transcription issues.

## Root Cause Analysis

### Issue 1: App Startup Conflicts on Reconnection (FIXED)

**Problem:** During reconnections, the system couldn't distinguish between new connections and reconnections, causing it to attempt starting already-running apps (dashboard, previously running apps). This created conflicts and potentially contributed to connection instability.

**Root Cause:** The `createSession()` method and `handleConnectionInit()` didn't track whether a connection was a new session or a reconnection, leading to unnecessary app startup attempts.

**Fix Applied:**
- Modified `sessionService.createSession()` to return `{ userSession, reconnection: boolean }`
- Updated `handleConnectionInit(userSession, reconnection)` to skip app startup if `reconnection === true`
- Added CONNECTION_INIT message handling to properly detect when clients send initialization vs. regular messages

**Code Changes:**
```typescript
// session.service.ts - Line 62
async createSession(ws: WebSocket, userId: string): Promise<{ userSession: UserSession, reconnection: boolean }> {
  // Returns reconnection flag based on whether session already existed
}

// websocket-glasses.service.ts - Line 275
private async handleConnectionInit(userSession: UserSession, reconnection: boolean): Promise<void> {
  if (!reconnection) {
    // Only start apps for new connections, not reconnections
  }
}
```

**Status:** ✅ **RESOLVED** - App startup conflicts eliminated during reconnection

### Issue 2: Missing Heartbeat Management System

**Old System Had (websocket.service.ts):**
- `userSession.heartbeatManager.registerGlassesConnection(ws)` (line 952)
- `userSession.heartbeatManager.updateGlassesActivity(ws)` on every message (line 992)
- Ping/pong handlers for connection health tracking (lines 1008-1017)
- TPA heartbeat management (lines 2132-2143)
- Graceful disconnect handling with detailed diagnostics (line 1022)

**New System Has:**
- ❌ **No heartbeat manager**
- ❌ **No ping/pong handlers**
- ❌ **No connection health tracking**
- ❌ **No activity timestamp updates**

**Status:** 🔧 **ONGOING** - Still causing connection instability

### Issue 3: Frequent Client Disconnections

**Symptoms:**
- Glasses/phone client repeatedly disconnects and reconnects (still occurring after app startup fix)
- Session reuse working correctly ✅
- No longer triggers unnecessary app restarts ✅ (fixed in Issue 1)
- Connection drops within ~23ms of establishment
- WebSocket error code 1006 (abnormal closure) most common

**Likely Cause:**
WebSocket connections timing out due to lack of ping/pong keepalive mechanism.

**Status:** 🔧 **ONGOING** - Primary remaining issue after app startup conflicts resolved

### Issue 4: Stream Recreation on Reconnect

**Current Flow:**
1. Client disconnects (due to missing heartbeat)
2. Client reconnects → Session reused ✅
3. `handleConnectionInit()` called → `transcriptionService.startTranscription()`
4. New streams created without checking if old streams exist
5. Potential stream conflicts or duplicates

**Status:** 🔧 **ONGOING** - Stream management needs improvement

### Issue 5: Empty Transcription Results

**Log Evidence:**
```json
{
  "text": "",
  "originalText": "",
  "from": "fr-FR", 
  "to": "fr-FR",
  "duration": 148800000,
  "subscription": "translation:en-US-to-fr-FR"
}
```

**Root Cause Analysis:**
1. Subscription expects `en-US-to-fr-FR`
2. Azure detected source as `fr-FR` (not `en-US`)
3. Language detection logic: `from === to` → uses `event.result.text`
4. `event.result.text` was empty (likely long silence period)
5. Results in empty transcription broadcast

**Status:** 🔧 **ONGOING** - Impacting transcription quality

## Current Status Summary

**✅ RESOLVED:**
- App startup conflicts during reconnection (Issue 1)

**🔧 ONGOING ISSUES:**
- Missing heartbeat/ping-pong system (Issue 2) - **PRIMARY CAUSE**
- Frequent client disconnections within 23ms (Issue 3) - **PRIMARY SYMPTOM**
- Stream recreation conflicts on reconnect (Issue 4)
- Empty transcription results during silence periods (Issue 5)

## Impact Assessment

### High Priority Issues
1. **Connection Instability**: Frequent disconnects disrupt user experience
2. **Resource Waste**: Unnecessary stream recreation on every reconnect
3. **Data Loss**: Empty transcriptions provide no value to TPAs
4. **Debugging Difficulty**: Poor visibility into connection health

### Cascading Effects
- Unstable connections → frequent transcription restarts → potential Azure rate limiting
- Empty results → TPAs receive useless data → poor app experience
- Missing diagnostics → difficult to troubleshoot in production

## Proposed Solutions

### Solution 1: Implement Heartbeat System

**Add to websocket-glasses.service.ts:**
```typescript
// Register ping/pong handlers
ws.on('ping', () => {
  userSession.logger.debug('Received ping from glasses, sending pong');
  try {
    ws.pong();
  } catch (error) {
    userSession.logger.error('Error sending pong:', error);
  }
});

ws.on('pong', () => {
  userSession.logger.debug('Received pong from glasses');
  // Update last activity timestamp
});

// Send periodic pings
const pingInterval = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.ping();
  } else {
    clearInterval(pingInterval);
  }
}, 30000); // Every 30 seconds
```

### Solution 2: Stream State Validation on Reconnect

**Add to handleConnectionInit():**
```typescript
// Check existing stream state before starting transcription
const existingStreams = userSession.transcriptionStreams?.size || 0;
if (existingStreams > 0) {
  userSession.logger.info({ existingStreams }, 'Session has existing transcription streams, validating state');
  // Validate stream health before creating new ones
} else {
  userSession.logger.info('No existing streams, starting fresh transcription');
  transcriptionService.startTranscription(userSession);
}
```

### Solution 3: Enhanced Language Detection Logging

**Add to transcription.service.ts recognition handlers:**
```typescript
// Log language detection details
sessionLogger.debug({
  subscription,
  expectedSource: languageInfo.transcribeLanguage,
  expectedTarget: languageInfo.translateLanguage,
  detectedSource: detectedSourceLang,
  actualTranslation: translatedText,
  originalText: event.result.text,
  didTranslate,
  translationMap: event.result.translations ? Object.fromEntries(event.result.translations) : null
}, 'Language detection analysis');
```

## Logging Improvements Needed

### 1. Connection Health Logging

**Add to websocket-glasses.service.ts:**
```typescript
// Connection establishment
userSession.logger.info({
  connectionId: generateConnectionId(),
  remoteAddress: request.socket.remoteAddress,
  userAgent: request.headers['user-agent'],
  timestamp: new Date().toISOString()
}, 'Glasses WebSocket connection established');

// Connection activity tracking
ws.on('message', () => {
  userSession.lastActivity = Date.now();
  // Log periodically, not on every message
  if (Date.now() - userSession.lastLoggedActivity > 30000) {
    userSession.logger.debug({ lastActivity: userSession.lastActivity }, 'Connection activity update');
    userSession.lastLoggedActivity = Date.now();
  }
});

// Disconnect logging
ws.on('close', (code, reason) => {
  const connectionDuration = Date.now() - userSession.startTime;
  userSession.logger.info({
    closeCode: code,
    closeReason: reason.toString(),
    connectionDuration,
    lastActivity: userSession.lastActivity,
    timeSinceLastActivity: Date.now() - userSession.lastActivity
  }, 'Glasses WebSocket disconnected');
});
```

### 2. Stream Lifecycle Logging

**Add to transcription.service.ts:**
```typescript
// Stream creation
sessionLogger.info({
  subscription,
  existingStreams: userSession.transcriptionStreams?.size || 0,
  operation: 'createStream',
  streamId: generateStreamId()
}, 'Creating new transcription stream');

// Stream validation on reconnect
sessionLogger.info({
  sessionAge: Date.now() - userSession.startTime,
  existingStreams: Array.from(userSession.transcriptionStreams?.keys() || []),
  requestedStreams: desiredSubscriptions,
  operation: 'validateStreams'
}, 'Validating transcription streams on reconnect');
```

### 3. Azure Event Logging

**Add detailed Azure diagnostics:**
```typescript
// Enhanced canceled event logging
instance.recognizer.canceled = (_sender: any, event: SpeechRecognitionCanceledEventArgs) => {
  const errorDetails = {
    subscription,
    errorCode: event.errorCode,
    reason: event.reason,
    errorDetails: event.errorDetails,
    streamAge: Date.now() - (instance.startTime || 0),
    wasReady: instance.isReady,
    connectionState: ws.readyState,
    lastAudioFeed: userSession.lastAudioTimestamp,
    timeSinceLastAudio: userSession.lastAudioTimestamp ? Date.now() - userSession.lastAudioTimestamp : null
  };
  
  sessionLogger.error(errorDetails, 'Azure Speech Recognition canceled');
};
```

### 4. Empty Result Investigation

**Add to translation/transcription handlers:**
```typescript
// Log empty results with context
if (!event.result.text || translatedText === '') {
  sessionLogger.warn({
    subscription,
    resultId: event.result.resultId,
    offset: event.result.offset,
    duration: event.result.duration,
    reason: event.result.reason,
    hasTranslations: !!event.result.translations,
    translationsCount: event.result.translations?.size || 0,
    originalText: event.result.text,
    computedText: translatedText,
    timeSinceLastAudio: userSession.lastAudioTimestamp ? Date.now() - userSession.lastAudioTimestamp : null
  }, 'Empty transcription result received');
}
```

## Testing and Verification Plan

### 1. Connection Stability Testing
```bash
# Monitor connection patterns
docker logs cloud-1 2>&1 | grep -E "(WebSocket.*established|WebSocket.*disconnected)" | tail -20

# Check for ping/pong activity (after implementation)
docker logs cloud-1 2>&1 | grep -E "(ping|pong)" | tail -10

# Monitor connection duration
docker logs cloud-1 2>&1 | grep "connectionDuration" | tail -10
```

### 2. Stream Recreation Testing
```bash
# Check for stream conflicts on reconnect
docker logs cloud-1 2>&1 | grep -A 3 -B 3 "existing.*streams" | tail -20

# Monitor stream creation patterns
docker logs cloud-1 2>&1 | grep "Creating new transcription stream" | tail -10

# Verify stream cleanup
docker logs cloud-1 2>&1 | grep "Stopping transcription stream" | tail -10
```

### 3. Empty Result Investigation
```bash
# Find empty transcription results
docker logs cloud-1 2>&1 | grep -A 5 -B 5 '"text": ""' | tail -30

# Check language detection issues
docker logs cloud-1 2>&1 | grep -E "(from.*to.*subscription|Language detection)" | tail -15

# Monitor Azure error patterns
docker logs cloud-1 2>&1 | grep -E "(Recognition canceled|errorCode.*4)" | tail -20
```

### 4. Reproduction Steps

**For Connection Issues:**
1. Start glasses client
2. Monitor logs for connection establishment
3. Wait for natural disconnection (should happen frequently without heartbeat)
4. Observe reconnection and stream recreation patterns

**For Empty Results:**
1. Start translation session (en-US to fr-FR)
2. Speak in English for transcription
3. Have period of silence (5+ minutes)
4. Check if empty results are generated during silence
5. Verify language detection accuracy

## Files to Modify

1. `/src/services/websocket/websocket-glasses.service.ts` - Add heartbeat system
2. `/src/services/processing/transcription.service.ts` - Enhanced logging and stream validation
3. `/src/services/session/UserSession.ts` - Add connection tracking properties
4. `/src/services/session/session.service.ts` - Stream state validation on reconnect

## Priority Assessment

**Critical (P0):**
- Missing heartbeat system causing connection instability

**High (P1):** 
- Stream recreation conflicts on reconnect
- Empty transcription results providing no value

**Medium (P2):**
- Enhanced logging for better debugging
- Language detection accuracy issues

## Success Metrics

- **Connection Stability**: Reduce disconnection frequency by >90%
- **Stream Efficiency**: Eliminate unnecessary stream recreation on reconnect
- **Data Quality**: Reduce empty transcription results by >80%
- **Debugging**: Achieve <5 minute time-to-diagnosis for connection issues
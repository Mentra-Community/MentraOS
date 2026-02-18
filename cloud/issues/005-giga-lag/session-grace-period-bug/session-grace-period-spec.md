# Session Grace Period Investigation - RESOLVED

## Overview

Investigation into captions stopping after apparent reconnect. This turned out to be **expected behavior** due to a server switch, not a bug.

## Original Report

User reported: "Captions stopped, app was still running, but mic was off when it should have been on."

## Investigation

### Initial Hypothesis

Suspected that when glasses disconnect and reconnect, a new session was being created instead of resuming the existing one, causing apps to remain connected to the old session.

### What Actually Happened

Log analysis revealed the user **switched servers** mid-session:

```
01:21:46.135  [cloud-debug]  Glasses connection closed (code 1000)
              → Grace period starts on cloud-debug

01:21:46.232  [cloud-dev]    "No active session found for user"
              → Different server has no session for this user

01:21:46.408  [cloud-dev]    New session created
              - AppManager initialized
              - AudioManager initialized
              - MicrophoneManager initialized

01:21:46.527  [cloud-dev]    Glasses WebSocket connected
              → User now on cloud-dev

01:22:46.135  [cloud-debug]  Grace period expired, session disposed
              → Old server cleans up its session (expected!)
```

### Key Evidence

The `server` and `env` fields in the logs clearly showed two different servers:

| Server | Environment | Role |
|--------|-------------|------|
| `cloud-debug` | debug | Old session (being cleaned up) |
| `cloud-dev` | development | New session (where user reconnected) |

## Resolution

**This is NOT a bug.** This is expected behavior:

1. Each server maintains its own session state
2. Switching servers means the old server has no knowledge of the new connection
3. The old server's grace period expires normally after 60 seconds
4. The new server creates a fresh session

The `subscription_update: []` and app disposal were happening on `cloud-debug`, which was correctly cleaning up its stale session after the user moved to `cloud-dev`.

## Lessons Learned

When debugging session/connection issues:

1. **Always check `server` and `env` fields** in logs
2. Server switches can look like reconnection bugs
3. Each server instance is independent - no cross-server session state

## No Fix Required

This investigation is closed. The system worked as designed.
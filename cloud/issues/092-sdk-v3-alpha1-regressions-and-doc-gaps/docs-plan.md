# Docs Reorganization Plan

## Overview

**What this doc covers:** The plan for restructuring the v3 SDK documentation sidebar, creating missing pages, fixing wrong pages, and establishing a consistent structure.
**Why this doc exists:** The current docs have v2 content mixed into v3 sections, 3 missing manager pages, 5 actively wrong pages, inconsistent icons, and an order that doesn't tell a coherent story.
**Who should read this:** Anyone working on the docs.

## Principles

- The sidebar tells a story: what is a mini app, how do you build one, what can you do with it
- Every `MentraSession` manager gets its own sidebar entry
- Names match manager names, not hardware names
- Every entry has an icon
- Bun is required, not optional. No npm, no Node.
- Link to Hono docs for HTTP routing. Link to Bun docs for the fullstack dev server. Don't re-explain.
- Every code example uses the v3 callback pattern: `app.onSession((session) => {...})`
- No class inheritance patterns anywhere in v3 docs
- No em-dashes

## New Sidebar Structure

```
Getting Started
  Overview
  Quickstart
  App Lifecycle (moved here from v3 -- conceptual, not API)
  AI IDE Integration
  Example Apps
  Deployment >

v3 (SDK 3.x)
  MiniAppServer                 icon: server
  Webviews >                    icon: browser
    Bun Fullstack Dev Server    (NEW)
    React Webviews
    Authentication
    Bridge API
  MentraSession                 icon: link
  Device >                      icon: glasses
    Overview                    (NEW -- buttons, gestures, head position, state, battery, WiFi)
    Hardware Capabilities       (NEW -- rewrite of 4 hw/ pages, folded into device)
  Display                       icon: display
  Transcription                 icon: message-captions
  Translation                   icon: language
  Speaker                       icon: volume (merge 2 pages into 1)
  Microphone                    icon: microphone
  Camera >                      icon: camera
    Photo Capture
    Streaming
  Dashboard                     icon: gauge
  Permissions                   icon: lock
  Storage                       icon: database
  LED                           icon: lightbulb
  Location                      icon: location-dot
  Phone                         icon: mobile (NEW)
  Time                          icon: clock (NEW)
  Migrating from v2 >           icon: arrow-up-right-dots

v2 (Legacy)
  (everything currently there, plus Simple Storage moved here)
```

## What Moves

| Page | From | To |
|------|------|----|
| App Lifecycle Overview | v3 section | Getting Started section |
| Webviews group | Middle of v3 list | Right after MiniAppServer (part of server architecture) |
| Simple Storage (v2) | v3 section | v2 Legacy section |
| hw/overview | v3 standalone | Folded into Device > Hardware Capabilities |
| hw/display-glasses | v3 standalone | Folded into Device > Hardware Capabilities |
| hw/camera-glasses | v3 standalone | Folded into Camera > Photo Capture |
| hw/device-capabilities | v3 standalone | Folded into Device > Hardware Capabilities |

## Pages to Create (5)

### 1. Device Overview (session.device)

Covers: button presses (`onButtonPress`), head position (`onHeadPosition`), touch/gesture events (`onTouchEvent`, `subscribeToGestures`), 13 reactive state observables (`state.batteryLevel`, `state.connected`, `state.wifiConnected`, etc.), battery updates (`onBatteryUpdate`), WiFi control (`requestWifiSetup`), capabilities change events (`onCapabilitiesChange`).

This is the biggest new page. Device is the physical glasses in front of them.

### 2. Device Hardware Capabilities

Rewrite of the 4 broken `hw/` pages into one clean v3 page. Covers: capability checks (`session.device.capabilities`), adapting to different glasses (Mentra Live vs G1 vs future), which managers are available per device, the `onCapabilitiesChange` event.

### 3. Phone (session.phone)

Covers: `phone.notifications.on(handler)`, `phone.notifications.onDismissed(handler)`, `phone.notifications.hasPermission`, `phone.calendar.on(handler)`, `phone.calendar.hasPermission`.

Does NOT document phone battery (not implemented by any client, being removed from API surface).

### 4. Time (session.time)

Small page. Covers: `time.zone`, `time.now()`, `time.toLocal(date)`, `time.format(date, opts)`, `time.setTimezone(tz)`.

### 5. Bun Fullstack Dev Server

Explains the architecture: why Bun, how the HTML import pattern works, how `routes` + `fetch` serve both the webview and the API, how HMR works in development, why one URL serves both webhooks (for the cloud) and the webview (for the phone). Links to Bun docs and Hono docs.

## Pages to Rewrite (5)

### 1. Dashboard

Replace v2 `content.writeToMain()`, `writeToExpanded()`, `onModeChange()` with v3 `session.dashboard.showText()` and `session.dashboard.clear()`.

### 2. Camera Overview (currently README.mdx)

Replace v2 method names (`requestPhoto`, `startLivestream`, `startLocalLivestream`) with v3 overview linking to Photo Capture and Streaming sub-pages.

### 3. Photo Capture

Replace `requestPhoto()` with `takePhoto()`. Add `onPhotoTaken()`. Add `hasPermission`.

### 4. LED

Remove non-existent methods (`blink`, `solid`, `turnOn`, `turnOff`). Document only `setColor(color, durationMs?)` and `off()`. When we restore blink capability (issue 092 fix), update the docs then.

### 5. Speaker

Merge the 2 current pages (TTS + audio files) into 1 page with 3 sections: TTS (`speak`), URL playback (`play`), binary streaming (`createStream`). Add `stop(trackId?)`.

## Pages to Fix (10 targeted edits)

| Page | Fix |
|------|-----|
| `app-lifecycle-overview` | Fix links to point to v3 pages, move to Getting Started |
| `microphone/audio-chunks` | Add `stop()`, `hasPermission` |
| `camera/streaming` | Add `checkExistingStream()`, verify method names |
| `permissions` | Fix LOCATION/CAMERA examples to v3, fix CALENDAR syntax error |
| `storage` | Add `clear()`, `keys()`, `has()`, `setMultiple()`, `flush()` |
| `location` | Add `stop()` |
| `transcription` | Rename sidebar entry from "Speech to Text" (hardware name) to "Transcription" (manager name) |
| 4 hw/ pages | Content folded into Device pages, remove from v3 sidebar |
| Simple Storage | Move to v2 Legacy section |

## Pages to Remove from v3 Sidebar (4)

These files stay on disk (in case external links exist) but are removed from the v3 sidebar. Their content is folded into the new Device and Camera pages.

- `hw/overview.mdx` (into Device > Hardware Capabilities)
- `hw/display-glasses.mdx` (into Device > Hardware Capabilities)
- `hw/camera-glasses.mdx` (into Camera > Photo Capture)
- `hw/device-capabilities.mdx` (into Device > Hardware Capabilities)

## Page Structure Template

Every manager page follows the same structure:

1. **What it is** (2-3 sentences)
2. **Quick example** (5-10 lines showing the most common use case)
3. **API reference** (every public method with params, return type, one-liner example)
4. **Common patterns** (real-world usage, combining with other managers)
5. **Migrating from v2** (only if the v2 API was significantly different)

## Execution Order

1. Restructure `docs.json` sidebar (move things, add icons, reorder)
2. Create the 5 new pages
3. Rewrite the 5 broken pages
4. Apply the 10 targeted fixes
5. Verify build
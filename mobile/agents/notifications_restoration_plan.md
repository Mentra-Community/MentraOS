# Notification Implementation Plan

## 🔍 Current State Analysis

### What We Have:

1. ✅ **NotificationListenerServiceImpl** - Service exists and will start (after our manifest fix)
2. ✅ **NotificationListener singleton** - Has permission checking, app listing, listener pattern
3. ✅ **CoreModule** - Expo module with `hasNotificationListenerPermission()`
4. ✅ **Bridge architecture** - Messages flow: Native → Bridge → CoreMessageEvent → MantleBridge → WebSocket
5. ✅ **WebSocket flow** - `Bridge.sendWSText()` → type "ws_text" → `socketComms.sendText()` → Server

### What's Missing:

1. ❌ **Bridge.sendPhoneNotification()** - Method doesn't exist
2. ❌ **Wiring** - NotificationListener doesn't call Bridge
3. ❌ **Filtering** - No blacklist/deduplication logic
4. ❌ **CoreModule methods** - Can't manage notification settings from TypeScript
5. ❌ **TypeScript handler** - Old `NotificationListener.tsx` references non-existent `NotificationModule`

---

## 🎯 Implementation Plan

### **Phase 1: Native Android - Core Notification Flow**

#### 1.1 Add `Bridge.kt` Methods

**File**: `modules/core/android/src/main/java/com/mentra/core/Bridge.kt`

```kotlin
/** Send phone notification to server (matches server PhoneNotification interface) */
@JvmStatic
fun sendPhoneNotification(
    packageName: String,
    appName: String,
    title: String,
    text: String,
    timestamp: Long
) {
    try {
        val event = HashMap<String, Any>()
        event["type"] = "phone_notification"
        event["notificationId"] = "$packageName-$timestamp" // Unique ID for this notification
        event["app"] = appName
        event["title"] = title
        event["content"] = text
        event["priority"] = "normal" // Default priority, could be enhanced later
        event["timestamp"] = timestamp

        val jsonData = JSONObject(event as Map<*, *>)
        val jsonString = jsonData.toString()
        sendWSText(jsonString)

        log("NOTIF: Sent phone notification: $title - $text")
    } catch (e: Exception) {
        log("Bridge: Error sending phone notification: $e")
    }
}
```

#### 1.2 Implement `NotificationListener.kt` Logic

**File**: `modules/core/android/src/main/java/com/mentra/core/services/NotificationListener.kt`

Add filtering and deduplication (lines 77-97):

```kotlin
// Add deduplication tracking
private val notificationBuffer = mutableMapOf<String, Runnable>()
private val notificationHandler = Handler(Looper.getMainLooper())
private val DUPLICATE_THRESHOLD_MS = 200L

// System packages to block
private fun isSystemPackageToBlock(packageName: String): Boolean {
    val pkg = packageName.lowercase()
    return pkg.contains("google") || pkg.contains("samsung") || pkg.contains(".sec.")
}

/** Called internally by the service when a notification is posted */
internal fun onNotificationPosted(sbn: StatusBarNotification) {
    val packageName = sbn.packageName

    // Filter system packages
    if (isSystemPackageToBlock(packageName)) {
        Bridge.log("NOTIF: Blocking system package: $packageName")
        return
    }

    // Check blocklist
    val blocklist = CoreManager.getInstance().notificationsBlocklist
    if (blocklist.contains(packageName)) {
        Bridge.log("NOTIF: Notification in blocklist, returning")
        return
    }

    // Check if notifications enabled globally
    if (!CoreManager.getInstance().notificationsEnabled) {
        Bridge.log("NOTIF: Notifications disabled globally")
        return
    }

    // Extract notification data
    val notification = sbn.notification
    val extras = notification.extras
    val title = extras.getString("android.title") ?: ""
    val textCharSequence = extras.getCharSequence("android.text")
    val text = textCharSequence?.toString() ?: ""

    // Ignore empty notifications
    if (title.isEmpty() || text.isEmpty()) {
        Bridge.log("NOTIF: Ignoring empty notification")
        return
    }

    // Ignore WhatsApp summary notifications (e.g., "5 new messages")
    if (text.matches(Regex("^\\d+ new messages$"))) {
        Bridge.log("NOTIF: Ignoring summary notification: $text")
        return
    }

    // Get app name
    val packageManager = context.packageManager
    val appName = try {
        val appInfo = packageManager.getApplicationInfo(packageName, 0)
        packageManager.getApplicationLabel(appInfo).toString()
    } catch (e: Exception) {
        packageName
    }

    // Deduplication key
    val notificationKey = "$packageName|$title|$text"

    synchronized(notificationBuffer) {
        // Remove previous notification with same key
        notificationBuffer[notificationKey]?.let {
            notificationHandler.removeCallbacks(it)
            notificationBuffer.remove(notificationKey)
        }

        // Create delayed task
        val task = Runnable {
            // Send to server via Bridge
            Bridge.sendPhoneNotification(
                packageName = packageName,
                appName = appName,
                title = title,
                text = text,
                timestamp = sbn.postTime
            )

            // Notify listeners (for future extensibility)
            val notificationData = NotificationData(
                packageName = packageName,
                title = title,
                text = text,
                timestamp = sbn.postTime,
                id = sbn.id,
                tag = sbn.tag
            )
            listeners.forEach { listener ->
                listener.onNotificationReceived(notificationData)
            }

            synchronized(notificationBuffer) {
                notificationBuffer.remove(notificationKey)
            }
        }

        // Buffer for 200ms to deduplicate
        notificationBuffer[notificationKey] = task
        notificationHandler.postDelayed(task, DUPLICATE_THRESHOLD_MS)
    }
}
```

#### 1.3 Add `CoreModule.kt` Methods

**File**: `modules/core/android/src/main/java/com/mentra/core/CoreModule.kt`

```kotlin
// Notification Settings
Function("setNotificationsEnabled") { enabled: Boolean ->
    CoreManager.getInstance().notificationsEnabled = enabled
}

Function("getNotificationsEnabled") {
    CoreManager.getInstance().notificationsEnabled
}

Function("setNotificationsBlocklist") { blocklist: List<String> ->
    CoreManager.getInstance().notificationsBlocklist = blocklist
}

Function("getNotificationsBlocklist") {
    CoreManager.getInstance().notificationsBlocklist.toList()
}

AsyncFunction("getInstalledApps") {
    NotificationListener.getInstance(
        appContext.reactContext ?: throw IllegalStateException("No context")
    ).getInstalledApps()
}
```

---

### **Phase 2: TypeScript Integration**

#### 2.1 Update `CoreModule.ts` Types

**File**: `modules/core/src/CoreModule.ts`

```typescript
export interface CoreModuleType {
  // ... existing methods

  // Notification management
  setNotificationsEnabled(enabled: boolean): void
  getNotificationsEnabled(): boolean
  setNotificationsBlocklist(blocklist: string[]): void
  getNotificationsBlocklist(): string[]
  getInstalledApps(): Promise<
    Array<{
      packageName: string
      appName: string
      isBlocked: boolean
      icon: string | null
    }>
  >
  hasNotificationListenerPermission(): Promise<boolean>
}
```

#### 2.2 Update `NotificationServiceUtils.tsx`

**File**: `src/utils/NotificationServiceUtils.tsx`

Add new utility functions:

```typescript
import CoreModule from "modules/core/src/CoreModule"

export async function setNotificationsEnabled(enabled: boolean) {
  return CoreModule.setNotificationsEnabled(enabled)
}

export async function getNotificationsEnabled() {
  return CoreModule.getNotificationsEnabled()
}

export async function setNotificationsBlocklist(blocklist: string[]) {
  return CoreModule.setNotificationsBlocklist(blocklist)
}

export async function getNotificationsBlocklist() {
  return CoreModule.getNotificationsBlocklist()
}

export async function getInstalledApps() {
  return CoreModule.getInstalledApps()
}
```

#### 2.3 Remove/Archive Old `NotificationListener.tsx`

**File**: `src/components/NotificationListener.tsx`

This file references non-existent `NotificationModule`. Either:

- **Option A**: Delete it (notifications now go directly to server)
- **Option B**: Repurpose it to listen to phone_notification events for UI purposes

If Option B, update to:

```typescript
import React, {useEffect} from "react"
import CoreModule from "modules/core/src/CoreModule"

export function usePhoneNotificationListener(onNotification?: (notification: PhoneNotification) => void) {
  useEffect(() => {
    const subscription = CoreModule.addListener("CoreMessageEvent", (event: any) => {
      try {
        const message = JSON.parse(event.body)
        if (message.type === "phone_notification" && onNotification) {
          onNotification({
            packageName: message.packageName,
            appName: message.appName,
            title: message.title,
            text: message.text,
            timestamp: message.timestamp,
          })
        }
      } catch (e) {
        console.error("Error parsing notification:", e)
      }
    })

    return () => subscription.remove()
  }, [onNotification])
}
```

---

### **Phase 3: Settings Persistence**

#### 3.1 Update Settings Store

**File**: `src/stores/settings.ts`

Add notification settings keys:

```typescript
export const SETTINGS_KEYS = {
  // ... existing keys
  notifications_enabled: "notifications_enabled",
  notifications_blocklist: "notifications_blocklist",
}
```

#### 3.2 Sync Settings on App Start

In your app initialization code, load and sync notification settings:

```typescript
// Load from AsyncStorage and sync to native
const notificationsEnabled = await getSetting(SETTINGS_KEYS.notifications_enabled, true)
const blocklist = await getSetting(SETTINGS_KEYS.notifications_blocklist, [])

CoreModule.setNotificationsEnabled(notificationsEnabled)
CoreModule.setNotificationsBlocklist(blocklist)
```

---

### **Phase 4: Server-Side Handling**

The server infrastructure already supports phone notifications as a stream type. We just need to add the message handler.

#### 4.1 Message Type Definition (Already Exists ✅)

**File**: `cloud/packages/sdk/src/types/messages/glasses-to-cloud.ts` (Lines 188-195)

```typescript
export interface PhoneNotification extends BaseMessage {
  type: GlassesToCloudMessageType.PHONE_NOTIFICATION
  notificationId: string
  app: string
  title: string
  content: string
  priority: "low" | "normal" | "high"
}
```

**File**: `cloud/packages/sdk/src/types/streams.ts` (Line 28)

```typescript
PHONE_NOTIFICATION = "phone_notification",
```

#### 4.2 WebSocket Handler Implementation

**File**: `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts`

Add this case to the `handleGlassesMessage()` switch statement (around line 330):

```typescript
case GlassesToCloudMessageType.PHONE_NOTIFICATION:
  userSession.logger.debug(
    { service: SERVICE_NAME, message },
    "Phone notification received from mobile",
  );
  // Relay to all apps subscribed to phone_notification stream
  userSession.relayMessageToApps(message);
  break;

case GlassesToCloudMessageType.PHONE_NOTIFICATION_DISMISSED:
  userSession.logger.debug(
    { service: SERVICE_NAME, message },
    "Phone notification dismissed received from mobile",
  );
  // Relay to all apps subscribed to phone_notification_dismissed stream
  userSession.relayMessageToApps(message);
  break;
```

#### 4.3 Message Flow

**Mobile → Server → Apps:**

```
Mobile sends:
{
  "type": "phone_notification",
  "packageName": "com.whatsapp",
  "appName": "WhatsApp",
  "title": "John Doe",
  "text": "Hey, are you free?",
  "timestamp": 1234567890
}

Server relays to subscribed Apps:
{
  "type": "data_stream",
  "sessionId": "user123-com.example.app",
  "streamType": "phone_notification",
  "data": {
    "type": "phone_notification",
    "packageName": "com.whatsapp",
    "appName": "WhatsApp",
    "title": "John Doe",
    "text": "Hey, are you free?",
    "timestamp": 1734567890
  },
  "timestamp": "2025-01-04T12:00:00.000Z"
}
```

#### 4.4 Mobile Message Format Adaptation

**Issue**: Mobile sends slightly different format than server expects.

**Mobile sends:**

- `packageName` (string)
- `appName` (string)
- `title` (string)
- `text` (string)
- `timestamp` (number)

**Server expects (PhoneNotification interface):**

- `notificationId` (string)
- `app` (string)
- `title` (string)
- `content` (string)
- `priority` ("low" | "normal" | "high")

**Solution Options:**

**Option A**: Update mobile to match server interface (Recommended)

```kotlin
// In Bridge.kt sendPhoneNotification()
val event = HashMap<String, Any>()
event["type"] = "phone_notification"
event["notificationId"] = "$packageName-$timestamp" // Generate unique ID
event["app"] = appName
event["title"] = title
event["content"] = text
event["priority"] = "normal" // Default priority
event["timestamp"] = timestamp
```

**Option B**: Update server interface to match mobile format

```typescript
// Update PhoneNotification interface to accept both formats
export interface PhoneNotification extends BaseMessage {
  type: GlassesToCloudMessageType.PHONE_NOTIFICATION
  // Legacy fields
  notificationId?: string
  app?: string
  content?: string
  priority?: "low" | "normal" | "high"
  // New fields from mobile
  packageName?: string
  appName?: string
  text?: string
  // Common fields
  title: string
  timestamp: Date
}
```

**Recommendation**: Use **Option A** - update mobile to match the existing server interface. This maintains consistency with the existing API contract.

---

## 🚀 Implementation Order

1. **Day 1**: Phase 1.1-1.2 (Bridge + NotificationListener core logic)
2. **Day 2**: Phase 1.3 + Phase 2.1-2.2 (CoreModule + TypeScript utils)
3. **Day 3**: Phase 2.3 + Phase 3 (UI cleanup + Settings persistence)
4. **Day 4**: Phase 4 + Testing (Server handling + end-to-end testing)

---

## ✅ Testing Checklist

- [ ] Manifest fix allows notification service to start without crash
- [ ] Can grant notification permission from settings
- [ ] Notifications from test apps reach the server
- [ ] Blocklist filtering works
- [ ] System package filtering works
- [ ] Deduplication works (no duplicate notifications within 200ms)
- [ ] Empty notifications are filtered out
- [ ] Settings persist across app restarts
- [ ] Notifications display on glasses correctly

---

## 📝 Key Architecture Notes

**Old Implementation**: Native → React Native → EventBus → Glasses
**New Implementation**: Native → Bridge → WebSocket → Server → Apps

The new architecture is simpler and eliminates the React Native middleman for the core notification flow. Notifications go directly from the native Android service through the Bridge to the WebSocket server, which then relays them to subscribed apps.

---

## 🔧 Server Implementation Summary

### What Already Exists ✅

1. **Message type definition**: `PhoneNotification` interface in SDK (glasses-to-cloud.ts)
2. **Stream type enum**: `StreamType.PHONE_NOTIFICATION` and `PHONE_NOTIFICATION_DISMISSED`
3. **Type guards**: `isPhoneNotification()` and `isPhoneNotificationDismissed()`
4. **Relay infrastructure**: `userSession.relayMessageToApps()` already exists
5. **Stream subscription system**: Apps can already subscribe to `phone_notification` stream

### What Needs to Be Added 🔨

**Single File Change Required**: `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts`

Add two case statements to the `handleGlassesMessage()` switch block:

```typescript
case GlassesToCloudMessageType.PHONE_NOTIFICATION:
  userSession.logger.debug(
    { service: SERVICE_NAME, message },
    "Phone notification received from mobile",
  );
  userSession.relayMessageToApps(message);
  break;

case GlassesToCloudMessageType.PHONE_NOTIFICATION_DISMISSED:
  userSession.logger.debug(
    { service: SERVICE_NAME, message },
    "Phone notification dismissed received from mobile",
  );
  userSession.relayMessageToApps(message);
  break;
```

**That's it!** The rest of the infrastructure is already in place.

### Testing the Server

1. Mobile sends notification → Server logs "Phone notification received from mobile"
2. Server relays to apps → Apps subscribed to `phone_notification` stream receive data
3. Check server logs for relay confirmation: `Relaying phone_notification to X Apps for user...`

---

## 🎯 App Development Flow

Once this is implemented, third-party app developers can subscribe to phone notifications:

```typescript
// In their MentraOS app
await session.subscribe(StreamType.PHONE_NOTIFICATION)

session.on("phone_notification", notification => {
  console.log(`New notification from ${notification.app}: ${notification.title}`)
  // Display on glasses, trigger actions, etc.
})
```

This enables apps like:

- **Notification Manager**: Display and manage phone notifications on glasses
- **Message Reader**: Read WhatsApp/Telegram messages aloud
- **Smart Filter**: Only show important notifications based on AI filtering
- **Notification Logger**: Track notification patterns and analytics

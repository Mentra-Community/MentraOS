# TPA Settings Persistence Issues

## **CRITICAL BUG: Settings Not Persisting Across TPA Restarts**

### **Root Cause Analysis**

**Location**: `AppManager.ts:528-532` in `handleTpaInit()` method

```typescript
// Send connection acknowledgment
const ackMessage = {
  type: CloudToTpaMessageType.CONNECTION_ACK,
  sessionId: sessionId,
  settings: app?.settings || [],  // ❌ BUG: Sends configuration schema, not user's values!
  timestamp: new Date()
};
```

**The Problem**: `app.settings` contains the **configuration schema/options**, NOT the user's **saved setting values**.

### **Settings vs Schema - Critical Distinction**

#### **`app.settings` = Configuration Schema (NOT User Values)**
```javascript
// What app.settings actually contains:
[
  { 
    key: "targetLanguage", 
    type: "select", 
    defaultValue: "English", 
    label: "Target Language",
    options: ["English", "Spanish", "French"]  // Available options
  },
  {
    key: "voiceType",
    type: "select", 
    defaultValue: "neutral",
    label: "Voice Type",
    options: ["neutral", "male", "female"]
  }
]
```

#### **`user.appSettings[packageName]` = User's Actual Values**
```javascript
// What user's settings actually are:
[
  { key: "targetLanguage", value: "Spanish" },    // User chose Spanish
  { key: "voiceType", value: "female" }           // User chose female voice
]
```

### **The TPA Settings API Does It CORRECTLY**

**The settings routes in `/tpa-settings.routes.ts` show the RIGHT way:**

#### **GET `/tpasettings/:tpaName` (✅ Correct Implementation)**
```typescript
// 1. Get app's configuration schema
const app = await appService.getApp(tpaName);
const appSettings = app?.settings || [];

// 2. Get user's saved values  
const user = await User.findOrCreateUser(userId);
const userSettings = user.getAppSettings(tpaName) || [];

// 3. Merge user values with schema structure
const mergedSettings = appSettings.map(setting => {
  const stored = userSettings.find(s => s.key === setting.key);
  return {
    ...setting,                                    // Schema structure
    selected: stored?.value || setting.defaultValue  // User's value OR default
  };
});

return mergedSettings; // ✅ Complete settings with user's values
```

#### **POST `/tpasettings/:tpaName` (✅ Correct Implementation)**
```typescript
// Save user's values (not schema)
await user.updateAppSettings(packageName, updatedSettings);
```

### **CONNECTION_ACK Bypasses This Correct Logic**

**The bug**: CONNECTION_ACK sends raw `app.settings` (schema) instead of using the same merge logic that the settings API uses.

### **Settings Flow Analysis**

#### **✅ Settings Updates Work Correctly**
1. User changes settings via developer console or TPA UI
2. Settings sent to `/tpasettings/:tpaName` POST endpoint  
3. `User.updateAppSettings()` saves to MongoDB correctly
4. WebSocket update sent to running TPA immediately
5. **User's changes are properly stored**

#### **❌ Settings Loading Is Broken**
1. TPA disconnects/restarts (for any reason)
2. TPA reconnects and `AppManager.handleTpaInit()` is called
3. **CONNECTION_ACK sends `app.settings` (defaults) instead of user's settings**
4. TPA receives default settings, losing user's customizations
5. **User's personalized settings are ignored**

### **Why Current Logs Don't Help Debug This**

**Current Log**: 
```
"TPA dev.augmentos.livetranslation successfully connected and authenticated in 1250ms"
```

**Missing Context**:
- How many settings were sent?
- Were they default settings or user's settings?
- What specific setting values were included?
- Did settings come from app schema or user preferences?

### **The Fix: Use Same Logic as Settings API**

#### **CONNECTION_ACK Should Mirror Settings API Logic**

**Current BROKEN Code**:
```typescript
// ❌ Sends configuration schema instead of user's values
const app = this.userSession.installedApps.get(packageName);
const ackMessage = {
  settings: app?.settings || []  // Schema/options, not user's choices
};
```

**Fixed Code (Copy Settings API Logic)**:
```typescript
// 1. Get app's configuration schema (like settings API does)
const app = this.userSession.installedApps.get(packageName);
const appSettings = app?.settings || [];

// 2. Get user's saved values (like settings API does)  
const user = await User.findOrCreateUser(this.userSession.userId);
const userSettings = user.getAppSettings(packageName) || [];

// 3. Merge user values with schema structure (like settings API does)
const mergedSettings = appSettings.map(setting => {
  const stored = userSettings.find(s => s.key === setting.key);
  return {
    ...setting,                                    // Schema structure  
    selected: stored?.value || setting.defaultValue  // User's value OR default
  };
});

const ackMessage = {
  settings: mergedSettings  // ✅ Complete settings with user's values
};
```

#### **Why This Fixes the Issue**
- **Same exact logic** as the working settings API
- **User's values** are properly loaded from `user.appSettings[packageName]`
- **Schema structure** is preserved for TPA compatibility
- **Defaults** are used when user hasn't set a value

#### **2. Enhance Settings Loading in Session Creation**

**Location**: `session.service.ts` - session creation flow

**Problem**: Apps are loaded without user settings attached

**Solution**: When loading installed apps, also load user's settings for each app:

```typescript
// In sessionService.createSession() or AppManager.refreshInstalledApps()
const apps = await appService.getInstalledApps(userId);
const user = await User.findOrCreateUser(userId);

for (const app of apps) {
  // Attach user's settings to each app
  app.userSettings = user.getAppSettings(app.packageName);
  // Keep original schema in app.settings for defaults
}
```

#### **3. Settings Merging Logic**

```typescript
function mergeUserSettingsWithSchema(userSettings: any[], appSchema: any[]): any[] {
  const merged = [...appSchema]; // Start with app's setting definitions
  
  // Apply user's values where they exist
  userSettings?.forEach(userSetting => {
    const schemaIndex = merged.findIndex(s => s.key === userSetting.key);
    if (schemaIndex >= 0) {
      merged[schemaIndex] = { ...merged[schemaIndex], ...userSetting };
    }
  });
  
  return merged;
}
```

### **Enhanced Logging for Settings Debugging**

#### **Current Insufficient Logs**
```typescript
this.logger.info({ 
  userId: this.userSession.userId, 
  packageName, 
  duration 
}, `TPA ${packageName} successfully connected and authenticated in ${duration}ms`);
```

#### **Enhanced Settings-Aware Logs**
```typescript
// Log settings details in CONNECTION_ACK
this.logger.info({ 
  userId: this.userSession.userId, 
  packageName, 
  sessionId: this.userSession.sessionId,
  service: 'AppManager',
  duration,
  settingsCount: ackMessage.settings.length,
  settingsSource: userSettings ? 'user-personalized' : 'app-defaults',
  hasUserSettings: !!userSettings?.length,
  settingKeys: ackMessage.settings.map(s => s.key)
}, `TPA ${packageName} connected - sent ${ackMessage.settings.length} settings (${userSettings ? 'personalized' : 'defaults'})`);

// Log specific setting values for debugging
this.logger.debug({
  userId: this.userSession.userId,
  packageName,
  service: 'AppManager',
  settings: ackMessage.settings
}, `Detailed settings sent to TPA ${packageName}`);
```

#### **Settings Update Logging Enhancement**
```typescript
// In tpa-settings.routes.ts when settings are updated
this.logger.info({
  userId,
  packageName: tpaName,
  service: 'tpa-settings-api',
  settingsUpdated: Object.keys(updates),
  updateCount: Object.keys(updates).length
}, `Updated ${Object.keys(updates).length} settings for ${tpaName}: ${Object.keys(updates).join(', ')}`);
```

### **Better Log Messages for Settings Issues**

#### **Connection Issues**
**Before**: `"TPA dev.augmentos.livetranslation successfully connected"`
**After**: `"TPA dev.augmentos.livetranslation connected - sent 5 settings (personalized: language=Spanish, voice=female)"`

#### **Settings Updates**  
**Before**: `"Settings updated for dev.augmentos.livetranslation"`
**After**: `"Updated 3 settings for dev.augmentos.livetranslation: language, voice, autoDetect"`

#### **Settings Debugging**
**New**: `"Settings merge for dev.augmentos.livetranslation: 3 user values + 2 app defaults = 5 total settings"`

### **Testing the Fix**

#### **Steps to Reproduce Current Bug**:
1. Open TPA (e.g., live translation)
2. Change settings (e.g., target language to Spanish)
3. Verify settings work (translation shows Spanish)
4. Stop the TPA  
5. Restart the TPA
6. **BUG**: Settings reset to defaults (English)

#### **Expected Behavior After Fix**:
1. Same steps 1-4
2. Restart the TPA
3. **FIXED**: Settings persist (still Spanish)
4. Logs show: `"sent 5 settings (personalized)"`

### **Database Schema Validation**

#### **User Settings Storage** (Working):
```javascript
// In MongoDB user document
{
  email: "user@example.com",
  appSettings: {
    "dev.augmentos.livetranslation": [
      { key: "targetLanguage", value: "Spanish" },
      { key: "voiceType", value: "female" }
    ]
  }
}
```

#### **App Settings Schema** (Used as defaults):
```javascript
// In apps collection  
{
  packageName: "dev.augmentos.livetranslation",
  settings: [
    { key: "targetLanguage", type: "select", default: "English", options: [...] },
    { key: "voiceType", type: "select", default: "neutral", options: [...] }
  ]
}
```

### **Why Settings "Don't Work" From User Perspective**

#### **The Disconnect Between API and WebSocket**:

1. ✅ **Settings API Works Perfect**:
   - GET `/tpasettings/:tpaName` correctly merges user values with schema
   - POST `/tpasettings/:tpaName` correctly saves user values
   - WebSocket updates to running TPAs work correctly

2. ❌ **CONNECTION_ACK Bypasses This Logic**:
   - Uses raw `app.settings` (schema) instead of settings API logic
   - Ignores user's saved values completely
   - Sends defaults every time TPA connects

#### **User Experience**:

1. ✅ User changes settings via UI → **Saved correctly**
2. ✅ Settings appear to work → **While TPA stays connected**  
3. ❌ TPA restarts/reconnects → **Gets defaults instead of user values**
4. ❌ **User's customizations lost** → Appears settings "don't save"

### **Impact Assessment**

#### **Current User Experience**:
- ❌ Settings reset on every TPA restart/reconnection
- ❌ Users have to reconfigure settings frequently  
- ❌ Settings appear to "not save" from user perspective
- ❌ Inconsistent behavior between settings UI and TPA connections
- ❌ Poor user experience with customizations lost

#### **After Fix**:
- ✅ Settings persist across TPA restarts
- ✅ User customizations maintained consistently
- ✅ CONNECTION_ACK uses same logic as settings API
- ✅ Clear debugging with enhanced logs showing actual values sent

### **Root Cause Summary**

**The settings ARE persisting in the database correctly**. The bug is that **CONNECTION_ACK bypasses the settings system entirely** and sends raw configuration schema instead of using the proven merge logic from the settings API.

This is a **critical user experience bug** that makes TPA settings appear unreliable and forces users to constantly reconfigure their preferences, even though their settings are actually saved correctly in the database.
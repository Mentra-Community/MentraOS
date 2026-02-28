# Camera Settings UI Implementation Plan

## Overview

This document outlines the implementation plan for adding Camera Settings to the MentraOS mobile app's glasses menu. The settings will allow users to configure button-initiated photo and video recording resolutions for supported glasses (Mentra Live).

## Architecture

### Feature Gating

- Only show Camera Settings for glasses with `cameraButton` feature flag
- Currently limited to Mentra Live glasses
- Check via `glassesFeatures.includes('cameraButton')`

### Settings Structure

```typescript
interface CameraSettings {
  buttonPhotoSize: "small" | "medium" | "large"
  buttonVideoResolution: "720p" | "1080p"
}
```

## Implementation Steps

### Phase 1: Data Layer

#### 1.1 Add Camera Settings to Store

**File:** `mobile/src/store/glassesSlice.ts`

```typescript
// Add to initial state
cameraSettings: {
  buttonPhotoSize: 'medium',
  buttonVideoResolution: '720p'
}

// Add actions
setCameraSettings: (state, action) => {
  state.cameraSettings = action.payload;
},
updateButtonPhotoSize: (state, action) => {
  state.cameraSettings.buttonPhotoSize = action.payload;
},
updateButtonVideoResolution: (state, action) => {
  state.cameraSettings.buttonVideoResolution = action.payload;
}
```

#### 1.2 Add Camera Settings Types

**File:** `mobile/src/types/glasses.ts`

```typescript
export type PhotoSize = "small" | "medium" | "large"
export type VideoResolution = "720p" | "1080p"

export interface CameraSettings {
  buttonPhotoSize: PhotoSize
  buttonVideoResolution: VideoResolution
}

// Photo size mappings for display
export const PHOTO_SIZE_LABELS = {
  small: "Small (960×720)",
  medium: "Medium (1440×1088)",
  large: "Large (3264×2448)",
}

// Video resolution mappings for display
export const VIDEO_RESOLUTION_LABELS = {
  "720p": "720p (1280×720)",
  "1080p": "1080p (1920×1080)",
}
```

### Phase 2: Native Module Integration

#### 2.1 Android Native Module

**File:** `mobile/android/app/src/main/java/com/mobile/SmartGlassesManager.java`

```java
@ReactMethod
public void setButtonPhotoSize(String size, Promise promise) {
    try {
        if (mentraLiveSGC != null) {
            mentraLiveSGC.sendButtonPhotoSettings(size);

            // Persist to SharedPreferences
            SharedPreferences prefs = context.getSharedPreferences("camera_settings", Context.MODE_PRIVATE);
            prefs.edit().putString("button_photo_size", size).apply();

            promise.resolve(true);
        } else {
            promise.reject("NO_CONNECTION", "Glasses not connected");
        }
    } catch (Exception e) {
        promise.reject("ERROR", e.getMessage());
    }
}

@ReactMethod
public void setButtonVideoResolution(String resolution, Promise promise) {
    try {
        if (mentraLiveSGC != null) {
            int width, height;
            if ("1080p".equals(resolution)) {
                width = 1920;
                height = 1080;
            } else {
                width = 1280;
                height = 720;
            }
            mentraLiveSGC.sendButtonVideoRecordingSettings(width, height, 30);

            // Persist to SharedPreferences
            SharedPreferences prefs = context.getSharedPreferences("camera_settings", Context.MODE_PRIVATE);
            prefs.edit().putString("button_video_resolution", resolution).apply();

            promise.resolve(true);
        } else {
            promise.reject("NO_CONNECTION", "Glasses not connected");
        }
    } catch (Exception e) {
        promise.reject("ERROR", e.getMessage());
    }
}

@ReactMethod
public void getCameraSettings(Promise promise) {
    try {
        SharedPreferences prefs = context.getSharedPreferences("camera_settings", Context.MODE_PRIVATE);
        WritableMap settings = Arguments.createMap();
        settings.putString("buttonPhotoSize", prefs.getString("button_photo_size", "medium"));
        settings.putString("buttonVideoResolution", prefs.getString("button_video_resolution", "720p"));
        promise.resolve(settings);
    } catch (Exception e) {
        promise.reject("ERROR", e.getMessage());
    }
}
```

#### 2.2 iOS Native Module

**File:** `mobile/ios/SmartGlassesManager.m`

```objc
RCT_EXPORT_METHOD(setButtonPhotoSize:(NSString *)size
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (self.mentraLiveManager) {
        [self.mentraLiveManager sendButtonPhotoSettings:size];

        // Persist to UserDefaults
        [[NSUserDefaults standardUserDefaults] setObject:size forKey:@"button_photo_size"];
        [[NSUserDefaults standardUserDefaults] synchronize];

        resolve(@(YES));
    } else {
        reject(@"NO_CONNECTION", @"Glasses not connected", nil);
    }
}

RCT_EXPORT_METHOD(setButtonVideoResolution:(NSString *)resolution
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (self.mentraLiveManager) {
        NSInteger width, height;
        if ([resolution isEqualToString:@"1080p"]) {
            width = 1920;
            height = 1080;
        } else {
            width = 1280;
            height = 720;
        }
        [self.mentraLiveManager sendButtonVideoRecordingSettings:width height:height fps:30];

        // Persist to UserDefaults
        [[NSUserDefaults standardUserDefaults] setObject:resolution forKey:@"button_video_resolution"];
        [[NSUserDefaults standardUserDefaults] synchronize];

        resolve(@(YES));
    } else {
        reject(@"NO_CONNECTION", @"Glasses not connected", nil);
    }
}

RCT_EXPORT_METHOD(getCameraSettings:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSDictionary *settings = @{
        @"buttonPhotoSize": [defaults objectForKey:@"button_photo_size"] ?: @"medium",
        @"buttonVideoResolution": [defaults objectForKey:@"button_video_resolution"] ?: @"720p"
    };
    resolve(settings);
}
```

### Phase 3: UI Components

#### 3.1 Camera Settings Screen

**File:** `mobile/src/screens/CameraSettingsScreen.tsx`

```tsx
import React, {useEffect, useState} from "react"
import {View, Text, StyleSheet, ScrollView, Alert, ActivityIndicator} from "react-native"
import {useSelector, useDispatch} from "react-redux"
import {Picker} from "@react-native-picker/picker"
import {PHOTO_SIZE_LABELS, VIDEO_RESOLUTION_LABELS, PhotoSize, VideoResolution} from "../types/glasses"
import SmartGlassesManager from "../native/SmartGlassesManager"
import {setCameraSettings} from "../store/glassesSlice"

export const CameraSettingsScreen = () => {
  const dispatch = useDispatch()
  const {cameraSettings, isConnected} = useSelector((state) => state.glasses)
  const [loading, setLoading] = useState(false)
  const [localSettings, setLocalSettings] = useState(cameraSettings)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      setLoading(true)
      const settings = await SmartGlassesManager.getCameraSettings()
      setLocalSettings(settings)
      dispatch(setCameraSettings(settings))
    } catch (error) {
      console.error("Failed to load camera settings:", error)
    } finally {
      setLoading(false)
    }
  }

  const handlePhotoSizeChange = async (size: PhotoSize) => {
    if (!isConnected) {
      Alert.alert("Not Connected", "Please connect your glasses first")
      return
    }

    try {
      setLoading(true)
      await SmartGlassesManager.setButtonPhotoSize(size)
      setLocalSettings((prev) => ({...prev, buttonPhotoSize: size}))
      dispatch(setCameraSettings({...localSettings, buttonPhotoSize: size}))
      Alert.alert("Success", "Photo size updated")
    } catch (error) {
      Alert.alert("Error", "Failed to update photo size")
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  const handleVideoResolutionChange = async (resolution: VideoResolution) => {
    if (!isConnected) {
      Alert.alert("Not Connected", "Please connect your glasses first")
      return
    }

    try {
      setLoading(true)
      await SmartGlassesManager.setButtonVideoResolution(resolution)
      setLocalSettings((prev) => ({...prev, buttonVideoResolution: resolution}))
      dispatch(setCameraSettings({...localSettings, buttonVideoResolution: resolution}))
      Alert.alert("Success", "Video resolution updated")
    } catch (error) {
      Alert.alert("Error", "Failed to update video resolution")
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Button Photo Settings</Text>
        <Text style={styles.description}>Choose the resolution for photos taken with the action button.</Text>
        <View style={styles.pickerContainer}>
          <Picker
            selectedValue={localSettings.buttonPhotoSize}
            onValueChange={handlePhotoSizeChange}
            enabled={!loading && isConnected}>
            {Object.entries(PHOTO_SIZE_LABELS).map(([value, label]) => (
              <Picker.Item key={value} label={label} value={value} />
            ))}
          </Picker>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Button Video Settings</Text>
        <Text style={styles.description}>Choose the resolution for videos recorded with the action button.</Text>
        <View style={styles.pickerContainer}>
          <Picker
            selectedValue={localSettings.buttonVideoResolution}
            onValueChange={handleVideoResolutionChange}
            enabled={!loading && isConnected}>
            {Object.entries(VIDEO_RESOLUTION_LABELS).map(([value, label]) => (
              <Picker.Item key={value} label={label} value={value} />
            ))}
          </Picker>
        </View>
      </View>

      {!isConnected && (
        <View style={styles.warningContainer}>
          <Text style={styles.warningText}>Connect your glasses to change settings</Text>
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  section: {
    backgroundColor: "white",
    marginVertical: 8,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: "#666",
    marginBottom: 12,
  },
  pickerContainer: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    overflow: "hidden",
  },
  warningContainer: {
    backgroundColor: "#fff3cd",
    padding: 16,
    margin: 16,
    borderRadius: 8,
  },
  warningText: {
    color: "#856404",
    textAlign: "center",
  },
})
```

#### 3.2 Update Glasses Menu

**File:** `mobile/src/screens/GlassesMenuScreen.tsx`

Add Camera Settings menu item for supported glasses:

```tsx
// In the menu items array
if (glassesFeatures.includes("cameraButton")) {
  menuItems.push({
    title: "Camera Settings",
    icon: "camera",
    onPress: () => navigation.navigate("CameraSettings"),
    description: "Configure button photo and video settings",
  })
}
```

#### 3.3 Navigation Update

**File:** `mobile/src/navigation/AppNavigator.tsx`

```tsx
import {CameraSettingsScreen} from "../screens/CameraSettingsScreen"

// Add to Stack.Navigator
;<Stack.Screen
  name="CameraSettings"
  component={CameraSettingsScreen}
  options={{
    title: "Camera Settings",
    headerBackTitle: "Back",
  }}
/>
```

### Phase 4: Settings Synchronization

#### 4.1 Auto-sync on Connection

**File:** `mobile/src/services/GlassesConnectionService.ts`

```typescript
// In onGlassesConnected method
if (glassesFeatures.includes("cameraButton")) {
  // Load saved settings
  const settings = await SmartGlassesManager.getCameraSettings()

  // Send to glasses
  await SmartGlassesManager.setButtonPhotoSize(settings.buttonPhotoSize)
  await SmartGlassesManager.setButtonVideoResolution(settings.buttonVideoResolution)

  // Update store
  dispatch(setCameraSettings(settings))
}
```

#### 4.2 Settings Persistence

Settings are automatically persisted to:

- Android: SharedPreferences (`camera_settings`)
- iOS: UserDefaults (`button_photo_size`, `button_video_resolution`)

### Phase 5: Testing

#### 5.1 Unit Tests

```typescript
// mobile/src/screens/__tests__/CameraSettingsScreen.test.tsx
describe("CameraSettingsScreen", () => {
  it("loads saved settings on mount")
  it("updates photo size when picker changes")
  it("updates video resolution when picker changes")
  it("shows warning when glasses not connected")
  it("disables pickers when loading")
})
```

#### 5.2 Integration Tests

1. Test settings persistence across app restarts
2. Test settings sync when glasses connect
3. Test settings update while glasses connected
4. Test error handling for failed updates

#### 5.3 E2E Tests

```typescript
// e2e/cameraSettings.test.ts
describe("Camera Settings Flow", () => {
  it("navigates to camera settings from glasses menu")
  it("changes photo size and verifies on glasses")
  it("changes video resolution and verifies on glasses")
  it("persists settings after app restart")
})
```

## Implementation Timeline

### Week 1

- [ ] Implement data layer (store, types)
- [ ] Add native module methods (Android & iOS)
- [ ] Create CameraSettingsScreen component

### Week 2

- [ ] Update glasses menu navigation
- [ ] Implement settings synchronization
- [ ] Add loading states and error handling

### Week 3

- [ ] Write unit tests
- [ ] Perform integration testing
- [ ] Fix bugs and polish UI

### Week 4

- [ ] E2E testing
- [ ] Documentation
- [ ] Code review and merge

## Success Metrics

1. **Functionality**
   - Settings successfully sync to glasses
   - Settings persist across app restarts
   - Changes take effect immediately on glasses

2. **User Experience**
   - Settings load within 1 second
   - Clear feedback on setting changes
   - Intuitive UI matching existing patterns

3. **Reliability**
   - No crashes when changing settings
   - Graceful handling of connection loss
   - Settings don't get lost on errors

## Potential Challenges

1. **Connection Handling**
   - Solution: Queue settings updates if glasses disconnect

2. **Settings Validation**
   - Solution: Validate on both app and glasses side

3. **Feature Detection**
   - Solution: Use feature flags to show/hide settings

## Future Enhancements

1. **Advanced Settings**
   - Frame rate selection (24/30/60 fps)
   - Video bitrate configuration
   - HDR mode toggle

2. **Presets**
   - Quick settings profiles (Battery Saver, High Quality, etc.)
   - Custom user presets

3. **Analytics**
   - Track most used settings
   - Optimize defaults based on usage

## Conclusion

This implementation plan provides a comprehensive approach to adding Camera Settings to the MentraOS mobile app. By following the existing patterns (especially the button mode implementation), we ensure consistency and maintainability. The phased approach allows for iterative development and testing, reducing risk and ensuring quality.

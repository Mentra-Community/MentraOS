---
sidebar_position: 6
title: Capabilities Types
---

# Capabilities Types

This page documents all the interfaces and types used for querying device capabilities in the MentraOS SDK.

Device capabilities allow Apps to discover what hardware and software features are available on the connected smart glasses, enabling adaptive experiences across different device models.

## Capabilities

The main interface representing all device capabilities.

```typescript
interface Capabilities {
  /** The model name of the device (e.g., "Even Realities G1", "Vuzix Z100") */
  modelName: string

  // Camera capabilities
  /** Whether the device has a camera */
  hasCamera: boolean
  /** Camera-specific capabilities, null if hasCamera is false */
  camera: CameraCapabilities | null

  // Display capabilities
  /** Whether the device has a display */
  hasDisplay: boolean
  /** Display-specific capabilities, null if hasDisplay is false */
  display: DisplayCapabilities | null

  // Microphone capabilities
  /** Whether the device has a microphone */
  hasMicrophone: boolean
  /** Microphone-specific capabilities, null if hasMicrophone is false */
  microphone: MicrophoneCapabilities | null

  // Speaker capabilities
  /** Whether the device has a speaker */
  hasSpeaker: boolean
  /** Speaker-specific capabilities, null if hasSpeaker is false */
  speaker: SpeakerCapabilities | null

  // IMU capabilities
  /** Whether the device has an Inertial Measurement Unit */
  hasIMU: boolean
  /** IMU-specific capabilities, null if hasIMU is false */
  imu: IMUCapabilities | null

  // Button capabilities
  /** Whether the device has hardware buttons */
  hasButton: boolean
  /** Button-specific capabilities, null if hasButton is false */
  button: ButtonCapabilities | null

  // Light capabilities
  /** Whether the device has controllable lights */
  hasLight: boolean
  /** Light-specific capabilities, null if hasLight is false */
  light: LightCapabilities | null

  // Power capabilities
  /** Power-related capabilities (always present) */
  power: PowerCapabilities

  // WiFi capabilities
  /** Whether the device supports WiFi connectivity */
  hasWifi: boolean
}
```

**Example Usage:**

```typescript
// Access capabilities from a App session
const caps = session.capabilities
if (caps) {
  console.log(`Connected to: ${caps.modelName}`)

  if (caps.hasCamera && caps.camera?.video.canStream) {
    console.log("Device supports video streaming")
  }
}
```

## CameraCapabilities

Interface defining camera hardware and software capabilities.

```typescript
interface CameraCapabilities {
  /** Camera resolution for still images */
  resolution?: {width: number; height: number}

  /** Whether the camera supports High Dynamic Range (HDR) */
  hasHDR?: boolean

  /** Whether the camera supports autofocus */
  hasFocus?: boolean

  /** Video recording and streaming capabilities */
  video: {
    /** Whether the camera can record video to storage */
    canRecord: boolean

    /** Whether the camera can stream video in real-time */
    canStream: boolean

    /** Supported streaming protocols (e.g., "rtmp", "webrtc") */
    supportedStreamTypes?: string[]

    /** Available video recording/streaming resolutions */
    supportedResolutions?: {width: number; height: number}[]
  }
}
```

**Example Usage:**

```typescript
if (session.capabilities.hasCamera && session.capabilities.camera) {
  const camera = session.capabilities.camera

  // Check photo capabilities
  if (camera.resolution) {
    const megapixels = (camera.resolution.width * camera.resolution.height) / 1000000
    console.log(`Camera: ${megapixels.toFixed(1)}MP`)
  }

  // Check video capabilities
  if (camera.video.canStream && camera.video.supportedStreamTypes?.includes("rtmp")) {
    console.log("RTMP streaming supported")
  }

  // Check available resolutions
  camera.video.supportedResolutions?.forEach(res => {
    console.log(`Video resolution: ${res.width}x${res.height}`)
  })
}
```

## DisplayCapabilities

Interface defining display capabilities.

```typescript
interface DisplayCapabilities {
  /** Number of displays (typically 1 or 2) */
  count?: number

  /** Whether the display supports color (true) or is monochrome (false) */
  isColor?: boolean

  /** Color type description (e.g., "green", "full_color", "palette") */
  color?: string

  /** Whether the display can show bitmap images */
  canDisplayBitmap?: boolean

  /** Display resolution in pixels */
  resolution?: {width: number; height: number}

  /** Field of view in degrees */
  fieldOfView?: {horizontal?: number; vertical?: number}

  /** Maximum number of text lines that can be displayed simultaneously */
  maxTextLines?: number

  /** Whether display brightness can be adjusted */
  adjustBrightness?: boolean
}
```

**Example Usage:**

```typescript
if (session.capabilities.hasDisplay && session.capabilities.display) {
  const display = session.capabilities.display

  // Adapt content based on color support
  if (display.isColor) {
    console.log("Full color display available")
  } else {
    console.log(`Monochrome display: ${display.color || "unknown color"}`)
  }

  // Adapt text length based on display size
  const maxLines = display.maxTextLines || 3
  if (maxLines < 5) {
    console.log("Small display - use concise text")
  }

  // Check if images are supported
  if (display.canDisplayBitmap) {
    console.log("Bitmap images supported")
  }

  // Display technical specs
  if (display.resolution) {
    console.log(`Resolution: ${display.resolution.width}x${display.resolution.height}`)
  }

  if (display.fieldOfView?.horizontal) {
    console.log(`Field of view: ${display.fieldOfView.horizontal}° horizontal`)
  }
  if (display.fieldOfView?.vertical) {
    console.log(`Field of view: ${display.fieldOfView.vertical}° vertical`)
  }
}
```

## MicrophoneCapabilities

Interface defining microphone capabilities.

```typescript
interface MicrophoneCapabilities {
  /** Number of microphones available */
  count?: number

  /** Whether Voice Activity Detection (VAD) is supported */
  hasVAD?: boolean
}
```

**Example Usage:**

```typescript
if (session.capabilities.hasMicrophone && session.capabilities.microphone) {
  const mic = session.capabilities.microphone

  console.log(`Microphones: ${mic.count || 1}`)

  if (mic.hasVAD) {
    console.log("Voice Activity Detection available")
    // Can subscribe to VAD events for optimized transcription
    session.events.onVoiceActivity(data => {
      console.log(`Speaking: ${data.status}`)
    })
  }
}
```

## SpeakerCapabilities

Interface defining speaker capabilities.

```typescript
interface SpeakerCapabilities {
  /** Number of speakers available */
  count?: number

  /** Whether the audio output is private (e.g., bone conduction) */
  isPrivate?: boolean
}
```

**Example Usage:**

```typescript
if (session.capabilities.hasSpeaker && session.capabilities.speaker) {
  const speaker = session.capabilities.speaker

  console.log(`Speakers: ${speaker.count || 1}`)

  if (speaker.isPrivate) {
    console.log("Private audio output (bone conduction)")
  } else {
    console.log("Standard speaker output")
  }
}
```

## IMUCapabilities

Interface defining Inertial Measurement Unit capabilities.

```typescript
interface IMUCapabilities {
  /** Number of sensor axes (likely 3 or 6) */
  axisCount?: number

  /** Whether accelerometer is available */
  hasAccelerometer?: boolean

  /** Whether compass/magnetometer is available */
  hasCompass?: boolean

  /** Whether gyroscope is available */
  hasGyroscope?: boolean
}
```

**Example Usage:**

```typescript
if (session.capabilities.hasIMU && session.capabilities.imu) {
  const imu = session.capabilities.imu

  console.log(`IMU: ${imu.axisCount || "unknown"} axes`)

  const sensors = []
  if (imu.hasAccelerometer) sensors.push("accelerometer")
  if (imu.hasGyroscope) sensors.push("gyroscope")
  if (imu.hasCompass) sensors.push("compass")

  console.log(`Available sensors: ${sensors.join(", ")}`)

  // Subscribe to motion events if IMU is available
  if (imu.hasAccelerometer || imu.hasGyroscope) {
    session.events.onHeadPosition(data => {
      console.log(`Head position: ${data.position}`)
    })
  }
}
```

## ButtonCapabilities

Interface defining hardware button capabilities.

```typescript
interface ButtonCapabilities {
  /** Number of physical buttons */
  count?: number

  /** Detailed button specifications */
  buttons?: Array<{
    /** Type of button interaction */
    type: "press" | "swipe1d" | "swipe2d"

    /** Supported event types for this button */
    events: string[] // e.g., "press", "double_press", "long_press", "swipe_up", "swipe_down"

    /** Whether the button is capacitive (touch-sensitive) */
    isCapacitive?: boolean
  }>
}
```

**Example Usage:**

```typescript
if (session.capabilities.hasButton && session.capabilities.button) {
  const buttons = session.capabilities.button

  console.log(`Physical buttons: ${buttons.count || 0}`)

  buttons.buttons?.forEach((button, index) => {
    console.log(`Button ${index}:`)
    console.log(`  Type: ${button.type}`)
    console.log(`  Events: ${button.events.join(", ")}`)
    console.log(`  Capacitive: ${button.isCapacitive || false}`)
  })

  // Subscribe to button events
  session.events.onButtonPress(data => {
    console.log(`Button pressed: ${data.buttonId} (${data.pressType})`)
    // data.buttonId and data.pressType are not yet fully implimented
  })
}
```

## LightCapabilities

Interface defining controllable light capabilities, which should be used while recording for privacy reasons.

```typescript
interface LightCapabilities {
  /** Number of controllable lights */
  count?: number

  /** Detailed light specifications */
  lights?: Array<{
    /** Whether the light supports full RGB color */
    isFullColor: boolean

    /** Color type description (e.g., "white", "rgb") */
    color?: string
  }>
}
```

**Example Usage:**

```typescript
if (session.capabilities.hasLight && session.capabilities.light) {
  const lights = session.capabilities.light

  console.log(`Controllable lights: ${lights.count || 0}`)

  lights.lights?.forEach((light, index) => {
    console.log(`Light ${index}:`)
    if (light.isFullColor) {
      console.log(`  Full RGB color support`)
    } else {
      console.log(`  Fixed color: ${light.color || "unknown"}`)
    }
  })
}
```

## PowerCapabilities

Interface defining power-related capabilities.

```typescript
interface PowerCapabilities {
  /** Whether the device has an external battery pack */
  hasExternalBattery: boolean // e.g., a charging case or power puck
}
```

**Example Usage:**

```typescript
const power = session.capabilities.power

if (power.hasExternalBattery) {
  console.log("External battery pack available")
  // May affect battery monitoring strategies
} else {
  console.log("Built-in battery only")
}

// Subscribe to battery events
session.events.onGlassesBattery(data => {
  console.log(`Battery: ${data.level}% ${data.charging ? "(charging)" : ""}`)

  if (power.hasExternalBattery && data.charging) {
    console.log("Charging from external battery")
  }
})
```

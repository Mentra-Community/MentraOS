# Circular Video Buffer Integration Plan

## Current State Analysis

### CameraNeo Architecture

- **Service-based**: CameraNeo extends LifecycleService, runs as a foreground service
- **Headless operation**: No preview surface, direct camera-to-MediaRecorder recording
- **Single-use pattern**: Service starts, records/captures, then stops itself
- **Surface management**: MediaRecorder creates its own Surface, which is added to camera session

### Current Video Recording Flow

1. `startVideoRecording()` called via Intent
2. CameraNeo service starts
3. Opens camera device
4. Sets up MediaRecorder with file path
5. Gets Surface from MediaRecorder
6. Creates camera session with MediaRecorder's Surface
7. Starts recording
8. On stop: stops MediaRecorder, closes camera, stops service

### CircularVideoBuffer Current State

- Has MediaRecorder setup code but no camera integration
- Manages segment rotation and metadata
- Missing: actual camera Surface connection

## Integration Challenges

1. **Service Lifecycle**: CameraNeo stops itself after each operation, but buffer needs continuous running
2. **Surface Management**: Need multiple MediaRecorder instances with surfaces switching
3. **Camera Session**: Need to recreate session when switching between segments
4. **Headless Operation**: Must maintain headless approach (no preview)

## Proposed Solution

### Option 1: Modify CameraNeo for Multi-Mode Operation (Recommended)

Add a new "buffer mode" to CameraNeo that doesn't stop the service:

```java
public class CameraNeo extends LifecycleService {
    // Add new constants
    public static final String ACTION_START_BUFFER = "com.augmentos.camera.ACTION_START_BUFFER";
    public static final String ACTION_STOP_BUFFER = "com.augmentos.camera.ACTION_STOP_BUFFER";
    public static final String ACTION_SAVE_BUFFER = "com.augmentos.camera.ACTION_SAVE_BUFFER";

    // Add buffer mode flag
    private boolean isInBufferMode = false;
    private CircularVideoBufferInternal bufferManager;
}
```

### Option 2: Create Separate BufferRecordingService (Clean but More Complex)

Create a dedicated service for buffer recording that manages its own camera:

- Pros: Clean separation, doesn't affect existing code
- Cons: Duplicate camera management code, potential conflicts

## Detailed Implementation Plan (Option 1)

### Phase 1: Refactor CircularVideoBuffer

#### 1.1 Create CircularVideoBufferInternal

Location: `com.mentra.asg_client.camera.CircularVideoBufferInternal`

This will be a modified version that works directly with CameraNeo:

```java
public class CircularVideoBufferInternal {
    // Instead of managing MediaRecorder directly,
    // it will request CameraNeo to switch segments

    interface SegmentSwitchCallback {
        void onSwitchToSegment(int segmentIndex, String filePath);
        Surface getCurrentRecorderSurface();
    }

    private SegmentSwitchCallback cameraNeoCallback;
    private MediaRecorder[] recorders = new MediaRecorder[NUM_SEGMENTS];
    private int currentSegmentIndex = 0;

    // Key change: prepare all MediaRecorders upfront
    public void prepareAllRecorders() {
        for (int i = 0; i < NUM_SEGMENTS; i++) {
            recorders[i] = createAndPrepareRecorder(i);
        }
    }

    // Get surface for current segment
    public Surface getCurrentSegmentSurface() {
        return recorders[currentSegmentIndex].getSurface();
    }

    // Switch to next segment (called by timer)
    public void switchToNextSegment() {
        // Stop current recorder
        recorders[currentSegmentIndex].stop();

        // Move to next segment
        currentSegmentIndex = (currentSegmentIndex + 1) % NUM_SEGMENTS;

        // Reset and prepare the recorder we'll use again in 25 seconds
        int futureIndex = (currentSegmentIndex + NUM_SEGMENTS - 1) % NUM_SEGMENTS;
        recorders[futureIndex].reset();
        prepareRecorder(recorders[futureIndex], futureIndex);

        // Notify CameraNeo to recreate session with new surface
        cameraNeoCallback.onSwitchToSegment(currentSegmentIndex, getSegmentPath(currentSegmentIndex));
    }
}
```

### Phase 2: Modify CameraNeo

#### 2.1 Add Buffer Mode Support

```java
// In CameraNeo.java

private enum RecordingMode {
    SINGLE_VIDEO,  // Current behavior - record once and stop
    BUFFER         // Continuous buffer recording
}

private RecordingMode currentMode = RecordingMode.SINGLE_VIDEO;
private CircularVideoBufferInternal bufferManager;
private Handler segmentSwitchHandler;
private static final long SEGMENT_DURATION_MS = 5000; // 5 seconds

@Override
public int onStartCommand(Intent intent, int flags, int startId) {
    // ... existing cases ...

    case ACTION_START_BUFFER:
        currentMode = RecordingMode.BUFFER;
        startBufferRecording();
        break;

    case ACTION_STOP_BUFFER:
        stopBufferRecording();
        break;

    case ACTION_SAVE_BUFFER:
        int seconds = intent.getIntExtra("seconds", 30);
        String requestId = intent.getStringExtra("requestId");
        saveBufferVideo(seconds, requestId);
        break;
}

private void startBufferRecording() {
    // Initialize buffer manager
    bufferManager = new CircularVideoBufferInternal(this);
    bufferManager.prepareAllRecorders();

    // Open camera for buffer mode
    isInBufferMode = true;
    openCameraInternal(null, true); // true for video
}
```

#### 2.2 Modify Camera Session Creation for Buffer Mode

```java
private void createCameraSessionInternal(boolean forVideo) {
    // ... existing code ...

    if (forVideo && currentMode == RecordingMode.BUFFER) {
        // Use buffer manager's current surface
        Surface bufferSurface = bufferManager.getCurrentSegmentSurface();
        surfaces.add(bufferSurface);
        previewBuilder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
        previewBuilder.addTarget(bufferSurface);
    } else if (forVideo) {
        // Existing single video logic
        surfaces.add(recorderSurface);
        // ...
    }

    // ... rest of existing code ...
}
```

#### 2.3 Handle Segment Switching

```java
private void onBufferSegmentReady() {
    // Called when a segment finishes recording (every 5 seconds)

    // Stop current recording gracefully
    if (cameraCaptureSession != null) {
        try {
            cameraCaptureSession.stopRepeating();
            cameraCaptureSession.close();
        } catch (CameraAccessException e) {
            Log.e(TAG, "Error stopping session for segment switch", e);
        }
    }

    // Switch to next segment
    bufferManager.switchToNextSegment();

    // Recreate session with new surface
    createCameraSessionInternal(true);
}

// Timer to trigger segment switches
private void startSegmentTimer() {
    segmentSwitchHandler = new Handler();
    segmentSwitchHandler.postDelayed(new Runnable() {
        @Override
        public void run() {
            if (isInBufferMode) {
                onBufferSegmentReady();
                // Schedule next switch
                segmentSwitchHandler.postDelayed(this, SEGMENT_DURATION_MS);
            }
        }
    }, SEGMENT_DURATION_MS);
}
```

#### 2.4 Prevent Service Stop in Buffer Mode

```java
// Modify all stopSelf() calls to check mode first
private void conditionalStopSelf() {
    if (currentMode != RecordingMode.BUFFER) {
        stopSelf();
    }
}

// Replace all stopSelf() with conditionalStopSelf()
```

### Phase 3: Segment Concatenation

#### 3.1 Implement Proper MediaMuxer Concatenation

```java
private void concatenateSegments(List<String> segmentPaths, String outputPath) throws IOException {
    MediaMuxer muxer = new MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);

    // Track indices for output
    int videoTrackIndex = -1;
    int audioTrackIndex = -1;

    // Presentation time offset for each segment
    long videoTimeOffset = 0;
    long audioTimeOffset = 0;

    for (String segmentPath : segmentPaths) {
        MediaExtractor extractor = new MediaExtractor();
        extractor.setDataSource(segmentPath);

        // First segment: add tracks to muxer
        if (videoTrackIndex == -1) {
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);

                if (mime.startsWith("video/")) {
                    videoTrackIndex = muxer.addTrack(format);
                } else if (mime.startsWith("audio/")) {
                    audioTrackIndex = muxer.addTrack(format);
                }
            }
            muxer.start();
        }

        // Copy samples from segment
        ByteBuffer buffer = ByteBuffer.allocate(1024 * 1024);
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

        // Process video track
        extractor.selectTrack(findTrack(extractor, "video/"));
        while (copyNextSample(extractor, muxer, videoTrackIndex, buffer, info, videoTimeOffset)) {
            // Continue copying
        }
        videoTimeOffset = info.presentationTimeUs;

        // Process audio track
        extractor.selectTrack(findTrack(extractor, "audio/"));
        extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
        while (copyNextSample(extractor, muxer, audioTrackIndex, buffer, info, audioTimeOffset)) {
            // Continue copying
        }
        audioTimeOffset = info.presentationTimeUs;

        extractor.release();
    }

    muxer.stop();
    muxer.release();
}
```

### Phase 4: Integration Points

#### 4.1 Update MediaCaptureService

```java
// Instead of using CircularVideoBuffer, use CameraNeo in buffer mode
public void startBufferRecording() {
    Intent intent = new Intent(mContext, CameraNeo.class);
    intent.setAction(CameraNeo.ACTION_START_BUFFER);
    mContext.startForegroundService(intent);
}

public void stopBufferRecording() {
    Intent intent = new Intent(mContext, CameraNeo.class);
    intent.setAction(CameraNeo.ACTION_STOP_BUFFER);
    mContext.startForegroundService(intent);
}

public void saveBufferVideo(int secondsToSave, String requestId) {
    Intent intent = new Intent(mContext, CameraNeo.class);
    intent.setAction(CameraNeo.ACTION_SAVE_BUFFER);
    intent.putExtra("seconds", secondsToSave);
    intent.putExtra("requestId", requestId);
    mContext.startForegroundService(intent);
}
```

## Implementation Steps

1. **Week 1**: Refactor CircularVideoBuffer to CircularVideoBufferInternal
   - Remove direct MediaRecorder management
   - Add callback interface for CameraNeo
   - Implement proper segment metadata tracking

2. **Week 2**: Modify CameraNeo for buffer mode
   - Add buffer mode constants and flags
   - Implement segment switching logic
   - Prevent service stop in buffer mode
   - Add timer for automatic segment switches

3. **Week 3**: Implement MediaMuxer concatenation
   - Proper track copying between segments
   - Handle timing offsets
   - Test with various segment counts

4. **Week 4**: Testing and optimization
   - Test continuous recording for 30+ minutes
   - Verify segment rotation
   - Test save operations at various times
   - Memory leak testing

## Key Considerations

1. **Memory Management**: Pre-allocate MediaRecorders to avoid allocation during switches
2. **Surface Switching**: Quick session recreation to minimize gap between segments
3. **Timing Precision**: Use Handler with exact delays for consistent segments
4. **Error Recovery**: Handle camera disconnection/errors without losing buffer
5. **Power Management**: Maintain wake locks during buffer recording

## Alternative Approach: Using MediaCodec

If MediaRecorder switching proves problematic, consider using MediaCodec directly:

- More control over encoding
- Can write to circular buffer in memory
- More complex but more flexible

## Testing Plan

1. **Basic functionality**:
   - Start/stop buffer recording
   - Save various durations (5, 15, 30 seconds)
   - Verify concatenated video plays correctly

2. **Edge cases**:
   - Save while switching segments
   - Save immediately after start (partial buffer)
   - Camera interruption during buffering

3. **Performance**:
   - CPU/memory usage during continuous recording
   - Battery drain over 1 hour
   - Storage I/O impact

4. **Compatibility**:
   - Test on different Android versions (API 21+)
   - Different camera hardware capabilities

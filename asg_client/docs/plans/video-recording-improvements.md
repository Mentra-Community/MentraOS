# Video Recording Improvements Plan

## Overview

This document outlines the plan to improve video recording functionality in the ASG Client, including fixing the current implementation, adding compression, and implementing a 30-second buffer recording feature similar to NVIDIA Shadowplay.

## Current State Analysis

### Existing Issues

1. **Outdated Cloud Button Press**: Video recording still sends button presses to cloud server via REST (MediaCaptureService.java:226-332)
2. **High Bitrate**: Videos recorded at 10Mbps, consuming excessive storage
3. **No Upload Implementation**: Video upload to cloud marked as TODO (line 387)
4. **Inconsistent Command Handling**: Video commands don't match photo command pattern

### Current Architecture

- **AsgClientService**: Receives MCU commands (`cs_vdo`)
- **MediaCaptureService**: Orchestrates capture, but uses outdated cloud communication
- **CameraNeo**: Handles actual Camera2 API recording via MediaRecorder
- **Storage**: Videos saved to `/storage/emulated/0/Android/data/com.mentra.asg_client/files/`

## Phase 1: Fix Video Recording Command Flow

### Goal

Align video recording with photo capture pattern - direct command execution without cloud button press indirection.

### Changes Required

#### 1.1 MediaCaptureService.java Modifications

**Remove cloud communication from `handleVideoButtonPress()`**:

- Delete lines 226-332 (REST API communication)
- Replace with simple toggle logic:
  ```
  if (isRecordingVideo) -> stopVideoRecording()
  else -> startVideoRecording()
  ```

**Add new command handler**:

- Create `handleStartVideoCommand(requestId, save)` method
- Similar to existing `takePhotoAndUpload()` but for video
- Parameters:
  - `requestId`: Tracking identifier from phone
  - `save`: Whether to keep video after upload

#### 1.2 AsgClientService.java Updates

**Modify command processing**:

- Add case for `"start_video_recording"` command from phone
- Direct call to `mMediaCaptureService.handleStartVideoCommand()`
- Remove cloud button press forwarding for video

#### 1.3 Message Protocol Updates

**New phone-to-glasses messages**:

```json
{
  "type": "start_video_recording",
  "requestId": "video_123",
  "maxDuration": 30000,  // milliseconds, optional
  "save": true
}

{
  "type": "stop_video_recording",
  "requestId": "video_123"
}
```

**Glasses-to-phone responses**:

```json
{
  "type": "video_recording_started",
  "requestId": "video_123",
  "timestamp": 1234567890
}

{
  "type": "video_recording_stopped",
  "requestId": "video_123",
  "duration": 15000,
  "filePath": "/path/to/video.mp4"
}
```

### Testing Requirements

- Test video start/stop with phone connected
- Test offline fallback behavior
- Verify requestId tracking through full cycle
- Test rapid start/stop commands

## Phase 2: Video Compression & Optimization

### Goal

Reduce video file sizes while maintaining acceptable quality for smart glasses use cases.

### 2.1 Bitrate Optimization

**Current**: 10Mbps (excessive for 720p)
**Target**: Single preset configuration

- Standard Quality: 3Mbps for 720p
- Same settings for both regular recording and buffer recording

**Implementation in CameraNeo.java `setupMediaRecorder()`**:

- Update hardcoded bitrate from 10Mbps to 3Mbps
- Keep resolution at 1280x720
- Maintain 30fps for smooth video

### 2.2 Video Format Settings

**Fixed Settings** (CameraNeo.java:576-585):

- Resolution: 1280x720
- FPS: 30
- Video Bitrate: 3Mbps (reduced from 10Mbps)
- Audio: AAC 128kbps, 44.1kHz
- Keep all other settings the same

### Testing Requirements

- Verify file size reduction (~70% smaller)
- Confirm visual quality acceptable at 3Mbps
- Test recording performance with new bitrate

## Phase 3: 30-Second Buffer Recording (Shadowplay Feature)

### Goal

Continuously record last 30 seconds of POV, allowing users to save recent moments on-demand.

### 3.1 Architecture Design

**Circular Buffer Strategy**:

- Use segmented recording (not in-memory)
- 6 segments × 5 seconds each = 30 seconds total
- Circular overwrite of oldest segment
- Concatenate on-demand without re-encoding

**File Structure**:

```
/cache/video_buffer/
  ├── buffer_0.mp4 (seconds 0-5)
  ├── buffer_1.mp4 (seconds 5-10)
  ├── buffer_2.mp4 (seconds 10-15)
  ├── buffer_3.mp4 (seconds 15-20)
  ├── buffer_4.mp4 (seconds 20-25)
  ├── buffer_5.mp4 (seconds 25-30)
  └── metadata.json (timing info)
```

### 3.2 New Components

#### CircularVideoBuffer Class

Location: `com.mentra.asg_client.camera.CircularVideoBuffer`

**Responsibilities**:

- Manage segment rotation
- Track timing metadata
- Handle MediaRecorder lifecycle per segment
- Concatenate segments on save

**Key Methods**:

- `startBuffering()`: Begin continuous recording
- `stopBuffering()`: Stop and cleanup
- `saveBuffer(duration, outputPath)`: Save last N seconds
- `isBuffering()`: Check status
- `getBufferDuration()`: Get available buffer length

#### BufferRecordingService

Location: `com.mentra.asg_client.camera.BufferRecordingService`

**Responsibilities**:

- Foreground service for continuous recording
- Power management (wake locks)
- Storage monitoring
- Crash recovery

### 3.3 Implementation Details

#### Segment Recording Logic

```
1. Start recording to segment_0.mp4
2. After 5 seconds, stop and immediately start segment_1.mp4
3. Continue through segment_5.mp4
4. Wrap back to segment_0.mp4 (overwrite)
5. Maintain metadata with timestamps
```

#### Segment Concatenation

**Using MediaMuxer** (no re-encoding):

1. Calculate which segments needed for requested duration
2. Read segments in chronological order
3. Use MediaMuxer to combine into single file
4. Copy tracks without transcoding

#### Power Management

- Acquire partial wake lock during buffering
- Use foreground service with notification
- Simple implementation without battery/thermal monitoring

### 3.4 User Controls

#### New Commands from Phone

**Start buffer recording**:

```json
{
  "type": "start_buffer_recording"
}
```

**Save buffer**:

```json
{
  "type": "save_buffer_video",
  "duration": 30, // seconds to save (max 30)
  "requestId": "buffer_save_123"
}
```

**Stop buffer recording**:

```json
{
  "type": "stop_buffer_recording"
}
```

**Get buffer status**:

```json
{
  "type": "get_buffer_status"
}
```

#### Status Responses

```json
{
  "type": "buffer_status",
  "isBuffering": true,
  "availableDuration": 25, // seconds currently in buffer
  "segmentCount": 5,
  "totalSize": 15728640 // bytes
}
```

### 3.5 Storage Management

**Cleanup Strategy**:

- Delete segments on service stop
- Clear cache on app restart
- Simple monitoring (log warnings if low)

**Size Estimates** (at 3Mbps):

- Per segment (5 sec): ~1.8MB
- Full buffer (30 sec): ~11MB
- With metadata: ~12MB total

### 3.6 Edge Cases & Error Handling

**Handle these scenarios**:

1. **Storage full during buffering**: Stop and notify
2. **Camera in use**: Queue or reject buffer start
3. **Segment write failure**: Skip and continue
4. **App crash**: Clean up orphaned segments on restart
5. **Rapid save commands**: Queue or reject if processing

### 3.7 Simple Feedback

**Notifications**:

- Basic notification during buffering (existing foreground service pattern)
- Log success/failure for debugging

### Testing Requirements

- Test 30+ minute continuous buffering
- Verify segment rotation accuracy
- Test save at various buffer fill levels
- Test recovery from crashes
- Verify concatenation produces valid video

## Phase 4: Video Upload Stub

### Goal

Add placeholder for future video upload implementation.

### 4.1 Upload Stub

**In MediaCaptureService.java**:

```java
private void uploadVideo(String videoPath, String requestId) {
    Log.d(TAG, "Video upload not implemented yet. Video saved locally: " + videoPath);
    // TODO: Implement WiFi upload when needed
    // For now, videos remain on device
}
```

**Keep videos on device**:

- Videos saved to standard app directory
- No automatic deletion
- Manual cleanup if needed

## Implementation Timeline

### Week 1-2: Phase 1 (Fix Command Flow)

- Day 1-2: Remove cloud button press code
- Day 3-4: Implement direct command handling
- Day 5-6: Update message protocols
- Day 7-8: Testing and debugging
- Day 9-10: Integration testing with phone app

### Week 3: Phase 2 (Compression)

- Day 1-2: Update bitrate to 3Mbps
- Day 3-4: Test and verify quality/size
- Day 5: Performance testing

### Week 4-6: Phase 3 (Buffer Recording)

- Day 1-3: Create CircularVideoBuffer class
- Day 4-6: Implement segment recording logic
- Day 7-9: Add concatenation using MediaMuxer
- Day 10-12: Create BufferRecordingService
- Day 13-15: Integration and testing

### Week 7: Phase 4 (Upload Stub)

- Day 1: Add upload stub with logging
- Day 2-5: End-to-end testing of all features

## Success Metrics

1. **Performance**:
   - Video recording starts within 2 seconds
   - Buffer recording runs continuously without issues
   - File sizes reduced by ~70% with bitrate change

2. **Reliability**:
   - 99% success rate for video recording
   - Buffer recording survives app crashes
   - Proper cleanup of temporary files

3. **User Experience**:
   - Clear feedback via logs and notifications
   - Smooth 30-second buffer saves
   - No UI freezes during operations

## Risk Mitigation

1. **Storage Issues**: Pre-check available space, log warnings
2. **Memory Pressure**: Use file-based buffering, not RAM
3. **Compatibility**: Test on multiple Android versions (API 21+)

## Dependencies

- Android Camera2 API
- MediaRecorder (existing)
- MediaMuxer (for concatenation)

## Open Questions

1. **Camera conflict handling**: Use existing `CameraNeo.isCameraInUse()` check before starting any camera operation (photos, videos, RTMP, buffer). Only one camera operation at a time.

2. **Buffer duration**: Start with 30 seconds for simplicity. Can extend to 60 seconds later with `secondsToSave` parameter in save command if battery impact is minimal.

## Next Steps

1. Review plan with team
2. Create detailed tickets for each phase
3. Set up test devices and scenarios
4. Begin Phase 1 implementation
5. Create user documentation in parallel

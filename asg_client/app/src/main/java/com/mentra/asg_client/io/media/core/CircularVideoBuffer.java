package com.mentra.asg_client.io.media.core;

import com.mentra.asg_client.camera.CameraNeo;

import android.content.Context;
import android.media.MediaExtractor;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Manages a circular buffer for continuous video recording.
 * Records video in segments that continuously overwrite the oldest data,
 * maintaining a rolling window of the last 30 seconds.
 */
public class CircularVideoBuffer {
    private static final String TAG = "CircularVideoBuffer";
    
    // Buffer configuration
    private static final int SEGMENT_DURATION_SECONDS = 5;
    private static final int NUM_SEGMENTS = 6; // 6 x 5 seconds = 30 seconds total
    private static final int VIDEO_BITRATE = 3000000; // 3Mbps, same as regular recording
    private static final int VIDEO_WIDTH = 1280;
    private static final int VIDEO_HEIGHT = 720;
    private static final int VIDEO_FPS = 30;
    private static final int AUDIO_BITRATE = 128000;
    private static final int AUDIO_SAMPLE_RATE = 44100;
    
    private final Context mContext;
    private final File mBufferDir;
    private final Handler mHandler;
    private HandlerThread mHandlerThread;
    
    // Recording state
    private MediaRecorder mCurrentRecorder;
    private int mCurrentSegmentIndex = 0;
    private boolean mIsBuffering = false;
    private long mBufferingStartTime = 0;
    
    // Segment metadata
    private final List<SegmentInfo> mSegmentInfos = new ArrayList<>();
    
    // Callbacks
    private BufferCallback mCallback;
    
    /**
     * Information about a recorded segment
     */
    private static class SegmentInfo {
        String filePath;
        long startTime;
        long endTime;
        int index;
        boolean isValid;
        
        SegmentInfo(String path, int idx) {
            this.filePath = path;
            this.index = idx;
            this.isValid = false;
        }
    }
    
    /**
     * Callback interface for buffer events
     */
    public interface BufferCallback {
        void onBufferingStarted();
        void onBufferingStopped();
        void onSegmentRecorded(int segmentIndex, String filePath);
        void onBufferSaved(String outputPath, int durationSeconds);
        void onBufferError(String error);
    }
    
    /**
     * Constructor
     * @param context Application context
     */
    public CircularVideoBuffer(Context context) {
        mContext = context.getApplicationContext();
        
        // Create buffer directory
        mBufferDir = new File(mContext.getCacheDir(), "video_buffer");
        if (!mBufferDir.exists()) {
            mBufferDir.mkdirs();
        }
        
        // Initialize handler thread for background operations
        mHandlerThread = new HandlerThread("CircularVideoBuffer");
        mHandlerThread.start();
        mHandler = new Handler(mHandlerThread.getLooper());
        
        // Initialize segment info list
        for (int i = 0; i < NUM_SEGMENTS; i++) {
            String segmentPath = new File(mBufferDir, "buffer_" + i + ".mp4").getAbsolutePath();
            mSegmentInfos.add(new SegmentInfo(segmentPath, i));
        }
    }
    
    /**
     * Set the callback for buffer events
     */
    public void setCallback(BufferCallback callback) {
        mCallback = callback;
    }
    
    /**
     * Start continuous buffering
     */
    public void startBuffering() {
        if (mIsBuffering) {
            Log.w(TAG, "Already buffering");
            return;
        }
        
        // Check if camera is available
        if (CameraNeo.isCameraInUse()) {
            Log.e(TAG, "Cannot start buffering - camera is in use");
            if (mCallback != null) {
                mCallback.onBufferError("Camera is busy");
            }
            return;
        }
        
        Log.d(TAG, "Starting circular video buffer using CameraNeo");
        mIsBuffering = true;
        mBufferingStartTime = System.currentTimeMillis();
        mCurrentSegmentIndex = 0;
        
        // Clear any existing segments
        cleanupSegments();
        
        // Use CameraNeo's buffer mode instead of managing MediaRecorder directly
        CameraNeo.startBufferRecording(mContext, new CameraNeo.BufferCallback() {
            @Override
            public void onBufferStarted() {
                Log.d(TAG, "CameraNeo buffer started");
                if (mCallback != null) {
                    mCallback.onBufferingStarted();
                }
            }
            
            @Override
            public void onBufferStopped() {
                Log.d(TAG, "CameraNeo buffer stopped");
                mIsBuffering = false;
                if (mCallback != null) {
                    mCallback.onBufferingStopped();
                }
            }
            
            @Override
            public void onBufferSaved(String filePath, int durationSeconds) {
                Log.d(TAG, "CameraNeo buffer saved: " + filePath);
                if (mCallback != null) {
                    mCallback.onBufferSaved(filePath, durationSeconds);
                }
            }
            
            @Override
            public void onBufferError(String error) {
                Log.e(TAG, "CameraNeo buffer error: " + error);
                mIsBuffering = false;
                if (mCallback != null) {
                    mCallback.onBufferError(error);
                }
            }
        });
    }
    
    /**
     * Stop buffering
     */
    public void stopBuffering() {
        if (!mIsBuffering) {
            Log.w(TAG, "Not currently buffering");
            return;
        }
        
        Log.d(TAG, "Stopping circular video buffer");
        mIsBuffering = false;
        
        // Stop CameraNeo buffer recording
        CameraNeo.stopBufferRecording(mContext);
        
        // Callback will be called from CameraNeo's BufferCallback.onBufferStopped()
    }
    
    /**
     * Save the last N seconds of buffer to a file
     * @param durationSeconds Number of seconds to save (max 30)
     * @param outputPath Path where the concatenated video should be saved
     */
    public void saveBuffer(int durationSeconds, String outputPath) {
        if (durationSeconds <= 0 || durationSeconds > 30) {
            Log.e(TAG, "Invalid duration: " + durationSeconds + " (must be 1-30 seconds)");
            if (mCallback != null) {
                mCallback.onBufferError("Invalid duration");
            }
            return;
        }
        
        if (!mIsBuffering) {
            Log.e(TAG, "Cannot save buffer - not currently buffering");
            if (mCallback != null) {
                mCallback.onBufferError("Not buffering");
            }
            return;
        }
        
        // Generate a request ID for tracking
        String requestId = "buffer_" + System.currentTimeMillis();
        
        // Use CameraNeo to save the buffer
        Log.d(TAG, "Requesting CameraNeo to save " + durationSeconds + " seconds of buffer");
        CameraNeo.saveBufferVideo(mContext, durationSeconds, requestId);
        
        // The callback will be called via CameraNeo's BufferCallback.onBufferSaved()
    }
    
    /**
     * Check if currently buffering
     */
    public boolean isBuffering() {
        return mIsBuffering;
    }
    
    /**
     * Get the available buffer duration in seconds
     */
    public int getBufferDuration() {
        int validSegments = 0;
        for (SegmentInfo info : mSegmentInfos) {
            if (info.isValid) {
                validSegments++;
            }
        }
        return validSegments * SEGMENT_DURATION_SECONDS;
    }
    
    /**
     * Get buffer status as JSON
     */
    public JSONObject getBufferStatus() {
        JSONObject status = new JSONObject();
        try {
            status.put("isBuffering", mIsBuffering);
            status.put("availableDuration", getBufferDuration());
            status.put("segmentCount", NUM_SEGMENTS);
            status.put("currentSegment", mCurrentSegmentIndex);
            
            // Calculate total size
            long totalSize = 0;
            for (SegmentInfo info : mSegmentInfos) {
                if (info.isValid) {
                    File f = new File(info.filePath);
                    if (f.exists()) {
                        totalSize += f.length();
                    }
                }
            }
            status.put("totalSize", totalSize);
            
        } catch (JSONException e) {
            Log.e(TAG, "Error creating status JSON", e);
        }
        return status;
    }
    
    /**
     * Start recording a specific segment
     */
    private void startSegmentRecording(int segmentIndex) {
        if (!mIsBuffering) {
            return;
        }
        
        try {
            SegmentInfo segmentInfo = mSegmentInfos.get(segmentIndex);
            File segmentFile = new File(segmentInfo.filePath);
            
            // Create new MediaRecorder for this segment
            mCurrentRecorder = new MediaRecorder();
            
            // Configure audio and video sources
            mCurrentRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            mCurrentRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
            
            // Set output format
            mCurrentRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            
            // Set output file
            mCurrentRecorder.setOutputFile(segmentFile.getAbsolutePath());
            
            // Set video parameters (same as regular recording)
            mCurrentRecorder.setVideoEncodingBitRate(VIDEO_BITRATE);
            mCurrentRecorder.setVideoFrameRate(VIDEO_FPS);
            mCurrentRecorder.setVideoSize(VIDEO_WIDTH, VIDEO_HEIGHT);
            mCurrentRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
            
            // Set audio parameters
            mCurrentRecorder.setAudioEncodingBitRate(AUDIO_BITRATE);
            mCurrentRecorder.setAudioSamplingRate(AUDIO_SAMPLE_RATE);
            mCurrentRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            
            // Set orientation
            mCurrentRecorder.setOrientationHint(270);
            
            // Set max duration for this segment
            mCurrentRecorder.setMaxDuration(SEGMENT_DURATION_SECONDS * 1000);
            
            // Set listener for when segment is complete
            mCurrentRecorder.setOnInfoListener((mr, what, extra) -> {
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                    onSegmentComplete(segmentIndex);
                }
            });
            
            // Prepare and start
            mCurrentRecorder.prepare();
            
            // Now we need to get camera surface and start - this would integrate with CameraNeo
            // For now, this is a placeholder - actual implementation would need CameraNeo integration
            Log.d(TAG, "Starting segment " + segmentIndex + " recording");
            
            // Update segment info
            segmentInfo.startTime = System.currentTimeMillis();
            segmentInfo.isValid = false; // Will be set to true when segment completes
            
            // Note: Actual camera surface connection would happen here through CameraNeo
            // This is where we'd need to integrate with the camera service
            
        } catch (Exception e) {
            Log.e(TAG, "Error starting segment recording", e);
            if (mCallback != null) {
                mCallback.onBufferError("Failed to start segment: " + e.getMessage());
            }
        }
    }
    
    /**
     * Called when a segment recording is complete
     */
    private void onSegmentComplete(int segmentIndex) {
        Log.d(TAG, "Segment " + segmentIndex + " complete");
        
        // Mark segment as valid
        SegmentInfo info = mSegmentInfos.get(segmentIndex);
        info.endTime = System.currentTimeMillis();
        info.isValid = true;
        
        if (mCallback != null) {
            mCallback.onSegmentRecorded(segmentIndex, info.filePath);
        }
        
        // Stop current recorder
        stopCurrentRecording();
        
        // Move to next segment (with wraparound)
        mCurrentSegmentIndex = (segmentIndex + 1) % NUM_SEGMENTS;
        
        // Start recording next segment
        if (mIsBuffering) {
            startSegmentRecording(mCurrentSegmentIndex);
        }
    }
    
    /**
     * Stop the current recording
     */
    private void stopCurrentRecording() {
        if (mCurrentRecorder != null) {
            try {
                mCurrentRecorder.stop();
                mCurrentRecorder.release();
            } catch (Exception e) {
                Log.e(TAG, "Error stopping recorder", e);
            }
            mCurrentRecorder = null;
        }
    }
    
    /**
     * Concatenate segments into a single video file
     */
    private void concatenateSegments(int durationSeconds, String outputPath) throws IOException {
        // Calculate which segments we need
        int segmentsNeeded = (int) Math.ceil(durationSeconds / (float) SEGMENT_DURATION_SECONDS);
        
        // Find the most recent valid segments
        List<String> segmentPaths = new ArrayList<>();
        int currentIdx = mCurrentSegmentIndex;
        
        for (int i = 0; i < segmentsNeeded && i < NUM_SEGMENTS; i++) {
            // Go backwards from current index
            int idx = (currentIdx - i - 1 + NUM_SEGMENTS) % NUM_SEGMENTS;
            SegmentInfo info = mSegmentInfos.get(idx);
            
            if (info.isValid && new File(info.filePath).exists()) {
                segmentPaths.add(0, info.filePath); // Add to beginning to maintain chronological order
            }
        }
        
        if (segmentPaths.isEmpty()) {
            throw new IOException("No valid segments available");
        }
        
        Log.d(TAG, "Concatenating " + segmentPaths.size() + " segments to " + outputPath);
        
        // Use MediaMuxer to concatenate without re-encoding
        MediaMuxer muxer = new MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        
        try {
            // This is a simplified version - full implementation would properly copy all tracks
            for (String segmentPath : segmentPaths) {
                appendSegmentToMuxer(muxer, segmentPath);
            }
        } finally {
            muxer.stop();
            muxer.release();
        }
    }
    
    /**
     * Append a segment to the muxer
     * Note: This is a simplified implementation - production code would need proper track handling
     */
    private void appendSegmentToMuxer(MediaMuxer muxer, String segmentPath) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        extractor.setDataSource(segmentPath);
        
        // This would need proper implementation to handle multiple tracks, timing, etc.
        // For now this is a placeholder showing the structure
        Log.d(TAG, "Appending segment: " + segmentPath);
        
        extractor.release();
    }
    
    /**
     * Clean up all segment files
     */
    private void cleanupSegments() {
        for (SegmentInfo info : mSegmentInfos) {
            File f = new File(info.filePath);
            if (f.exists()) {
                f.delete();
            }
            info.isValid = false;
        }
    }
    
    /**
     * Clean up resources
     */
    public void release() {
        stopBuffering();
        cleanupSegments();
        
        if (mHandlerThread != null) {
            mHandlerThread.quit();
            mHandlerThread = null;
        }
    }
}
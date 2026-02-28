package com.mentra.asg_client.io.media.core;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import android.util.Log;
import android.view.Surface;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Internal circular buffer implementation that works directly with CameraNeo.
 * Manages multiple MediaRecorder instances and handles segment switching.
 */
public class CircularVideoBufferInternal {
    private static final String TAG = "CircularVideoBufferInt";
    
    // Buffer configuration - same as original
    private static final int SEGMENT_DURATION_SECONDS = 5;
    private static final int NUM_SEGMENTS = 6; // 6 x 5 seconds = 30 seconds total
    private static final int VIDEO_BITRATE = 3000000; // 3Mbps
    private static final int VIDEO_WIDTH = 1280;
    private static final int VIDEO_HEIGHT = 720;
    private static final int VIDEO_FPS = 30;
    private static final int AUDIO_BITRATE = 128000;
    private static final int AUDIO_SAMPLE_RATE = 44100;
    private static final int JPEG_ORIENTATION = 270; // Standard orientation
    
    private final Context mContext;
    private final File mBufferDir;
    
    // MediaRecorder array for all segments
    private MediaRecorder[] mRecorders = new MediaRecorder[NUM_SEGMENTS];
    private Surface[] mSurfaces = new Surface[NUM_SEGMENTS];
    private boolean[] mSegmentValid = new boolean[NUM_SEGMENTS];
    private long[] mSegmentStartTimes = new long[NUM_SEGMENTS];
    
    // Current state
    private int mCurrentSegmentIndex = 0;
    private boolean mIsBuffering = false;
    private long mBufferingStartTime = 0;
    
    // Callback to CameraNeo for segment switches
    private SegmentSwitchCallback mCallback;
    
    /**
     * Callback interface for CameraNeo to handle segment switches
     */
    public interface SegmentSwitchCallback {
        void onSegmentSwitch(int newSegmentIndex, Surface newSurface);
        void onBufferError(String error);
        void onSegmentReady(int segmentIndex, String filePath);
    }
    
    /**
     * Constructor
     * @param context Application context
     */
    public CircularVideoBufferInternal(Context context) {
        mContext = context.getApplicationContext();
        
        // Create buffer directory in cache
        mBufferDir = new File(mContext.getCacheDir(), "video_buffer");
        if (!mBufferDir.exists()) {
            mBufferDir.mkdirs();
        }
        
        // Clean up any old segments
        cleanupOldSegments();
    }
    
    /**
     * Set the callback for segment switches
     */
    public void setCallback(SegmentSwitchCallback callback) {
        mCallback = callback;
    }
    
    /**
     * Prepare all MediaRecorder instances upfront
     * This is called once when buffer recording starts
     */
    public void prepareAllRecorders() throws IOException {
        Log.d(TAG, "Preparing all " + NUM_SEGMENTS + " MediaRecorder instances");
        
        for (int i = 0; i < NUM_SEGMENTS; i++) {
            prepareRecorderAtIndex(i);
        }
        
        mIsBuffering = true;
        mBufferingStartTime = System.currentTimeMillis();
    }
    
    /**
     * Prepare a single MediaRecorder at the given index
     */
    private void prepareRecorderAtIndex(int index) throws IOException {
        // Clean up any existing recorder
        if (mRecorders[index] != null) {
            try {
                mRecorders[index].release();
            } catch (Exception e) {
                Log.w(TAG, "Error releasing old recorder at index " + index, e);
            }
            mRecorders[index] = null;
            mSurfaces[index] = null;
        }
        
        // Create new MediaRecorder
        MediaRecorder recorder = new MediaRecorder();
        
        // Configure audio and video sources
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
        recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
        
        // Set output format
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        
        // Set output file
        String segmentPath = getSegmentPath(index);
        recorder.setOutputFile(segmentPath);
        
        // Set video encoding parameters (same as regular recording)
        recorder.setVideoEncodingBitRate(VIDEO_BITRATE);
        recorder.setVideoFrameRate(VIDEO_FPS);
        recorder.setVideoSize(VIDEO_WIDTH, VIDEO_HEIGHT);
        recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
        
        // Set audio encoding parameters
        recorder.setAudioEncodingBitRate(AUDIO_BITRATE);
        recorder.setAudioSamplingRate(AUDIO_SAMPLE_RATE);
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        
        // Set orientation
        recorder.setOrientationHint(JPEG_ORIENTATION);
        
        // Set max duration for this segment (with small buffer for overlap)
        recorder.setMaxDuration((SEGMENT_DURATION_SECONDS * 1000) + 100);
        
        // Prepare the recorder
        recorder.prepare();
        
        // Store the recorder and its surface
        mRecorders[index] = recorder;
        mSurfaces[index] = recorder.getSurface();
        mSegmentValid[index] = false; // Will be set to true when segment completes
        
        Log.d(TAG, "Prepared recorder at index " + index + " for file: " + segmentPath);
    }
    
    /**
     * Get the surface for the current segment
     */
    public Surface getCurrentSurface() {
        if (mCurrentSegmentIndex >= 0 && mCurrentSegmentIndex < NUM_SEGMENTS) {
            return mSurfaces[mCurrentSegmentIndex];
        }
        return null;
    }
    
    /**
     * Start recording on the current segment
     * Called by CameraNeo after camera session is created
     */
    public void startCurrentSegment() {
        if (!mIsBuffering) {
            Log.w(TAG, "Not in buffering mode");
            return;
        }
        
        try {
            MediaRecorder recorder = mRecorders[mCurrentSegmentIndex];
            if (recorder != null) {
                recorder.start();
                mSegmentStartTimes[mCurrentSegmentIndex] = System.currentTimeMillis();
                Log.d(TAG, "Started recording segment " + mCurrentSegmentIndex);
            } else {
                Log.e(TAG, "Recorder is null for segment " + mCurrentSegmentIndex);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error starting segment " + mCurrentSegmentIndex, e);
            if (mCallback != null) {
                mCallback.onBufferError("Failed to start segment: " + e.getMessage());
            }
        }
    }
    
    /**
     * Switch to the next segment
     * This stops the current recorder and prepares the next one
     */
    public void switchToNextSegment() {
        if (!mIsBuffering) {
            return;
        }
        
        Log.d(TAG, "Switching from segment " + mCurrentSegmentIndex + " to next");
        
        // Stop current segment
        try {
            MediaRecorder currentRecorder = mRecorders[mCurrentSegmentIndex];
            if (currentRecorder != null) {
                currentRecorder.stop();
                mSegmentValid[mCurrentSegmentIndex] = true;
                
                // Notify callback that segment is ready
                if (mCallback != null) {
                    mCallback.onSegmentReady(mCurrentSegmentIndex, getSegmentPath(mCurrentSegmentIndex));
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error stopping segment " + mCurrentSegmentIndex, e);
        }
        
        // Calculate next index (circular)
        int nextIndex = (mCurrentSegmentIndex + 1) % NUM_SEGMENTS;
        
        // Prepare the recorder we're about to overwrite (it was used 30 seconds ago)
        try {
            prepareRecorderAtIndex(nextIndex);
        } catch (IOException e) {
            Log.e(TAG, "Error preparing next segment " + nextIndex, e);
            if (mCallback != null) {
                mCallback.onBufferError("Failed to prepare next segment: " + e.getMessage());
            }
            return;
        }
        
        // Update current index
        mCurrentSegmentIndex = nextIndex;
        
        // Start recording on the new segment
        try {
            MediaRecorder nextRecorder = mRecorders[mCurrentSegmentIndex];
            if (nextRecorder != null) {
                nextRecorder.start();
                mSegmentStartTimes[mCurrentSegmentIndex] = System.currentTimeMillis();
                Log.d(TAG, "Started recording on segment " + mCurrentSegmentIndex);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error starting recording on segment " + mCurrentSegmentIndex, e);
        }
        
        // Notify CameraNeo to switch camera session to new surface
        if (mCallback != null) {
            Surface newSurface = mSurfaces[mCurrentSegmentIndex];
            mCallback.onSegmentSwitch(mCurrentSegmentIndex, newSurface);
        }
    }
    
    /**
     * Stop all recording and clean up
     */
    public void stopBuffering() {
        Log.d(TAG, "Stopping circular buffer");
        mIsBuffering = false;
        
        // Stop current segment if recording
        try {
            if (mCurrentSegmentIndex >= 0 && mCurrentSegmentIndex < NUM_SEGMENTS) {
                MediaRecorder recorder = mRecorders[mCurrentSegmentIndex];
                if (recorder != null) {
                    recorder.stop();
                    mSegmentValid[mCurrentSegmentIndex] = true;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Error stopping current segment", e);
        }
        
        // Release all recorders
        for (int i = 0; i < NUM_SEGMENTS; i++) {
            if (mRecorders[i] != null) {
                try {
                    mRecorders[i].release();
                } catch (Exception e) {
                    Log.w(TAG, "Error releasing recorder " + i, e);
                }
                mRecorders[i] = null;
                mSurfaces[i] = null;
            }
        }
    }
    
    /**
     * Save the last N seconds to a file
     */
    public void saveLastNSeconds(int seconds, String outputPath) throws IOException {
        if (seconds <= 0 || seconds > 30) {
            throw new IllegalArgumentException("Duration must be between 1 and 30 seconds");
        }
        
        // Calculate which segments we need
        int segmentsNeeded = (int) Math.ceil(seconds / (float) SEGMENT_DURATION_SECONDS);
        
        // Collect valid segment paths in chronological order
        List<String> segmentPaths = new ArrayList<>();
        
        // Start from current segment and go backwards
        for (int i = 0; i < segmentsNeeded && i < NUM_SEGMENTS; i++) {
            int index = (mCurrentSegmentIndex - i + NUM_SEGMENTS) % NUM_SEGMENTS;
            
            if (mSegmentValid[index]) {
                String path = getSegmentPath(index);
                File file = new File(path);
                if (file.exists()) {
                    segmentPaths.add(0, path); // Add to beginning for chronological order
                }
            }
        }
        
        if (segmentPaths.isEmpty()) {
            throw new IOException("No valid segments available");
        }
        
        Log.d(TAG, "Concatenating " + segmentPaths.size() + " segments to " + outputPath);
        
        // Concatenate segments using MediaMuxer
        concatenateSegments(segmentPaths, outputPath, seconds);
    }
    
    /**
     * Concatenate multiple segment files into one output file
     */
    private void concatenateSegments(List<String> segmentPaths, String outputPath, int targetDurationSeconds) throws IOException {
        MediaMuxer muxer = null;
        
        try {
            muxer = new MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            
            int videoTrackIndex = -1;
            int audioTrackIndex = -1;
            
            // Timing offsets for concatenation
            long videoTimeOffset = 0;
            long audioTimeOffset = 0;
            long targetDurationUs = targetDurationSeconds * 1000000L;
            long totalDuration = 0;
            
            for (String segmentPath : segmentPaths) {
                MediaExtractor extractor = new MediaExtractor();
                extractor.setDataSource(segmentPath);
                
                // On first segment, add tracks to muxer
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
                
                // Copy samples from this segment
                boolean segmentDone = false;
                ByteBuffer buffer = ByteBuffer.allocate(1024 * 1024);
                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                
                // Process video track
                int videoTrack = findTrack(extractor, "video/");
                if (videoTrack >= 0) {
                    extractor.selectTrack(videoTrack);
                    
                    while (!segmentDone) {
                        int sampleSize = extractor.readSampleData(buffer, 0);
                        if (sampleSize < 0) {
                            break;
                        }
                        
                        info.offset = 0;
                        info.size = sampleSize;
                        info.presentationTimeUs = extractor.getSampleTime() + videoTimeOffset;
                        info.flags = extractor.getSampleFlags();
                        
                        // Check if we've reached target duration
                        if (totalDuration + info.presentationTimeUs > targetDurationUs) {
                            segmentDone = true;
                            break;
                        }
                        
                        muxer.writeSampleData(videoTrackIndex, buffer, info);
                        extractor.advance();
                    }
                    
                    // Update offset for next segment
                    if (!segmentDone) {
                        videoTimeOffset = info.presentationTimeUs;
                    }
                }
                
                // Process audio track (similar to video)
                if (!segmentDone && audioTrackIndex >= 0) {
                    extractor.unselectTrack(videoTrack);
                    int audioTrack = findTrack(extractor, "audio/");
                    if (audioTrack >= 0) {
                        extractor.selectTrack(audioTrack);
                        extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
                        
                        while (!segmentDone) {
                            int sampleSize = extractor.readSampleData(buffer, 0);
                            if (sampleSize < 0) {
                                break;
                            }
                            
                            info.offset = 0;
                            info.size = sampleSize;
                            info.presentationTimeUs = extractor.getSampleTime() + audioTimeOffset;
                            info.flags = extractor.getSampleFlags();
                            
                            muxer.writeSampleData(audioTrackIndex, buffer, info);
                            extractor.advance();
                        }
                        
                        audioTimeOffset = info.presentationTimeUs;
                    }
                }
                
                extractor.release();
                
                if (segmentDone) {
                    break;
                }
                
                totalDuration += SEGMENT_DURATION_SECONDS * 1000000L;
            }
            
        } finally {
            if (muxer != null) {
                try {
                    muxer.stop();
                    muxer.release();
                } catch (Exception e) {
                    Log.e(TAG, "Error stopping muxer", e);
                }
            }
        }
    }
    
    /**
     * Find track index by MIME type prefix
     */
    private int findTrack(MediaExtractor extractor, String mimePrefix) {
        for (int i = 0; i < extractor.getTrackCount(); i++) {
            MediaFormat format = extractor.getTrackFormat(i);
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (mime.startsWith(mimePrefix)) {
                return i;
            }
        }
        return -1;
    }
    
    /**
     * Get the file path for a segment
     */
    private String getSegmentPath(int index) {
        return new File(mBufferDir, "buffer_" + index + ".mp4").getAbsolutePath();
    }
    
    /**
     * Clean up old segment files
     */
    private void cleanupOldSegments() {
        for (int i = 0; i < NUM_SEGMENTS; i++) {
            File file = new File(getSegmentPath(i));
            if (file.exists()) {
                file.delete();
            }
        }
    }
    
    /**
     * Get buffer status
     */
    public JSONObject getStatus() {
        JSONObject status = new JSONObject();
        try {
            status.put("isBuffering", mIsBuffering);
            status.put("currentSegment", mCurrentSegmentIndex);
            status.put("segmentCount", NUM_SEGMENTS);
            
            // Count valid segments
            int validCount = 0;
            long totalSize = 0;
            for (int i = 0; i < NUM_SEGMENTS; i++) {
                if (mSegmentValid[i]) {
                    validCount++;
                    File f = new File(getSegmentPath(i));
                    if (f.exists()) {
                        totalSize += f.length();
                    }
                }
            }
            
            status.put("validSegments", validCount);
            status.put("availableDuration", validCount * SEGMENT_DURATION_SECONDS);
            status.put("totalSize", totalSize);
            
        } catch (JSONException e) {
            Log.e(TAG, "Error creating status JSON", e);
        }
        return status;
    }
    
    /**
     * Check if currently buffering
     */
    public boolean isBuffering() {
        return mIsBuffering;
    }
}
package com.augmentos.asg_client.audio;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.ActivityCompat;

import com.augmentos.asg_client.bluetooth.BluetoothManagerFactory;
import com.augmentos.asg_client.bluetooth.IBluetoothManager;
import com.augmentos.smartglassesmanager.cpp.L3cCpp;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Manages the microphone on non-K900 glasses to stream audio to the phone
 * when connected via Bluetooth LE.
 */
public class GlassesMicrophoneManager {
    private static final String TAG = "GlassesMicrophoneManager";
    
    // Audio configuration
    private static final int SAMPLING_RATE_IN_HZ = 16000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final float BUFFER_SIZE_SECONDS = 0.128f; // 128ms buffer (2048 samples)
    private final int bufferSize;
    
    // LC3 encoding configuration
    private static final int SAMPLE_RATE_HZ = 16000;
    private static final int FRAME_DURATION_US = 10000; // 10 ms - matching the augmentos_core implementation
    private static final int SAMPLES_PER_FRAME = SAMPLE_RATE_HZ / (1_000_000 / FRAME_DURATION_US); // 160 samples
    private static final int BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 16-bit = 2 bytes/sample = 320 bytes
    
    // Recording state
    private final AtomicBoolean recordingInProgress = new AtomicBoolean(false);
    private final AtomicBoolean isDestroyed = new AtomicBoolean(false);
    private AudioRecord recorder = null;
    private Thread recordingThread = null;
    
    // Dependencies
    private final Context context;
    private final IBluetoothManager bluetoothManager;
    private final Handler mainHandler;
    
    // Callbacks
    private LC3DataCallback lc3DataCallback;
    
    /**
     * Callback interface for LC3 encoded audio data
     */
    public interface LC3DataCallback {
        void onLC3DataAvailable(byte[] lc3Data);
    }
    
    /**
     * Creates a new GlassesMicrophoneManager
     * @param context The application context
     * @param bluetoothManager The existing bluetooth manager instance to use
     */
    public GlassesMicrophoneManager(Context context, IBluetoothManager bluetoothManager) {
        this.context = context.getApplicationContext();
        this.bluetoothManager = bluetoothManager; // Use existing instance instead of creating a new one
        this.mainHandler = new Handler(Looper.getMainLooper());
        
        // Log thread information for debugging
        Log.e(TAG, "⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫");
        Log.e(TAG, "⚫ GlassesMicrophoneManager CONSTRUCTOR CALLED");
        Log.e(TAG, "⚫ Thread ID: " + Thread.currentThread().getId() + ", Thread name: " + Thread.currentThread().getName());
        Log.e(TAG, "⚫ Using existing bluetooth manager: " + (bluetoothManager != null ? bluetoothManager.getClass().getSimpleName() : "null"));
        Log.e(TAG, "⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫⚫");
        
        // Calculate buffer size as power of 2
        int minBufferSize = AudioRecord.getMinBufferSize(
                SAMPLING_RATE_IN_HZ, CHANNEL_CONFIG, AUDIO_FORMAT);
        int targetSize = Math.round(SAMPLING_RATE_IN_HZ * BUFFER_SIZE_SECONDS);
        this.bufferSize = Math.max(minBufferSize, targetSize);
        
        Log.d(TAG, "Created GlassesMicrophoneManager with buffer size: " + bufferSize);
    }
    
    /**
     * Starts recording audio and streaming it over BLE when connected
     */
    public void startRecording() {
        // Always execute on main thread to prevent threading issues
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::startRecording);
            return;
        }
        
        // Skip if we're already recording or if the manager is destroyed
        if (recordingInProgress.get() || isDestroyed.get()) {
            Log.d(TAG, "Not starting recording - already recording or destroyed");
            return;
        }
        
        // Check permissions first
        if (ActivityCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) 
                != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "Cannot start recording - missing RECORD_AUDIO permission");
            return;
        }
        
        try {
            Log.d(TAG, "Starting audio recording...");
            
            // Initialize AudioRecord with parameters for speech
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                    SAMPLING_RATE_IN_HZ, CHANNEL_CONFIG, AUDIO_FORMAT, bufferSize * 2);
            
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "Failed to initialize AudioRecord");
                stopRecording();
                return;
            }
            
            // Start recording
            recorder.startRecording();
            recordingInProgress.set(true);
            
            // Start recording thread
            recordingThread = new Thread(new RecordingRunnable(), "ASG-Recording-Thread");
            recordingThread.setDaemon(true); // Make it a daemon thread
            recordingThread.start();
            
            Log.d(TAG, "Audio recording started successfully");
        } catch (Exception e) {
            Log.e(TAG, "Error starting audio recording", e);
            stopRecording();
        }
    }
    
    /**
     * Stops audio recording
     */
    public void stopRecording() {
        // Always execute on main thread to prevent threading issues
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::stopRecording);
            return;
        }
        
        Log.d(TAG, "Stopping audio recording...");
        
        // Set flag to stop the recording thread
        recordingInProgress.set(false);
        
        // Clean up the AudioRecord
        if (recorder != null) {
            try {
                // Only call stop if the recorder is actually recording
                if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    recorder.stop();
                }
            } catch (IllegalStateException e) {
                Log.e(TAG, "Error stopping AudioRecord", e);
            } finally {
                try {
                    recorder.release();
                } catch (Exception e) {
                    Log.e(TAG, "Error releasing AudioRecord", e);
                }
                recorder = null;
            }
        }
        
        // Wait for the recording thread to finish
        if (recordingThread != null) {
            try {
                recordingThread.interrupt();
                recordingThread.join(1000); // Wait up to 1 second
            } catch (InterruptedException e) {
                Log.e(TAG, "Interrupted while waiting for recording thread to finish", e);
            }
            recordingThread = null;
        }
        
        Log.d(TAG, "Audio recording stopped");
    }
    
    /**
     * Sets the callback for LC3 encoded data
     * @param callback The callback to set
     */
    public void setLC3DataCallback(LC3DataCallback callback) {
        this.lc3DataCallback = callback;
    }
    
    /**
     * Clean up resources and stop recording
     */
    public void destroy() {
        Log.d(TAG, "Destroying GlassesMicrophoneManager");
        
        // Set destroyed flag first to prevent new operations
        isDestroyed.set(true);
        
        // Stop recording
        stopRecording();
        
        // Clear references
        lc3DataCallback = null;
    }
    
    /**
     * Recording thread that captures audio, encodes it with LC3, and sends it over BLE
     */
    private class RecordingRunnable implements Runnable {
        private ByteBuffer remainderBuffer = ByteBuffer.allocate(BYTES_PER_FRAME * 2);
        private int remainderSize = 0;
        
        @Override
        public void run() {
            Log.d(TAG, "Recording thread started with LC3 config: " + 
                   FRAME_DURATION_US/1000.0 + "ms frames, " + 
                   SAMPLES_PER_FRAME + " samples per frame, " + 
                   BYTES_PER_FRAME + " bytes per frame");
            
            // Initialize LC3 encoder
            long encoderPtr = L3cCpp.initEncoder();
            if (encoderPtr == 0) {
                Log.e(TAG, "Failed to initialize LC3 encoder");
                return;
            }
            
            try {
                // Buffer for raw audio data
                short[] audioBuffer = new short[bufferSize];
                byte[] byteBuffer = new byte[bufferSize * 2]; // 16-bit = 2 bytes per sample
                
                // Remainder buffer to handle incomplete frames
                remainderBuffer.order(ByteOrder.LITTLE_ENDIAN);
                
                // Main recording loop
                while (recordingInProgress.get() && !isDestroyed.get() && !Thread.currentThread().isInterrupted()) {
                    // Check if recorder is still valid
                    AudioRecord localRecorder = recorder;
                    if (localRecorder == null) break;
                    
                    // Read audio data from microphone
                    int samplesRead = localRecorder.read(audioBuffer, 0, audioBuffer.length);
                    if (samplesRead <= 0) {
                        Log.e(TAG, "Error reading from AudioRecord: " + samplesRead);
                        break;
                    }
                    
                    // Convert short[] to byte[] (16-bit samples)
                    ByteBuffer.wrap(byteBuffer).order(ByteOrder.LITTLE_ENDIAN)
                            .asShortBuffer().put(audioBuffer, 0, samplesRead);
                    
                    // Add new data to remainder buffer
                    processNewAudioData(byteBuffer, samplesRead * 2, encoderPtr);
                    
                    // Small sleep to prevent CPU hogging
                    try {
                        Thread.sleep(5);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error in recording thread", e);
            } finally {
                // Clean up LC3 encoder
                if (encoderPtr != 0) {
                    L3cCpp.freeEncoder(encoderPtr);
                }
                Log.d(TAG, "Recording thread exiting");
            }
        }
        
        /**
         * Process new audio data, handle remainders, and encode complete frames
         */
        private void processNewAudioData(byte[] newData, int dataLength, long encoderPtr) {
            // If we have data from previous iteration
            if (remainderSize > 0) {
                // Make sure we have enough space
                if (remainderSize + dataLength > remainderBuffer.capacity()) {
                    // Expand the buffer if needed
                    ByteBuffer newBuffer = ByteBuffer.allocate(remainderSize + dataLength);
                    newBuffer.order(ByteOrder.LITTLE_ENDIAN);
                    remainderBuffer.flip();
                    newBuffer.put(remainderBuffer);
                    remainderBuffer = newBuffer;
                }
                
                // Add new data to remainder
                remainderBuffer.position(remainderSize);
                remainderBuffer.put(newData, 0, dataLength);
                remainderSize += dataLength;
            } else {
                // First data, just copy it
                if (dataLength > remainderBuffer.capacity()) {
                    remainderBuffer = ByteBuffer.allocate(dataLength);
                    remainderBuffer.order(ByteOrder.LITTLE_ENDIAN);
                }
                remainderBuffer.clear();
                remainderBuffer.put(newData, 0, dataLength);
                remainderSize = dataLength;
            }
            
            // Process complete frames
            remainderBuffer.flip();
            byte[] data = remainderBuffer.array();
            
            int frameCount = remainderSize / BYTES_PER_FRAME;
            int bytesProcessed = 0;
            
            // Process each complete frame
            for (int i = 0; i < frameCount; i++) {
                int offset = bytesProcessed;
                
                // Extract one frame of PCM data
                byte[] frameData = Arrays.copyOfRange(data, offset, offset + BYTES_PER_FRAME);
                bytesProcessed += BYTES_PER_FRAME;
                
                // Encode the PCM data to LC3
                byte[] lc3Data = L3cCpp.encodeLC3(encoderPtr, frameData);
                
                // Log the size of the encoded LC3 data for debugging
                if (i == 0) { // Only log for first frame to avoid spam
//                    Log.d(TAG, "LC3 encoding: " + FRAME_DURATION_US/1000 + "ms frame → " +
//                          frameData.length + " PCM bytes → " + lc3Data.length + " LC3 bytes");
                }
                
                // Send the LC3 data via callbacks
                sendLC3Data(lc3Data);
                
                // If we're connected to a central device, send over BLE - be extra defensive
                try {
                    // Check if BLE manager is still available
                    if (bluetoothManager != null) {
                        // Use a local variable to avoid NPE from isConnected() causing empty list
                        boolean isConnected = bluetoothManager.isConnected();
                        
                        if (isConnected) {
                            // Check one more time to be extra sure
                            if (bluetoothManager != null) {
                                // Add command byte (0xA0 = 160 decimal) for LC3 audio from glasses
                                byte[] packetWithCommand = new byte[lc3Data.length + 1];
                                packetWithCommand[0] = (byte)0xA0;
                                System.arraycopy(lc3Data, 0, packetWithCommand, 1, lc3Data.length);
                                
                                // Send the data with command byte
                                // Log this attempt with thread ID to track race conditions
                                long threadId = Thread.currentThread().getId();
                                //Log.d(TAG, "Thread-" + threadId + ": Sending LC3 audio packet (" +
                                //      packetWithCommand.length + " bytes) via BluetoothManager - LC3 frame size: " +
                                //      lc3Data.length + " bytes");
                                
                                boolean sendResult = bluetoothManager.sendData(packetWithCommand);
                                
                                // Log the send result for debugging
                                if (!sendResult) {
                                    Log.e(TAG, "Thread-" + threadId + ": ❌ Failed to send LC3 audio packet via BLE");
                                }
                            }
                        }
                    }
                } catch (Exception e) {
                    // Catch and log any exception to avoid crashing the microphone thread
                    Log.e(TAG, "Error sending LC3 audio data via BLE", e);
                }
            }
            
            // Save any remaining data for next iteration
            int remaining = remainderSize - bytesProcessed;
            if (remaining > 0) {
                ByteBuffer temp = ByteBuffer.allocate(remainderBuffer.capacity());
                temp.order(ByteOrder.LITTLE_ENDIAN);
                temp.put(data, bytesProcessed, remaining);
                remainderBuffer = temp;
                remainderSize = remaining;
            } else {
                remainderSize = 0;
                remainderBuffer.clear();
            }
        }
        
        /**
         * Send LC3 encoded data via callback
         */
        private void sendLC3Data(byte[] lc3Data) {
            if (lc3DataCallback != null && !isDestroyed.get()) {
                try {
                    lc3DataCallback.onLC3DataAvailable(lc3Data);
                } catch (Exception e) {
                    Log.e(TAG, "Error in LC3 data callback", e);
                }
            }
        }
    }
}
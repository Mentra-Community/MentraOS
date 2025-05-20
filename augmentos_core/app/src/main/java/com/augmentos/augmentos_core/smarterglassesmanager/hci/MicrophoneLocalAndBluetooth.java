package com.augmentos.augmentos_core.smarterglassesmanager.hci;

//thanks to https://github.com/aahlenst/android-audiorecord-sample/blob/master/src/main/java/com/example/audiorecord/BluetoothRecordActivity.java

import android.Manifest;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.CountDownTimer;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import com.augmentos.augmentos_core.microphone.MicrophoneService;

import androidx.core.app.ActivityCompat;

import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.AudioChunkNewEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.LC3AudioChunkNewEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.ScoStartEvent;
import com.augmentos.smartglassesmanager.cpp.L3cCpp;

import org.greenrobot.eventbus.EventBus;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

public class MicrophoneLocalAndBluetooth {
    private static final String TAG = "WearableAi_MicrophoneLocalAndBluetooth";

    private static final int SAMPLING_RATE_IN_HZ = 16000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private final static float BUFFER_SIZE_SECONDS = 0.128f; // gives us 2048
    private static final int BUFFER_SIZE_FACTOR = 2;
    private final int bufferSize;
    private boolean bluetoothAudio = false; // are we using local audio or bluetooth audio?
    private int retries = 0;
    private int retryLimit = 3;

    private Handler mHandler;

    private final AtomicBoolean recordingInProgress = new AtomicBoolean(false);
    private final AtomicBoolean isDestroyed = new AtomicBoolean(false); // Add this flag to indicate destruction

    // Flag to track receiver registration status
    private boolean isReceiverRegistered = false;

    private final BroadcastReceiver bluetoothStateReceiver = new BroadcastReceiver() {
        private BluetoothState bluetoothState = BluetoothState.UNAVAILABLE;

        @Override
        public void onReceive(Context context, Intent intent) {
            if (isDestroyed.get()) {
                // Don't process events if we're in destroyed state
                return;
            }

            String action = intent.getAction();
            if (action.equals(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)) {
                int state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1);
                switch (state) {
                    case AudioManager.SCO_AUDIO_STATE_CONNECTED:
                        if (mIsStarting) {
                            mIsStarting = false;
                        }
                        if (mIsCountDownOn) {
                            mIsCountDownOn = false;
                            mCountDown.cancel();
                        }
                        bluetoothAudio = true;
                        startRecording();
                        break;
                    case AudioManager.SCO_AUDIO_STATE_CONNECTING:
                        // Don't treat CONNECTING as UNAVAILABLE - it's a normal transition state
                        // Continue using normal mic mode while waiting for SCO to connect
                        Log.d(TAG, "SCO connecting - continuing with current recording...");
                        break;
                    case AudioManager.SCO_AUDIO_STATE_DISCONNECTED:
                        handleBluetoothStateChange(BluetoothState.UNAVAILABLE);
                        break;
                    case AudioManager.SCO_AUDIO_STATE_ERROR:
                        handleBluetoothStateChange(BluetoothState.UNAVAILABLE);
                        break;
                }
            } else if (action.equals(BluetoothDevice.ACTION_ACL_CONNECTED)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                Log.d(TAG, "Bluetooth device connected: " + (device != null ? device.getName() : "Unknown"));
                handleNewBluetoothDevice();
            } else if (action.equals(BluetoothDevice.ACTION_ACL_DISCONNECTED)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                Log.d(TAG, "Bluetooth device disconnected: " + (device != null ? device.getName() : "Unknown"));
                handleDisconnectBluetoothDevice();
            }
        }

        private void handleBluetoothStateChange(BluetoothState state) {
            if (bluetoothState == state) {
                return;
            }
            bluetoothState = state;
            bluetoothStateChanged(state);
        }

        private void handleNewBluetoothDevice() {
            Log.d(TAG, "New Bluetooth device connected, attempting SCO connection");
            retries = 0;
            // Try to use Bluetooth audio when a new device connects
            bluetoothAudio = true;
            // Reset and start the countdown timer for SCO connection
            mIsCountDownOn = true;
            if (mCountDown != null) {
                mCountDown.cancel();
            }
            mCountDown.start();
            // Try to activate Bluetooth SCO immediately
            activateBluetoothSco();
        }

        private void handleDisconnectBluetoothDevice() {
            if (mIsCountDownOn) {
                mIsCountDownOn = false;
                mCountDown.cancel();
            }
            bluetoothAudio = false;
            deactivateBluetoothSco();
            startRecording();
        }
    };

    private AudioRecord recorder = null;

    private AudioManager audioManager;
    private boolean mIsCountDownOn = false;
    private boolean mIsStarting = false;

    private Thread recordingThread = null;

    private Context mContext;

    private AudioChunkCallback mChunkCallback;
    private PhoneMicrophoneManager phoneMicManager;
    private CountDownTimer mCountDown;

    public MicrophoneLocalAndBluetooth(Context context, boolean useBluetoothSco, AudioChunkCallback chunkCallback) {
        this(context, useBluetoothSco, chunkCallback, null);
    }

    public MicrophoneLocalAndBluetooth(Context context, boolean useBluetoothSco, AudioChunkCallback chunkCallback, 
                                      PhoneMicrophoneManager phoneMicManager) {
        this(context, chunkCallback, phoneMicManager);
        useBluetoothMic(useBluetoothSco);
    }

    public MicrophoneLocalAndBluetooth(Context context, AudioChunkCallback chunkCallback) {
        this(context, chunkCallback, null);
    }

    public MicrophoneLocalAndBluetooth(Context context, AudioChunkCallback chunkCallback, 
                                     PhoneMicrophoneManager phoneMicManager) {
        bufferSize = Math.round(SAMPLING_RATE_IN_HZ * BUFFER_SIZE_SECONDS);

        mIsStarting = true;

        mContext = context;
        this.phoneMicManager = phoneMicManager;

        audioManager = (AudioManager) mContext.getSystemService(Context.AUDIO_SERVICE);

        mChunkCallback = chunkCallback;

        // Always use the main thread's Looper to prevent threading issues
        mHandler = new Handler(Looper.getMainLooper());

        // Start the dedicated microphone service
        startMicrophoneService(context);

        // Initialize the countdown timer
        initCountDownTimer();

        startRecording();
    }
    
    /**
     * Starts the dedicated microphone foreground service
     */
    private void startMicrophoneService(Context context) {
        Intent intent = new Intent(context, MicrophoneService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
        Log.d(TAG, "Started MicrophoneService for microphone permissions");
    }

    /**
     * Stops the dedicated microphone foreground service
     */
    private void stopMicrophoneService(Context context) {
        if (context == null) return;
        
        // On Android 14 (SDK 34+), we need to ensure the service has enough time to call
        // startForeground() before stopping it, otherwise we'll get a ForegroundServiceDidNotStartInTimeException
        
        try {
            // Instead of immediately stopping, wait briefly to ensure startForeground() has been called
            Handler handler = new Handler(Looper.getMainLooper());
            handler.postDelayed(() -> {
                try {
                    if (context != null) {
                        Intent intent = new Intent(context, MicrophoneService.class);
                        context.stopService(intent);
                        Log.d(TAG, "Stopped MicrophoneService after delay");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error stopping MicrophoneService", e);
                }
            }, 500); // 500ms delay to allow startForeground() to complete
            
            Log.d(TAG, "Scheduled MicrophoneService stop with delay");
        } catch (Exception e) {
            Log.e(TAG, "Error in delayed MicrophoneService stop", e);
        }
    }

    private void initCountDownTimer() {
        if (mCountDown != null) {
            mCountDown.cancel();
        }

        mCountDown = new CountDownTimer(1201, 400) {
            @Override
            public void onTick(long millisUntilFinished) {
                if (!isDestroyed.get()) {
                    audioManager.startBluetoothSco();
                }
            }

            @Override
            public void onFinish() {
                if (isDestroyed.get()) {
                    return;
                }
                mIsCountDownOn = false;
                bluetoothAudio = false;
                startRecording();
            }
        };
    }

    private void useBluetoothMic(boolean shouldUseBluetoothSco) {
        if (isDestroyed.get()) {
            return;
        }

        bluetoothAudio = shouldUseBluetoothSco;

        if (shouldUseBluetoothSco) {
            startBluetoothSco();
        } else {
            stopBluetoothSco();
        }

        if (recordingInProgress.get()) {
            startRecording();
        }
    }

    private void startBluetoothSco() {
        if (isDestroyed.get()) {
            return;
        }

        IntentFilter filter = new IntentFilter();
        filter.addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
        filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
        filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);

        try {
            if (isReceiverRegistered) {
                mContext.unregisterReceiver(bluetoothStateReceiver);
            }
            mContext.registerReceiver(bluetoothStateReceiver, filter);
            isReceiverRegistered = true;
        } catch (Exception e) {
            Log.e(TAG, "Error registering bluetooth receiver", e);
        }

        mIsCountDownOn = true;
        mCountDown.start();
    }

    private void stopBluetoothSco() {
        mIsCountDownOn = false;
        if (mCountDown != null) {
            mCountDown.cancel();
        }

        if (isReceiverRegistered) {
            try {
                mContext.unregisterReceiver(bluetoothStateReceiver);
                isReceiverRegistered = false;
                Log.d(TAG, "Bluetooth state receiver unregistered in stopBluetoothSco()");
            } catch (IllegalArgumentException e) {
                e.printStackTrace();
            }
        }
    }

    private synchronized void startRecording() {
        Log.d(TAG, "Starting recording...");

        if (isDestroyed.get()) {
            Log.d(TAG, "Not starting recording because the class is destroyed");
            return;
        }

        if (recorder != null) {
            stopRecording();
        }

        if (bluetoothAudio) {
            audioManager.setMode(AudioManager.MODE_IN_CALL);
            EventBus.getDefault().post(new ScoStartEvent(true));
        } else {
            audioManager.setMode(AudioManager.MODE_NORMAL);
            EventBus.getDefault().post(new ScoStartEvent(false));
        }

        if (ActivityCompat.checkSelfPermission(mContext, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this.mContext, "Need permissions to start audio", Toast.LENGTH_LONG).show();
            stopRecording();
            return;
        }

        try {
            recorder = new AudioRecord(MediaRecorder.AudioSource.CAMCORDER,
                    SAMPLING_RATE_IN_HZ, CHANNEL_CONFIG, AUDIO_FORMAT, bufferSize * 2);

            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "Failed to initialize AudioRecord");
                Toast.makeText(this.mContext, "Error starting onboard microphone", Toast.LENGTH_LONG).show();
                stopRecording();
                return;
            }
            
            // Register our AudioRecord with the PhoneMicrophoneManager for conflict detection
            // Do this BEFORE starting recording so we can filter out events from our own app
            if (phoneMicManager != null) {
                int sessionId = recorder.getAudioSessionId();
                Log.d(TAG, "Registering our AudioRecord with session ID: " + sessionId);
                phoneMicManager.registerOurAudioRecord(recorder);
            }

            // Start recording AFTER registering the AudioRecord
            recorder.startRecording();

            recordingInProgress.set(true);

            recordingThread = new Thread(new RecordingRunnable(), "Recording Thread");
            recordingThread.setDaemon(true); // Make it a daemon thread so it doesn't prevent JVM shutdown
            recordingThread.start();
        } catch (Exception e) {
            Log.e(TAG, "Error in startRecording", e);
            stopRecording();
        }
    }

    private void stopAndroidMics(){
        mIsCountDownOn = false;
        if (mCountDown != null) {
            mCountDown.cancel();
        }
        deactivateBluetoothSco();
        audioManager.setMode(AudioManager.MODE_NORMAL);

        stopRecording();
    }

    private synchronized void stopRecording() {
        Log.d(TAG, "Running stopRecording...");

        if (recorder == null) {
            Log.d(TAG, "--- Recorder null, exiting.");
            return;
        }

        recordingInProgress.set(false);
        
        // Store the recorder reference temporarily to ensure we can unregister it
        // even if an exception occurs during the stop process
        AudioRecord tempRecorder = recorder;

        try {
            // Unregister from PhoneMicrophoneManager BEFORE stopping to ensure
            // we don't react to our own recorder's stop event
            if (phoneMicManager != null && tempRecorder != null) {
                int sessionId = tempRecorder.getAudioSessionId();
                Log.d(TAG, "Unregistering our AudioRecord with session ID: " + sessionId);
                phoneMicManager.unregisterOurAudioRecord(tempRecorder);
            }
            
            // Only call stop if the recorder is actually recording.
            if (tempRecorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                tempRecorder.stop();
            } else {
                Log.d(TAG, "AudioRecord is not recording; skipping stop.");
            }
        } catch (IllegalStateException e) {
            Log.e(TAG, "Error stopping AudioRecord", e);
        } finally {
            try {
                if (tempRecorder != null) {
                    tempRecorder.release();
                }
            } catch (Exception e) {
                Log.e(TAG, "Error releasing AudioRecord", e);
            }
            recorder = null;
        }

        // Interrupt the recording thread to ensure it stops
        if (recordingThread != null) {
            try {
                recordingThread.interrupt();
                // Wait for thread to finish, but not indefinitely
                recordingThread.join(1000);
            } catch (InterruptedException e) {
                Log.e(TAG, "Interrupted while waiting for recording thread to finish", e);
            }
            recordingThread = null;
        }
    }

    private void activateBluetoothSco() {
        if (isDestroyed.get() || audioManager == null) {
            return;
        }

        retries += 1;
        Log.d(TAG, "Activating Bluetooth SCO (attempt " + retries + ")");

        if (!audioManager.isBluetoothScoAvailableOffCall()) {
            Log.e(TAG, "SCO is not available, recording is not possible");
            return;
        }

        try {
            // First check if SCO is already on
            if (audioManager.isBluetoothScoOn()) {
                Log.d(TAG, "Bluetooth SCO is already on");
            } else {
                // If not, try to start it
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audioManager.startBluetoothSco();
                Log.d(TAG, "Started Bluetooth SCO");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error activating Bluetooth SCO", e);
        }
    }

    private void deactivateBluetoothSco() {
        try {
            audioManager.stopBluetoothSco();
        } catch (Exception e) {
            Log.e(TAG, "Error deactivating Bluetooth SCO", e);
        }
    }

    private void bluetoothStateChanged(BluetoothState state) {
        if (isDestroyed.get()) {
            return;
        }

        Log.d(TAG, "Bluetooth state changed to: " + state);

        if (BluetoothState.UNAVAILABLE == state) {
            Log.d(TAG, "Bluetooth is unavailable, switching to device microphone");
            bluetoothAudio = false;
            if (recordingInProgress.get()) {
                stopRecording();
            }
            deactivateBluetoothSco();
            startRecording();
        } else if (BluetoothState.AVAILABLE == state) {
            Log.d(TAG, "Bluetooth is available, switching to Bluetooth microphone");
            bluetoothAudio = true;
            if (recordingInProgress.get()) {
                stopRecording();
            }
            activateBluetoothSco();
            startRecording();
        }
    }




    // ------------------------------------------------------------------------
    // PCM RECORDING SYSTEM (ADDED)
    // ------------------------------------------------------------------------
    private FileOutputStream pcmFileOutputStream = null;
    private long recordingStartTime = 0;
    private long bytesWritten = 0;
    private static final long RECORDING_DURATION_MS = 20000; // 20 seconds
    private static final String PCM_RECORDING_FOLDER = "AugmentOS_SOURCE_PCM_Recordings";

    /**
     * Writes audio data to the PCM file and checks if we've reached the recording duration.
     */
    private void writeToPcmFile(byte[] audioData) {
        if (pcmFileOutputStream == null) {
            startPcmRecording();
        }

        try {
            // Write the audio data to file
            pcmFileOutputStream.write(audioData);
            bytesWritten += audioData.length;

            // Check if we've recorded for the specified duration
            long elapsedTime = System.currentTimeMillis() - recordingStartTime;
            if (elapsedTime >= RECORDING_DURATION_MS) {
                stopPcmRecording();
            }
        } catch (IOException e) {
            Log.e(TAG, "Error writing to PCM file", e);
            stopPcmRecording();
        }
    }

    // ------------------------------------------------------------------------
    // PCM RECORDING METHODS (ADDED)
    // ------------------------------------------------------------------------

    /**
     * Starts a new PCM recording session, creating a new file.
     */
    private void startPcmRecording() {
        try {
            // Create directory if it doesn't exist
            File recordingDir = new File(mContext.getExternalFilesDir(null), PCM_RECORDING_FOLDER);
            if (!recordingDir.exists()) {
                recordingDir.mkdirs();
            }

            // Create a unique filename with timestamp
            SimpleDateFormat sdf = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US);
            String timestamp = sdf.format(new Date());
            File outputFile = new File(recordingDir, "pcm_recording_" + timestamp + ".pcm");

            // Open file stream
            pcmFileOutputStream = new FileOutputStream(outputFile);
            recordingStartTime = System.currentTimeMillis();
            bytesWritten = 0;

            Log.e(TAG, "📢 PCM RECORDING STARTED: " + outputFile.getAbsolutePath() + " 📢");
        } catch (IOException e) {
            Log.e(TAG, "Failed to create PCM recording file", e);
            pcmFileOutputStream = null;
        }
    }

    /**
     * Closes the current PCM recording file.
     */
    private void stopPcmRecording() {
        if (pcmFileOutputStream != null) {
            try {
                pcmFileOutputStream.close();
                Log.e(TAG, "📢 PCM RECORDING COMPLETED: " + bytesWritten + " bytes written 📢");
                // Clear the file stream reference but don't start a new recording
                pcmFileOutputStream = null;
            } catch (IOException e) {
                Log.e(TAG, "Error closing PCM file", e);
            }
        }
    }


    private static final int SAMPLE_RATE_HZ = 16000;
    private static final int FRAME_DURATION_US = 10000; // 10 ms
    private static final int SAMPLES_PER_FRAME = SAMPLE_RATE_HZ / (1_000_000 / FRAME_DURATION_US); // 160 samples
    private static final int BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 16-bit = 2 bytes/sample = 320 bytes
    private ByteArrayOutputStream remainderBuffer = new ByteArrayOutputStream();

    private class RecordingRunnable implements Runnable {
        private final ByteArrayOutputStream remainderBuffer = new ByteArrayOutputStream();
        private long encoderPtr = 0;
        private long decoderPtr = 0;

        @Override
        public void run() {
            encoderPtr = L3cCpp.initEncoder();
            decoderPtr = L3cCpp.initDecoder();
            if (encoderPtr == 0) {
                Log.e(TAG, "Failed to init LC3 encoder");
                return;
            }
            if (decoderPtr == 0) {
                Log.e(TAG, "Failed to init LC3 decoder");
                return;
            }

            short[] short_buffer = new short[bufferSize];
            ByteBuffer b_buffer = ByteBuffer.allocate(short_buffer.length * 2);

            AudioRecord localRecorder;

            while (recordingInProgress.get() && !isDestroyed.get() && !Thread.currentThread().isInterrupted()) {
                localRecorder = recorder;
                try {
                    if (localRecorder == null) break;

                    int result = localRecorder.read(short_buffer, 0, short_buffer.length);
                    if (result < 0) {
                        Log.d(TAG, "Error reading from AudioRecord"); //: " + getBufferReadFailureReason(result));
                        break;
                    }

                    // Callback
                    b_buffer.order(ByteOrder.LITTLE_ENDIAN);
                    b_buffer.asShortBuffer().put(short_buffer);
                    if (!isDestroyed.get() && mChunkCallback != null) {
                        mChunkCallback.onSuccess(b_buffer);
                    }
                    b_buffer.clear();

                    // --- PCM -> LC3 encode, with carryover buffering ---

                    byte[] newPcmBytes = new byte[result * 2];
                    ByteBuffer.wrap(newPcmBytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(short_buffer, 0, result);
                    remainderBuffer.write(newPcmBytes);

                    byte[] fullBuffer = remainderBuffer.toByteArray();
                    int fullLength = fullBuffer.length;
                    int frameCount = fullLength / BYTES_PER_FRAME;

                    for (int i = 0; i < frameCount; i++) {
                        int offset = i * BYTES_PER_FRAME;
                        byte[] frameBytes = Arrays.copyOfRange(fullBuffer, offset, offset + BYTES_PER_FRAME);

                        // Encode → Decode → Write result as PCM
                        byte[] lc3Data = L3cCpp.encodeLC3(encoderPtr, frameBytes);

                        for (int j = 0; j < lc3Data.length; j += 20) {
                            byte[] oneFrame = Arrays.copyOfRange(lc3Data, j, j + 20);
                            byte[] pcm = L3cCpp.decodeLC3(decoderPtr, oneFrame);
//                            writeToPcmFile(pcm);
//                            writeToPcmFile(oneFrame);
                        }
                    }

                    int leftoverBytes = fullLength % BYTES_PER_FRAME;
                    remainderBuffer.reset();
                    if (leftoverBytes > 0) {
                        remainderBuffer.write(fullBuffer, fullLength - leftoverBytes, leftoverBytes);
                    }

                    Thread.sleep(5);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    Log.d(TAG, "Recording thread interrupted");
                    break;
                } catch (Exception e) {
                    Log.e(TAG, "Error in recording thread", e);
                    break;
                }
            }

            if (encoderPtr != 0) {
                L3cCpp.freeEncoder(encoderPtr);
                encoderPtr = 0;
            }
            if (decoderPtr != 0) {
                L3cCpp.freeDecoder(decoderPtr);
                decoderPtr = 0;
            }

            Log.d(TAG, "Recording thread exiting");
        }
    }

    enum BluetoothState {
        AVAILABLE, UNAVAILABLE
    }

    public synchronized void destroy() {
        Log.d(TAG, "Destroying local microphone...");

        // If already destroyed, exit early
        if (isDestroyed.get()) {
            Log.d(TAG, "Already destroyed, skipping");
            return;
        }

        // Set the destroyed flag first to prevent any new operations
        isDestroyed.set(true);

        // Stop the dedicated microphone service
        stopMicrophoneService(mContext);

        // Cancel the countdown timer
        if (mCountDown != null) {
            mIsCountDownOn = false;
            mCountDown.cancel();
            mCountDown = null;
        }

        // Stop recording
        stopRecording();

        // Clean up Bluetooth SCO
        try {
            deactivateBluetoothSco();
            if (audioManager != null) {
                audioManager.setMode(AudioManager.MODE_NORMAL);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error cleaning up Bluetooth SCO", e);
        }

        // Unregister the receiver
        if (mContext != null && isReceiverRegistered) {
            try {
                mContext.unregisterReceiver(bluetoothStateReceiver);
                isReceiverRegistered = false;
                Log.d(TAG, "Bluetooth state receiver unregistered in destroy()");
            } catch (IllegalArgumentException e) {
                Log.e(TAG, "Error unregistering receiver", e);
            }
        }

        // Clear references
        Context localContext = mContext; // Store temporarily to stop service
        mContext = null;
        mChunkCallback = null;
        mHandler = null;
        audioManager = null;

        Log.d(TAG, "MicrophoneLocalAndBluetooth fully destroyed");
    }
}
package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.vad;

import static androidx.core.content.ContentProviderCompat.requireContext;

import android.content.Context;
import android.util.Log;

import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.SpeechDetectionPolicy;
import com.konovalov.vad.silero.VadSilero;
import com.konovalov.vad.silero.Vad;
import com.konovalov.vad.silero.config.FrameSize;
import com.konovalov.vad.silero.config.Mode;
import com.konovalov.vad.silero.config.SampleRate;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

public class VadGateSpeechPolicy implements SpeechDetectionPolicy {
    public final String TAG = "WearLLM_VadGateService";
    private Context mContext;
    private VadSilero vad;
    private boolean isCurrentlySpeech;
    private boolean bypassVadForDebugging;

    // Total required silence duration of 12 seconds.
    private static final long REQUIRED_SILENCE_DURATION_MS = 8000;
    // Dynamic VAD check intervals
    private static final long INITIAL_SILENCE_VAD_INTERVAL_MS = 50;    // Check frequently at first
    private static final long MEDIUM_SILENCE_VAD_INTERVAL_MS = 100;    // Medium frequency after some time
    private static final long LONG_SILENCE_VAD_INTERVAL_MS = 200;      // Less frequent after extended silence
    
    // Thresholds for switching intervals
    private static final long MEDIUM_SILENCE_THRESHOLD_MS = 20000;       // Switch to medium interval after 10s
    private static final long LONG_SILENCE_THRESHOLD_MS = 60000;        // Switch to long interval after 20s

    // Timestamp of the last detected speech.
    private long lastSpeechDetectedTime = 0;
    // Throttle timer for silence VAD checks.
    private long lastVadCheckTime = 0;

    public VadGateSpeechPolicy(Context context){
        mContext = context;
        isCurrentlySpeech = false;
    }

    public void startVad(){
        // Set internal silence duration very low; external logic now manages the full required silence duration.
        vad = Vad.builder()
                .setContext(mContext)
                .setSampleRate(SampleRate.SAMPLE_RATE_16K)
                .setFrameSize(FrameSize.FRAME_SIZE_512)
                .setMode(Mode.NORMAL)
                .setSilenceDurationMs(50)
                .setSpeechDurationMs(50)
                .build();

        Log.d(TAG, "VAD init'ed.");
    }

    @Override
    public boolean shouldPassAudioToRecognizer() {
        return bypassVadForDebugging || isCurrentlySpeech;
    }

    @Override
    public void init(int blockSizeSamples) {
        startVad();
    }

    @Override
    public void reset() {}

    public short[] bytesToShort(byte[] bytes) {
        short[] shorts = new short[bytes.length / 2];
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts);
        return shorts;
    }

    @Override
    public void processAudioBytes(byte[] bytes, int offset, int length) {
        long now = System.currentTimeMillis();

        // If in speech state and it hasn't been 12 seconds since the last speech was detected, skip processing.
        if (isCurrentlySpeech && (now - lastSpeechDetectedTime < REQUIRED_SILENCE_DURATION_MS)) {
            return;
        }

        // Calculate silence duration
        long silenceDuration = now - lastSpeechDetectedTime;
        
        // Determine which VAD interval to use based on silence duration
        long currentVadInterval;
        if (silenceDuration < MEDIUM_SILENCE_THRESHOLD_MS) {
            currentVadInterval = INITIAL_SILENCE_VAD_INTERVAL_MS;
        } else if (silenceDuration < LONG_SILENCE_THRESHOLD_MS) {
            currentVadInterval = MEDIUM_SILENCE_VAD_INTERVAL_MS;
        } else {
            currentVadInterval = LONG_SILENCE_VAD_INTERVAL_MS;
        }

        // During silence, throttle VAD checks based on the dynamic interval
        if (!isCurrentlySpeech && (now - lastVadCheckTime < currentVadInterval)) {
            return;
        }
        lastVadCheckTime = now;

        short[] audioBytesFull = bytesToShort(bytes);
        int totalSamples = audioBytesFull.length;
        int frameSize = 512;

        if (totalSamples % frameSize != 0) {
            Log.e(TAG, "Invalid audio frame size: " + totalSamples + " samples. Needs to be multiple of 512.");
            return;
        }

        boolean previousSpeechState = isCurrentlySpeech;

        // Process each 512-sample frame
        for (int i = 0; i < totalSamples / frameSize; i++) {
            now = System.currentTimeMillis();
            int startIdx = i * frameSize;
            short[] audioFrame = Arrays.copyOfRange(audioBytesFull, startIdx, startIdx + frameSize);
            boolean detectedSpeech = vad.isSpeech(audioFrame);

            if (detectedSpeech) {
                isCurrentlySpeech = true;
                // Update the last speech detection timestamp.
                lastSpeechDetectedTime = now;
            } else {
                // If no speech detected, and 12 seconds have elapsed since the last speech, mark as silence.
                if (now - lastSpeechDetectedTime >= REQUIRED_SILENCE_DURATION_MS) {
                    isCurrentlySpeech = false;
                }
            }

            if (isCurrentlySpeech != previousSpeechState) {
                Log.d(TAG, "Speech detection changed to: " + (isCurrentlySpeech ? "SPEECH" : "SILENCE"));
                previousSpeechState = isCurrentlySpeech;
            }
        }
    }

    @Override
    public void stop() {
        vad.close();
    }

    public void changeBypassVadForDebugging(boolean bypassVadForDebugging) {
        this.bypassVadForDebugging = bypassVadForDebugging;
    }

    public void microphoneStateChanged(boolean state) {
        if (!state) {
            // Microphone turned off: force immediate silence.
            isCurrentlySpeech = false;
            lastSpeechDetectedTime = 0;
            lastVadCheckTime = 0;

            // Optionally flush the VAD's internal state by processing a silent frame.
            short[] silentFrame = new short[512];
            vad.isSpeech(silentFrame);
            Log.d(TAG, "Microphone turned off; forced state to SILENCE.");
        }
    }
}


package com.mentra.asg_client.sensors;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Power-optimized IMU manager for Mentra Live glasses.
 * Handles sensor data collection with minimal battery impact.
 * 
 * Power optimization strategies:
 * - Sensors are OFF by default
 * - Single readings use quick on/off (100ms)
 * - Gestures use accelerometer-only at low rate
 * - Auto-timeout for all continuous operations
 */
public class ImuManager implements SensorEventListener {
    private static final String TAG = "ImuManager";
    
    // Power optimization constants
    private static final int SINGLE_READING_TIMEOUT_MS = 100;
    private static final int GESTURE_SAMPLING_DELAY_US = 60000; // 16Hz for gestures
    private static final int STREAM_TIMEOUT_MS = 60000; // 60 second auto-timeout
    private static final int GESTURE_TIMEOUT_MS = 30000; // 30 second auto-timeout
    
    // Gesture detection thresholds (using accelerometer only)
    private static final float HEAD_UP_PITCH_THRESHOLD = 30.0f;
    private static final float HEAD_DOWN_PITCH_THRESHOLD = -30.0f;
    private static final float NOD_AMPLITUDE_THRESHOLD = 15.0f;
    private static final float SHAKE_AMPLITUDE_THRESHOLD = 0.3f; // g-force units
    private static final long GESTURE_WINDOW_MS = 2000; // Time window for nod/shake detection
    
    private final Context context;
    private final SensorManager sensorManager;
    private final Handler handler;
    
    // Sensors
    private Sensor accelerometer;
    private Sensor gyroscope;
    private Sensor magnetometer;
    private Sensor rotationVector;
    
    // Sensor state
    private boolean sensorsActive = false;
    private boolean isStreaming = false;
    private boolean gestureDetectionActive = false;
    
    // Latest sensor values
    private final float[] accelValues = new float[3];
    private final float[] gyroValues = new float[3];
    private final float[] magValues = new float[3];
    private final float[] quaternion = new float[4];
    private final float[] rotationMatrix = new float[9];
    private final float[] orientationAngles = new float[3];
    
    // Streaming configuration
    private int streamRateHz = 50;
    private long streamBatchMs = 0;
    private final List<JSONObject> streamBuffer = new ArrayList<>();
    private Runnable streamTimeoutRunnable;
    
    // Gesture detection
    private final Set<String> subscribedGestures = new HashSet<>();
    private Runnable gestureTimeoutRunnable;
    private final GestureDetector gestureDetector;
    
    // Callbacks
    private ImuDataCallback dataCallback;
    
    public interface ImuDataCallback {
        void onSingleReading(JSONObject data);
        void onStreamData(JSONObject data);
        void onGestureDetected(String gesture);
    }
    
    public ImuManager(Context context) {
        this.context = context.getApplicationContext();
        this.handler = new Handler(Looper.getMainLooper());
        this.sensorManager = (SensorManager) this.context.getSystemService(Context.SENSOR_SERVICE);
        this.gestureDetector = new GestureDetector();
        
        initializeSensors();
    }
    
    private void initializeSensors() {
        accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        gyroscope = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        magnetometer = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        rotationVector = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        
        if (accelerometer == null) {
            Log.e(TAG, "Accelerometer not available on this device");
        }
    }
    
    public void setDataCallback(ImuDataCallback callback) {
        this.dataCallback = callback;
    }
    
    /**
     * Request a single IMU reading with minimal power usage
     */
    public void requestSingleReading() {
        Log.d(TAG, "Requesting single IMU reading");
        
        if (sensorsActive) {
            // If sensors already active, just send current values
            sendSingleReading();
            return;
        }
        
        // Quick sensor activation for single reading
        activateSensorsForSingleReading();
        
        // Schedule sensor deactivation after brief collection period
        handler.postDelayed(() -> {
            sendSingleReading();
            if (!isStreaming && !gestureDetectionActive) {
                deactivateSensors();
            }
        }, SINGLE_READING_TIMEOUT_MS);
    }
    
    /**
     * Start IMU streaming with auto-timeout
     */
    public void startStreaming(int rateHz, long batchMs) {
        Log.d(TAG, "Starting IMU stream at " + rateHz + "Hz, batch: " + batchMs + "ms");
        
        stopStreaming(); // Stop any existing stream
        
        this.streamRateHz = Math.min(100, Math.max(1, rateHz)); // Clamp 1-100Hz
        this.streamBatchMs = Math.min(1000, Math.max(0, batchMs)); // Max 1 second batching
        this.isStreaming = true;
        
        activateSensorsForStreaming();
        
        // Setup auto-timeout
        streamTimeoutRunnable = () -> {
            Log.w(TAG, "Stream auto-timeout after " + STREAM_TIMEOUT_MS + "ms");
            stopStreaming();
        };
        handler.postDelayed(streamTimeoutRunnable, STREAM_TIMEOUT_MS);
        
        // Start batch sending if configured
        if (streamBatchMs > 0) {
            startBatchSending();
        }
    }
    
    /**
     * Stop IMU streaming
     */
    public void stopStreaming() {
        Log.d(TAG, "Stopping IMU stream");
        
        isStreaming = false;
        
        if (streamTimeoutRunnable != null) {
            handler.removeCallbacks(streamTimeoutRunnable);
            streamTimeoutRunnable = null;
        }
        
        if (!gestureDetectionActive) {
            deactivateSensors();
        }
    }
    
    /**
     * Subscribe to gesture detection (power-optimized with accelerometer only)
     */
    public void subscribeToGestures(List<String> gestures) {
        Log.d(TAG, "Subscribing to gestures: " + gestures);
        
        subscribedGestures.clear();
        subscribedGestures.addAll(gestures);
        
        if (!gestures.isEmpty()) {
            gestureDetectionActive = true;
            activateSensorsForGestures();
            
            // Setup auto-timeout for gesture detection
            if (gestureTimeoutRunnable != null) {
                handler.removeCallbacks(gestureTimeoutRunnable);
            }
            gestureTimeoutRunnable = () -> {
                Log.w(TAG, "Gesture detection auto-timeout after " + GESTURE_TIMEOUT_MS + "ms");
                unsubscribeFromGestures();
            };
            handler.postDelayed(gestureTimeoutRunnable, GESTURE_TIMEOUT_MS);
        } else {
            unsubscribeFromGestures();
        }
    }
    
    /**
     * Unsubscribe from all gestures
     */
    public void unsubscribeFromGestures() {
        Log.d(TAG, "Unsubscribing from gestures");
        
        gestureDetectionActive = false;
        subscribedGestures.clear();
        
        if (gestureTimeoutRunnable != null) {
            handler.removeCallbacks(gestureTimeoutRunnable);
            gestureTimeoutRunnable = null;
        }
        
        if (!isStreaming) {
            deactivateSensors();
        }
    }
    
    private void activateSensorsForSingleReading() {
        if (!sensorsActive) {
            sensorsActive = true;
            // For single reading, activate all sensors briefly for complete data
            sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_FASTEST);
            if (gyroscope != null) {
                sensorManager.registerListener(this, gyroscope, SensorManager.SENSOR_DELAY_FASTEST);
            }
            if (magnetometer != null) {
                sensorManager.registerListener(this, magnetometer, SensorManager.SENSOR_DELAY_FASTEST);
            }
            if (rotationVector != null) {
                sensorManager.registerListener(this, rotationVector, SensorManager.SENSOR_DELAY_FASTEST);
            }
        }
    }
    
    private void activateSensorsForGestures() {
        if (!sensorsActive || isStreaming) {
            sensorsActive = true;
            // For gestures, use only accelerometer at low rate (power optimized)
            sensorManager.unregisterListener(this);
            sensorManager.registerListener(this, accelerometer, GESTURE_SAMPLING_DELAY_US);
        }
    }
    
    private void activateSensorsForStreaming() {
        sensorsActive = true;
        sensorManager.unregisterListener(this);
        
        // Calculate sampling period in microseconds
        int samplingPeriodUs = 1000000 / streamRateHz;
        
        // Register all sensors for streaming
        sensorManager.registerListener(this, accelerometer, samplingPeriodUs);
        if (gyroscope != null) {
            sensorManager.registerListener(this, gyroscope, samplingPeriodUs);
        }
        if (magnetometer != null) {
            sensorManager.registerListener(this, magnetometer, samplingPeriodUs);
        }
        if (rotationVector != null) {
            sensorManager.registerListener(this, rotationVector, samplingPeriodUs);
        }
    }
    
    private void deactivateSensors() {
        if (sensorsActive) {
            Log.d(TAG, "Deactivating sensors to save power");
            sensorsActive = false;
            sensorManager.unregisterListener(this);
        }
    }
    
    @Override
    public void onSensorChanged(SensorEvent event) {
        switch (event.sensor.getType()) {
            case Sensor.TYPE_ACCELEROMETER:
                System.arraycopy(event.values, 0, accelValues, 0, 3);
                
                // Process gestures if subscribed
                if (gestureDetectionActive) {
                    gestureDetector.processAccelerometer(accelValues);
                }
                break;
                
            case Sensor.TYPE_GYROSCOPE:
                System.arraycopy(event.values, 0, gyroValues, 0, 3);
                break;
                
            case Sensor.TYPE_MAGNETIC_FIELD:
                System.arraycopy(event.values, 0, magValues, 0, 3);
                break;
                
            case Sensor.TYPE_ROTATION_VECTOR:
                // Convert rotation vector to quaternion
                SensorManager.getQuaternionFromVector(quaternion, event.values);
                
                // Also calculate Euler angles
                SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values);
                SensorManager.getOrientation(rotationMatrix, orientationAngles);
                break;
        }
        
        // Handle streaming if active
        if (isStreaming && streamBatchMs == 0) {
            // Send immediately if no batching
            sendStreamData();
        }
    }
    
    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // Not needed for basic IMU functionality
    }
    
    private void sendSingleReading() {
        try {
            JSONObject data = new JSONObject();
            data.put("type", "imu_response");
            data.put("accel", new JSONArray(accelValues));
            data.put("gyro", new JSONArray(gyroValues));
            data.put("mag", new JSONArray(magValues));
            data.put("quat", new JSONArray(quaternion));
            
            // Convert Euler angles to degrees
            JSONArray euler = new JSONArray();
            euler.put(Math.toDegrees(orientationAngles[0])); // Roll
            euler.put(Math.toDegrees(orientationAngles[1])); // Pitch  
            euler.put(Math.toDegrees(orientationAngles[2])); // Yaw
            data.put("euler", euler);
            
            if (dataCallback != null) {
                dataCallback.onSingleReading(data);
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating single reading JSON", e);
        }
    }
    
    private void sendStreamData() {
        try {
            JSONObject reading = createImuReading();
            
            if (streamBatchMs > 0) {
                // Add to buffer for batching
                streamBuffer.add(reading);
            } else {
                // Send immediately
                JSONObject data = new JSONObject();
                data.put("type", "imu_stream_response");
                JSONArray readings = new JSONArray();
                readings.put(reading);
                data.put("readings", readings);
                
                if (dataCallback != null) {
                    dataCallback.onStreamData(data);
                }
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating stream data JSON", e);
        }
    }
    
    private void startBatchSending() {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (isStreaming) {
                    sendBatchedData();
                    handler.postDelayed(this, streamBatchMs);
                }
            }
        }, streamBatchMs);
    }
    
    private void sendBatchedData() {
        if (streamBuffer.isEmpty()) {
            return;
        }
        
        try {
            JSONObject data = new JSONObject();
            data.put("type", "imu_stream_response");
            data.put("readings", new JSONArray(streamBuffer));
            
            if (dataCallback != null) {
                dataCallback.onStreamData(data);
            }
            
            streamBuffer.clear();
        } catch (JSONException e) {
            Log.e(TAG, "Error sending batched data", e);
        }
    }
    
    private JSONObject createImuReading() throws JSONException {
        JSONObject reading = new JSONObject();
        reading.put("accel", new JSONArray(accelValues));
        reading.put("gyro", new JSONArray(gyroValues));
        reading.put("mag", new JSONArray(magValues));
        reading.put("quat", new JSONArray(quaternion));
        
        JSONArray euler = new JSONArray();
        euler.put(Math.toDegrees(orientationAngles[0]));
        euler.put(Math.toDegrees(orientationAngles[1]));
        euler.put(Math.toDegrees(orientationAngles[2]));
        reading.put("euler", euler);
        
        return reading;
    }
    
    /**
     * Inner class for gesture detection using accelerometer only (power optimized)
     */
    private class GestureDetector {
        private static final int HISTORY_SIZE = 30; // ~2 seconds at 16Hz
        private final List<Float> pitchHistory = new ArrayList<>();
        private final List<Float> rollHistory = new ArrayList<>();
        private final List<Float> xAccelHistory = new ArrayList<>();
        private long lastGestureTime = 0;
        
        void processAccelerometer(float[] accel) {
            // Calculate pitch and roll from accelerometer
            float pitch = (float) Math.toDegrees(Math.atan2(-accel[0], 
                Math.sqrt(accel[1] * accel[1] + accel[2] * accel[2])));
            float roll = (float) Math.toDegrees(Math.atan2(accel[1], accel[2]));
            
            // Add to history
            pitchHistory.add(pitch);
            rollHistory.add(roll);
            xAccelHistory.add(accel[0]);
            
            // Maintain history size
            if (pitchHistory.size() > HISTORY_SIZE) {
                pitchHistory.remove(0);
                rollHistory.remove(0);
                xAccelHistory.remove(0);
            }
            
            // Check for gestures
            long now = System.currentTimeMillis();
            if (now - lastGestureTime > 500) { // Debounce gestures
                checkForGestures(pitch);
                lastGestureTime = now;
            }
        }
        
        private void checkForGestures(float currentPitch) {
            // Head up/down detection (instantaneous)
            if (subscribedGestures.contains("head_up") && currentPitch > HEAD_UP_PITCH_THRESHOLD) {
                notifyGesture("head_up");
            } else if (subscribedGestures.contains("head_down") && currentPitch < HEAD_DOWN_PITCH_THRESHOLD) {
                notifyGesture("head_down");
            }
            
            // Nod detection (pitch oscillation)
            if (subscribedGestures.contains("nod_yes") && detectNod()) {
                notifyGesture("nod_yes");
            }
            
            // Shake detection (X-axis acceleration changes)
            if (subscribedGestures.contains("shake_no") && detectShake()) {
                notifyGesture("shake_no");
            }
        }
        
        private boolean detectNod() {
            if (pitchHistory.size() < 10) return false;
            
            // Look for pitch oscillation pattern
            float maxPitch = Float.MIN_VALUE;
            float minPitch = Float.MAX_VALUE;
            
            for (float pitch : pitchHistory) {
                maxPitch = Math.max(maxPitch, pitch);
                minPitch = Math.min(minPitch, pitch);
            }
            
            return (maxPitch - minPitch) > NOD_AMPLITUDE_THRESHOLD * 2;
        }
        
        private boolean detectShake() {
            if (xAccelHistory.size() < 10) return false;
            
            // Look for X-axis oscillation
            int directionChanges = 0;
            float prevAccel = xAccelHistory.get(0);
            
            for (int i = 1; i < xAccelHistory.size(); i++) {
                float accel = xAccelHistory.get(i);
                if (Math.signum(accel) != Math.signum(prevAccel) && 
                    Math.abs(accel) > SHAKE_AMPLITUDE_THRESHOLD) {
                    directionChanges++;
                }
                prevAccel = accel;
            }
            
            return directionChanges >= 3; // At least 3 direction changes for shake
        }
        
        private void notifyGesture(String gesture) {
            Log.d(TAG, "Gesture detected: " + gesture);
            
            // Reset timeout on gesture detection
            if (gestureTimeoutRunnable != null) {
                handler.removeCallbacks(gestureTimeoutRunnable);
                handler.postDelayed(gestureTimeoutRunnable, GESTURE_TIMEOUT_MS);
            }
            
            if (dataCallback != null) {
                dataCallback.onGestureDetected(gesture);
            }
        }
    }
    
    /**
     * Clean up resources
     */
    public void shutdown() {
        Log.d(TAG, "Shutting down ImuManager");
        stopStreaming();
        unsubscribeFromGestures();
        deactivateSensors();
    }
}
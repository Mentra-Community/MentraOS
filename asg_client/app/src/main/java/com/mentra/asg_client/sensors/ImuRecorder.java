package com.mentra.asg_client.sensors;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Records IMU (accelerometer + gyroscope) data during photo/video capture.
 * Writes a sidecar JSON file alongside the media file for phone-side
 * post-processing (e.g., gyro-based video stabilization).
 *
 * Sampling at ~100Hz, captures timestamp + accel[3] + gyro[3] per sample.
 */
public class ImuRecorder implements SensorEventListener {
  private static final String TAG = "ImuRecorder";
  private static final int SAMPLING_PERIOD_US = 10000; // 100Hz

  private final SensorManager mSensorManager;
  private final Sensor mAccelerometer;
  private final Sensor mGyroscope;

  private volatile boolean mRecording = false;
  private final List<ImuSample> mSamples = new ArrayList<>();
  private long mStartTimeNs = 0;

  // Latest values (updated independently by each sensor)
  private final float[] mLatestAccel = new float[3];
  private final float[] mLatestGyro = new float[3];

  private static class ImuSample {
    final long timestampNs;
    final float[] accel;
    final float[] gyro;

    ImuSample(long ts, float[] a, float[] g) {
      this.timestampNs = ts;
      this.accel = a.clone();
      this.gyro = g.clone();
    }
  }

  public ImuRecorder(Context context) {
    mSensorManager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
    mAccelerometer = mSensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    mGyroscope = mSensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);

    if (mAccelerometer == null) {
      Log.w(TAG, "Accelerometer not available");
    }
    if (mGyroscope == null) {
      Log.w(TAG, "Gyroscope not available");
    }
  }

  /**
   * Start recording IMU data. Call this when photo/video capture begins.
   */
  public void startRecording() {
    if (mRecording) {
      Log.w(TAG, "Already recording");
      return;
    }

    synchronized (mSamples) {
      mSamples.clear();
    }
    mStartTimeNs = System.nanoTime();
    mRecording = true;

    if (mAccelerometer != null) {
      mSensorManager.registerListener(this, mAccelerometer, SAMPLING_PERIOD_US);
    }
    if (mGyroscope != null) {
      mSensorManager.registerListener(this, mGyroscope, SAMPLING_PERIOD_US);
    }

    Log.d(TAG, "IMU recording started");
  }

  /**
   * Stop recording and write the sidecar JSON file.
   * @param mediaFilePath Path to the media file (e.g., IMG_xxx.jpg or VID_xxx.mp4)
   * @return Path to the sidecar JSON file, or null on failure
   */
  public String stopRecordingAndSave(String mediaFilePath) {
    mRecording = false;
    mSensorManager.unregisterListener(this);

    List<ImuSample> captured;
    synchronized (mSamples) {
      captured = new ArrayList<>(mSamples);
      mSamples.clear();
    }

    if (captured.isEmpty()) {
      Log.w(TAG, "No IMU samples captured");
      return null;
    }

    // Generate sidecar path: save imu.json inside the capture folder
    File parentDir = new File(mediaFilePath).getParentFile();
    String sidecarPath = new File(parentDir, "imu.json").getAbsolutePath();

    try {
      JSONObject root = new JSONObject();
      root.put("version", 1);
      root.put("sampleCount", captured.size());
      root.put("samplingRateHz", 100);
      root.put("startTimeNs", mStartTimeNs);
      root.put("durationMs", (captured.get(captured.size() - 1).timestampNs - mStartTimeNs) / 1_000_000);

      JSONArray samples = new JSONArray();
      for (ImuSample s : captured) {
        JSONArray sample = new JSONArray();
        // Compact format: [relativeTimeMs, ax, ay, az, gx, gy, gz]
        sample.put(Math.round((s.timestampNs - mStartTimeNs) / 1_000_000.0));
        sample.put(round4(s.accel[0]));
        sample.put(round4(s.accel[1]));
        sample.put(round4(s.accel[2]));
        sample.put(round4(s.gyro[0]));
        sample.put(round4(s.gyro[1]));
        sample.put(round4(s.gyro[2]));
        samples.put(sample);
      }
      root.put("samples", samples);

      File sidecarFile = new File(sidecarPath);
      try (FileWriter writer = new FileWriter(sidecarFile)) {
        writer.write(root.toString());
      }

      Log.d(TAG, "IMU sidecar written: " + sidecarPath + " (" + captured.size() + " samples)");
      return sidecarPath;

    } catch (JSONException | IOException e) {
      Log.e(TAG, "Failed to write IMU sidecar", e);
      return null;
    }
  }

  /** Cancel recording without saving. */
  public void cancel() {
    mRecording = false;
    mSensorManager.unregisterListener(this);
    synchronized (mSamples) {
      mSamples.clear();
    }
  }

  @Override
  public void onSensorChanged(SensorEvent event) {
    if (!mRecording) return;

    switch (event.sensor.getType()) {
      case Sensor.TYPE_ACCELEROMETER:
        System.arraycopy(event.values, 0, mLatestAccel, 0, 3);
        // Record a combined sample on each accel event (accel drives the sampling rate)
        synchronized (mSamples) {
          mSamples.add(new ImuSample(event.timestamp, mLatestAccel, mLatestGyro));
        }
        break;
      case Sensor.TYPE_GYROSCOPE:
        System.arraycopy(event.values, 0, mLatestGyro, 0, 3);
        break;
    }
  }

  @Override
  public void onAccuracyChanged(Sensor sensor, int accuracy) {
    // Not needed
  }

  private static double round4(float v) {
    return Math.round(v * 10000.0) / 10000.0;
  }
}

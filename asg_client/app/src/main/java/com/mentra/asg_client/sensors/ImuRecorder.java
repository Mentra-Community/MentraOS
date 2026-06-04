package com.mentra.asg_client.sensors;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;

/**
 * Records IMU (accelerometer + gyroscope) data during photo/video capture. Writes a sidecar JSON
 * file alongside the media file for phone-side post-processing (e.g., gyro-based video
 * stabilization).
 *
 * <p>Sampling at ~100Hz, captures timestamp + accel[3] + gyro[3] per sample.
 *
 * <h3>Threading</h3>
 * Sensor callbacks are delivered on a dedicated {@link HandlerThread} owned by this recorder, NOT
 * the thread that calls {@link #startRecording(String)}. This matters: the camera pipeline calls
 * {@code startRecording()} from a background {@code HandlerThread} that has a Looper but never
 * pumps sensor events, and the no-Handler {@code registerListener} overload posts to the
 * <em>main</em> looper. Registering against our own handler guarantees delivery regardless of the
 * caller's thread (the previous code silently captured zero samples on longer video recordings —
 * registration succeeded but no {@code onSensorChanged} ever fired).
 *
 * <h3>Streaming</h3>
 * Samples are streamed to a {@code imu.jsonl.partial} file as they arrive rather than buffered in
 * memory, bounding memory use on long recordings. At graceful stop the partial is assembled into the
 * canonical {@code imu.json} object and removed. If assembly fails on an otherwise-successful stop
 * the partial is retained (it is the only copy of the IMU data and the media file survives), so it
 * can be recovered/retried; {@code .partial} files are excluded from gallery/Wi-Fi sync. On a
 * capture failure or {@link #cancel()} the partial is deleted — there the camera pipeline wipes the
 * whole capture directory, so there is no surviving media for a sidecar to belong to.
 *
 * <h3>Photo EXIF path</h3>
 * Photo capture additionally needs the assembled payload in memory (to embed a trimmed copy into
 * the JPEG's EXIF UserComment) before the sidecar is written. {@link #stopRecordingAndBuildPayload()}
 * stops the stream and returns the assembled {@link JSONObject}; {@link #writeSidecar(String,
 * JSONObject)} then persists it next to the media file. Video capture uses the simpler
 * {@link #stopRecordingAndSave(String)} which assembles and writes in one step.
 */
public class ImuRecorder implements SensorEventListener {
  private static final String TAG = "ImuRecorder";
  private static final int SAMPLING_PERIOD_US = 10000; // 100Hz
  private static final String PARTIAL_NAME = "imu.jsonl.partial";
  private static final String SIDECAR_NAME = "imu.json";

  private final SensorManager mSensorManager;
  private final Sensor mAccelerometer;
  private final Sensor mGyroscope;

  // Dedicated thread so sensor callbacks are delivered independently of the caller's thread.
  private final HandlerThread mSensorThread;
  private final Handler mSensorHandler;

  private volatile boolean mRecording = false;
  // Baseline for the zero-based relative sample times in the JSON. Set lazily from the FIRST sensor
  // event's timestamp so the math stays within a single clock domain — SensorEvent.timestamp is
  // elapsedRealtimeNanos (time since boot), NOT System.nanoTime(); mixing them previously produced a
  // bogus multi-hundred-second durationMs and a large constant per-sample offset. -1 = unset.
  private long mBaseTimestampNs = -1;
  // Absolute capture anchor in the elapsedRealtimeNanos clock, captured at startRecording(). This is
  // the SAME clock Android's camera2 reports in SENSOR_TIMESTAMP when SENSOR_INFO_TIMESTAMP_SOURCE is
  // REALTIME. Recording it lets the phone correlate IMU samples to video frames to sub-ms once the
  // MTK HAL advertises REALTIME frame timestamps. Today the camera reports UNKNOWN, so this is the
  // forward-compatible anchor — the IMU side is already on the correct clock and needs no rework.
  private long mStartElapsedRealtimeNs = 0;
  // Absolute elapsedRealtimeNanos captured by the video pipeline right after MediaRecorder.start(),
  // i.e. the wall-clock anchor for the video timeline on the SAME clock as the IMU samples. The MP4
  // itself only carries relative PTS, so this is what lets the consumer place frame N at
  // videoStart + PTS_N and subtract the fixed camera/IMU startup offset (the ~100ms the data partner
  // measured). It is recorder-start, not per-frame start-of-exposure, so it removes the constant
  // offset but is not a sub-ms hardware sync. 0 = not set (e.g. photo captures, which have no video).
  private long mVideoStartElapsedRealtimeNs = 0;

  // Latest values (updated independently by each sensor). Touched only on the sensor thread.
  private final float[] mLatestAccel = new float[3];
  private final float[] mLatestGyro = new float[3];

  // Streaming sink for the in-progress capture. Touched only on the sensor thread.
  private BufferedWriter mStreamWriter;
  private File mPartialFile;

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

    mSensorThread = new HandlerThread("ImuRecorder");
    mSensorThread.start();
    mSensorHandler = new Handler(mSensorThread.getLooper());
  }

  /**
   * Start recording IMU data. Call this when photo/video capture begins.
   *
   * @param mediaFilePath Path to the media file being captured; the sidecar is written next to it.
   *     The parent directory must already exist (the media file lives there).
   */
  public void startRecording(String mediaFilePath) {
    if (mRecording) {
      Log.w(TAG, "Already recording");
      return;
    }

    File parentDir = new File(mediaFilePath).getParentFile();
    if (parentDir == null) {
      Log.w(TAG, "Cannot resolve capture directory for " + mediaFilePath + "; IMU not recorded");
      return;
    }

    mPartialFile = new File(parentDir, PARTIAL_NAME);
    mBaseTimestampNs = -1; // baselined off the first event below
    mStartElapsedRealtimeNs = SystemClock.elapsedRealtimeNanos();
    mVideoStartElapsedRealtimeNs = 0; // set by the video pipeline via setVideoStartAnchor()

    try {
      mStreamWriter = new BufferedWriter(new FileWriter(mPartialFile, false));
    } catch (IOException e) {
      Log.e(TAG, "Failed to open IMU stream file", e);
      mStreamWriter = null;
      // FileWriter may have created a zero-byte file before failing; don't leave it behind.
      if (mPartialFile.exists()) {
        mPartialFile.delete();
      }
      mPartialFile = null;
      return;
    }

    mRecording = true;

    if (mAccelerometer != null) {
      mSensorManager.registerListener(this, mAccelerometer, SAMPLING_PERIOD_US, mSensorHandler);
    }
    if (mGyroscope != null) {
      mSensorManager.registerListener(this, mGyroscope, SAMPLING_PERIOD_US, mSensorHandler);
    }

    Log.d(TAG, "IMU recording started (streaming to " + mPartialFile.getAbsolutePath() + ")");
  }

  /**
   * Record the video timeline's absolute anchor on the elapsedRealtimeNanos clock. Call from the
   * video pipeline immediately after {@code MediaRecorder.start()}, passing
   * {@code SystemClock.elapsedRealtimeNanos()}. Written to the sidecar as
   * {@code videoStartElapsedRealtimeNs} so the consumer can align frame N (relative PTS) to IMU
   * samples and subtract the fixed camera/IMU startup offset. No-op for photo captures.
   */
  public void setVideoStartAnchor(long elapsedRealtimeNs) {
    mVideoStartElapsedRealtimeNs = elapsedRealtimeNs;
  }

  /**
   * Stop recording and assemble the sidecar JSON file from the streamed samples.
   *
   * @param mediaFilePath Path to the media file (e.g., IMG_xxx.jpg or VID_xxx.mp4)
   * @return Path to the sidecar JSON file, or null on failure
   */
  public String stopRecordingAndSave(String mediaFilePath) {
    File partial = stopAndQuiesce();
    if (partial == null) {
      Log.w(TAG, "No IMU samples captured");
      return null;
    }

    // Sidecar lands next to the media file; the partial lives in the same dir but use the stored
    // reference for it so stop and cancel always agree on the path.
    File parentDir = new File(mediaFilePath).getParentFile();
    String sidecarPath = new File(parentDir, SIDECAR_NAME).getAbsolutePath();
    try {
      JSONObject payload = buildPayloadFromPartial(partial);
      if (payload == null || payload.optInt("sampleCount", 0) == 0) {
        Log.w(TAG, "No IMU samples captured");
        partial.delete();
        return null;
      }
      try (FileWriter writer = new FileWriter(sidecarPath)) {
        writer.write(payload.toString());
      }
      int written = payload.optInt("sampleCount", 0);
      partial.delete();
      Log.d(TAG, "IMU sidecar written: " + sidecarPath + " (" + written + " samples)");
      return sidecarPath;
    } catch (JSONException | IOException e) {
      // Retain the partial. On a graceful stop the media file survives even when sidecar
      // assembly fails (this method swallows the error rather than propagating it, so the camera
      // pipeline does NOT wipe the directory), so the partial is the only copy of the IMU data —
      // keep it for recovery/retry. It is excluded from gallery/Wi-Fi sync by the .partial filter
      // in FileManagerImpl, so retaining it can't leak a bogus capture file. The cancel() path
      // (used on capture failure, where the directory IS wiped) still deletes it.
      Log.e(TAG, "Failed to assemble IMU sidecar; retaining partial at " + partial.getAbsolutePath(), e);
      return null;
    }
  }

  /**
   * Stop recording and build the IMU payload JSON in memory (same schema as the sidecar file).
   *
   * <p>Used by the photo pipeline, which embeds a trimmed copy of the payload into the JPEG's EXIF
   * UserComment before persisting the full sidecar via {@link #writeSidecar(String, JSONObject)}.
   * The streamed partial is deleted once the payload has been assembled; if assembly fails the
   * partial is retained for recovery (it is then the only copy of the IMU data).
   *
   * @return IMU payload JSON, or null when no samples were captured or assembly fails
   */
  @Nullable
  public JSONObject stopRecordingAndBuildPayload() {
    File partial = stopAndQuiesce();
    if (partial == null) {
      Log.w(TAG, "No IMU samples captured");
      return null;
    }
    try {
      JSONObject payload = buildPayloadFromPartial(partial);
      if (payload == null || payload.optInt("sampleCount", 0) == 0) {
        Log.w(TAG, "No IMU samples captured");
        partial.delete();
        return null;
      }
      partial.delete();
      return payload;
    } catch (JSONException | IOException e) {
      Log.e(TAG, "Failed to assemble IMU payload; retaining partial at " + partial.getAbsolutePath(), e);
      return null;
    }
  }

  /**
   * Write the {@code imu.json} sidecar next to the media file using an already-assembled payload.
   * Used by the photo pipeline after {@link #stopRecordingAndBuildPayload()}.
   *
   * @return Path to the sidecar JSON file, or null on failure
   */
  @Nullable
  public String writeSidecar(String mediaFilePath, JSONObject payload) {
    File parentDir = new File(mediaFilePath).getParentFile();
    if (parentDir == null) {
      Log.e(TAG, "Cannot resolve parent dir for sidecar: " + mediaFilePath);
      return null;
    }
    String sidecarPath = new File(parentDir, SIDECAR_NAME).getAbsolutePath();
    try (FileWriter writer = new FileWriter(sidecarPath)) {
      writer.write(payload.toString());
      Log.d(
          TAG,
          "IMU sidecar written: "
              + sidecarPath
              + " ("
              + payload.optInt("sampleCount", 0)
              + " samples)");
      return sidecarPath;
    } catch (IOException e) {
      Log.e(TAG, "Failed to write IMU sidecar", e);
      return null;
    }
  }

  /**
   * Stop sensor delivery, quiesce the stream sink, and return the streamed partial file (or null
   * when nothing was captured). Shared entry point for both the video and photo stop paths.
   */
  @Nullable
  private File stopAndQuiesce() {
    mRecording = false;
    mSensorManager.unregisterListener(this);
    // Flush + close the stream on the sensor thread so it can't race with a late onSensorChanged,
    // then continue assembly on the caller's thread once the sink is quiesced.
    flushAndCloseStreamSync();

    File partial = mPartialFile;
    if (partial == null || !partial.exists()) {
      return null;
    }
    return partial;
  }

  /** Stop sensor delivery and close the stream, leaving the partial file untouched. */
  private void stopSensors() {
    mRecording = false;
    mSensorManager.unregisterListener(this);
    flushAndCloseStreamSync();
  }

  /** Cancel recording without saving; discards the partial stream. */
  public void cancel() {
    stopSensors();
    if (mPartialFile != null && mPartialFile.exists()) {
      mPartialFile.delete();
    }
  }

  /**
   * Release the sensor thread. Call when the recorder is no longer needed. Stops sensor delivery but
   * does NOT delete a retained partial: a graceful stop whose imu.json assembly failed keeps the
   * partial as the only copy of the IMU data, and the camera service calls release() on teardown
   * shortly after every recording — deleting here would destroy that recovery copy.
   */
  public void release() {
    stopSensors();
    mSensorThread.quitSafely();
  }

  @Override
  public void onSensorChanged(SensorEvent event) {
    // Runs on mSensorThread.
    if (!mRecording) return;

    switch (event.sensor.getType()) {
      case Sensor.TYPE_ACCELEROMETER:
        System.arraycopy(event.values, 0, mLatestAccel, 0, 3);
        // Accel drives the sampling rate: emit one combined sample per accel event.
        writeSampleLine(event.timestamp);
        break;
      case Sensor.TYPE_GYROSCOPE:
        System.arraycopy(event.values, 0, mLatestGyro, 0, 3);
        break;
      default:
        break;
    }
  }

  @Override
  public void onAccuracyChanged(Sensor sensor, int accuracy) {
    // Not needed
  }

  /** Append one compact sample line: [relativeTimeMs, ax, ay, az, gx, gy, gz]. Sensor thread only. */
  private void writeSampleLine(long timestampNs) {
    if (mStreamWriter == null) return;
    if (mBaseTimestampNs < 0) {
      // First event seen: this becomes t=0 so relative times start at ~0 within the event clock.
      mBaseTimestampNs = timestampNs;
    }
    try {
      JSONArray sample = new JSONArray();
      sample.put(Math.round((timestampNs - mBaseTimestampNs) / 1_000_000.0));
      sample.put(round4(mLatestAccel[0]));
      sample.put(round4(mLatestAccel[1]));
      sample.put(round4(mLatestAccel[2]));
      sample.put(round4(mLatestGyro[0]));
      sample.put(round4(mLatestGyro[1]));
      sample.put(round4(mLatestGyro[2]));
      mStreamWriter.write(sample.toString());
      mStreamWriter.write('\n');
    } catch (IOException | JSONException e) {
      Log.e(TAG, "Failed to write IMU sample", e);
    }
  }

  /** Quiesce the sensor sink: run flush+close on the sensor thread and block until done. */
  private void flushAndCloseStreamSync() {
    final Object lock = new Object();
    final boolean[] done = {false};
    boolean posted = mSensorHandler.post(() -> {
      closeStreamOnSensorThread();
      synchronized (lock) {
        done[0] = true;
        lock.notifyAll();
      }
    });
    if (!posted) {
      // Looper already gone; close inline as a best effort.
      closeStreamOnSensorThread();
      return;
    }
    synchronized (lock) {
      while (!done[0]) {
        try {
          lock.wait();
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          return;
        }
      }
    }
  }

  private void closeStreamOnSensorThread() {
    if (mStreamWriter == null) return;
    try {
      mStreamWriter.flush();
      mStreamWriter.close();
    } catch (IOException e) {
      Log.e(TAG, "Failed to close IMU stream", e);
    } finally {
      mStreamWriter = null;
    }
  }

  /**
   * Read the streamed JSONL partial and build the canonical {@code imu.json} object. Keeps the
   * exact same on-disk schema the previous in-memory implementation produced. Returns null when the
   * partial holds no samples.
   */
  @Nullable
  private JSONObject buildPayloadFromPartial(File partial) throws IOException, JSONException {
    JSONArray samples = new JSONArray();
    long lastRelMs = 0;
    try (BufferedReader reader = new BufferedReader(new FileReader(partial))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (line.isEmpty()) continue;
        JSONArray sample = new JSONArray(line);
        lastRelMs = sample.getLong(0);
        samples.put(sample);
      }
    }

    if (samples.length() == 0) {
      return null;
    }

    JSONObject root = new JSONObject();
    root.put("version", 2);
    root.put("sampleCount", samples.length());
    root.put("samplingRateHz", 100);
    // clockSource documents the time base of the absolute timestamps below: Android's
    // elapsedRealtimeNanos (boot-monotonic). This is the clock camera2 SENSOR_TIMESTAMP uses when
    // the camera advertises SENSOR_INFO_TIMESTAMP_SOURCE = REALTIME, enabling IMU↔video correlation.
    root.put("clockSource", "elapsedRealtimeNanos");
    // Absolute elapsedRealtimeNanos of each sample's relative t=0 (the first sensor event).
    // sampleAbsoluteNs = startTimeNs + relativeMs * 1_000_000.
    root.put("startTimeNs", mBaseTimestampNs);
    // Absolute elapsedRealtimeNanos captured at startRecording() (≈ MediaRecorder.start()), before
    // the first sensor event arrived. Lets the consumer bound the IMU window against video start.
    root.put("recordingStartElapsedRealtimeNs", mStartElapsedRealtimeNs);
    // Absolute elapsedRealtimeNanos anchor for the video timeline (recorder start). Present only for
    // video captures. Frame N's absolute time ≈ videoStartElapsedRealtimeNs + framePtsNs; align that
    // against the IMU samples (same clock) to remove the fixed camera/IMU startup offset. Omitted
    // when 0 (e.g. photo captures, or if the video pipeline did not set it).
    if (mVideoStartElapsedRealtimeNs > 0) {
      root.put("videoStartElapsedRealtimeNs", mVideoStartElapsedRealtimeNs);
    }
    root.put("durationMs", lastRelMs);
    root.put("samples", samples);
    return root;
  }

  private static double round4(float v) {
    return Math.round(v * 10000.0) / 10000.0;
  }
}

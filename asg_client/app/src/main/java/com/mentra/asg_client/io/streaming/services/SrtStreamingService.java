package com.mentra.asg_client.io.streaming.services;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.media.AudioFormat;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.util.Size;
import android.view.Surface;

import java.util.Timer;
import java.util.TimerTask;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresPermission;
import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.camera.CameraNeo;
import com.mentra.asg_client.utils.WakeLockManager;
import com.mentra.asg_client.reporting.domains.StreamingReporting;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.streaming.config.RtmpStreamConfig;
import com.mentra.asg_client.io.streaming.events.StreamingCommand;
import com.mentra.asg_client.io.streaming.events.StreamingEvent;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.audio.AudioAssets;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

import io.github.thibaultbee.streampack.data.AudioConfig;
import io.github.thibaultbee.streampack.data.VideoConfig;
import io.github.thibaultbee.streampack.error.StreamPackError;
import io.github.thibaultbee.streampack.internal.muxers.ts.data.TsServiceInfo;
import io.github.thibaultbee.streampack.ext.srt.streamers.CameraSrtLiveStreamer;
import io.github.thibaultbee.streampack.listeners.OnConnectionListener;
import io.github.thibaultbee.streampack.listeners.OnErrorListener;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;

@SuppressLint("MissingPermission")
public class SrtStreamingService extends Service {
  private static final String TAG = "SrtStreamingService";
  private static final String CHANNEL_ID = "SrtStreamingChannel";
  private static final int NOTIFICATION_ID = 8889;

  private static SrtStreamingService sInstance;
  private static StreamingStatusCallback sStatusCallback;

  private final IBinder mBinder = new LocalBinder();
  private CameraSrtLiveStreamer mSrtStreamer;
  private CameraSrtLiveStreamer mLastSrtStreamerForCleanup;

  private String mSrtUrl;
  private boolean mIsStreaming = false;
  private SurfaceTexture mSurfaceTexture;
  private Surface mSurface;

  private RtmpStreamConfig mStreamConfig = new RtmpStreamConfig();
  private static RtmpStreamConfig sPendingStreamConfig = null;

  private int mReconnectAttempts = 0;
  private static final int MAX_RECONNECT_ATTEMPTS = 10;
  private static final long INITIAL_RECONNECT_DELAY_MS = 1000;
  private static final float BACKOFF_MULTIPLIER = 1.5f;
  private Handler mReconnectHandler;
  private boolean mReconnecting = false;

  private int mConsecutiveFailures = 0;
  private static final int MIN_CONSECUTIVE_FAILURES = 3;
  private long mLastFailureTime = 0;
  private int mTotalFailures = 0;

  private Timer mStreamTimeoutTimer;
  private String mCurrentStreamId;
  private boolean mIsStreamingActive = false;
  private static final long STREAM_TIMEOUT_MS = 60000;
  private Handler mTimeoutHandler;

  private boolean mHasShownReconnectingNotification = false;

  private enum StreamState { IDLE, STARTING, STREAMING, STOPPING }
  private volatile StreamState mStreamState = StreamState.IDLE;
  private final Object mStateLock = new Object();

  private long mStreamStartTime = 0;
  private long mLastReconnectionTime = 0;
  private int mReconnectionSequence = 0;

  private IHardwareManager mHardwareManager;
  private boolean mLedEnabled = false;
  private boolean mSoundEnabled = false;

  private IStateManager mStateManager;
  private static IStateManager sPendingStateManager = null;
  private Handler mBatteryMonitorHandler = null;
  private Runnable mBatteryCheckRunnable = null;

  public class LocalBinder extends Binder {
    public SrtStreamingService getService() {
      return SrtStreamingService.this;
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    sInstance = this;

    if (sPendingStateManager != null) {
      mStateManager = sPendingStateManager;
      sPendingStateManager = null;
      Log.d(TAG, "✅ Applied pending StateManager during onCreate");
    }

    if (sPendingStreamConfig != null) {
      mStreamConfig = sPendingStreamConfig;
      sPendingStreamConfig = null;
      Log.d(TAG, "✅ Applied pending stream config: " + mStreamConfig.toString());
    }

    createNotificationChannel();

    if (!EventBus.getDefault().isRegistered(this)) {
      EventBus.getDefault().register(this);
    }

    mReconnectHandler = new Handler(Looper.getMainLooper());
    mTimeoutHandler = new Handler(Looper.getMainLooper());
    mHardwareManager = HardwareManagerFactory.getInstance(this);

    initStreamer();
  }

  @SuppressLint("MissingPermission")
  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    startForeground(NOTIFICATION_ID, createNotification());

    if (intent != null) {
      String srtUrl = intent.getStringExtra("srt_url");
      String streamId = intent.getStringExtra("stream_id");
      mLedEnabled = intent.getBooleanExtra("enable_led", true);
      mSoundEnabled = intent.getBooleanExtra("enable_sound", true);

      if (srtUrl != null && !srtUrl.isEmpty()) {
        setStreamUrl(srtUrl);

        if (streamId != null && !streamId.isEmpty()) {
          mCurrentStreamId = streamId;
          Log.d(TAG, "Stream ID set: " + streamId);
        }

        mReconnectAttempts = 0;
        mReconnecting = false;

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
          Log.d(TAG, "Auto-starting SRT streaming");
          startStreaming();
        }, 1000);
      }
    }

    return START_STICKY;
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return mBinder;
  }

  @Override
  public void onDestroy() {
    if (sInstance == this) sInstance = null;

    if (mReconnectHandler != null) mReconnectHandler.removeCallbacksAndMessages(null);
    cancelStreamTimeout();
    if (mTimeoutHandler != null) mTimeoutHandler.removeCallbacksAndMessages(null);

    stopStreaming();
    releaseStreamer();
    releaseSurface();
    releaseWakeLocks();

    if (EventBus.getDefault().isRegistered(this)) {
      EventBus.getDefault().unregister(this);
    }

    super.onDestroy();
  }

  private void createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "SRT Streaming Service", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("Shows when the app is streaming via SRT");
      channel.enableLights(true);
      channel.setLightColor(Color.BLUE);
      NotificationManager manager = getSystemService(NotificationManager.class);
      if (manager != null) manager.createNotificationChannel(channel);
    }
  }

  private Notification createNotification() {
    String contentText = mIsStreaming ? "Streaming to SRT" : "Ready to stream";
    if (mReconnecting) contentText = "Reconnecting... (Attempt " + mReconnectAttempts + ")";

    return new NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("MentraOS SRT Streaming")
        .setContentText(contentText)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build();
  }

  private void updateNotification() {
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(NOTIFICATION_ID, createNotification());
  }

  private void updateNotificationIfImportant() {
    boolean shouldUpdate = false;
    if (mStreamState == StreamState.STREAMING && !mReconnecting) {
      shouldUpdate = true;
      mHasShownReconnectingNotification = false;
    } else if (mStreamState == StreamState.IDLE && !mReconnecting) {
      shouldUpdate = true;
      mHasShownReconnectingNotification = false;
    } else if (mReconnecting && !mHasShownReconnectingNotification) {
      shouldUpdate = true;
      mHasShownReconnectingNotification = true;
    }
    if (shouldUpdate) updateNotification();
  }

  private void createSurface() {
    if (mSurfaceTexture != null) releaseSurface();
    try {
      int surfaceWidth = mStreamConfig.getCaptureSurfaceWidth();
      int surfaceHeight = mStreamConfig.getCaptureSurfaceHeight();
      mSurfaceTexture = new SurfaceTexture(0);
      mSurfaceTexture.setDefaultBufferSize(surfaceWidth, surfaceHeight);
      mSurface = new Surface(mSurfaceTexture);
      Log.d(TAG, "Surface created: " + surfaceWidth + "x" + surfaceHeight
          + " (encode " + mStreamConfig.getVideoWidth() + "x" + mStreamConfig.getVideoHeight() + ")");
    } catch (Exception e) {
      Log.e(TAG, "Error creating surface", e);
      if (sStatusCallback != null) sStatusCallback.onStreamError("Failed to create surface: " + e.getMessage(), mCurrentStreamId);
    }
  }

  private void releaseSurface() {
    if (mSurface != null) { mSurface.release(); mSurface = null; }
    if (mSurfaceTexture != null) { mSurfaceTexture.release(); mSurfaceTexture = null; }
  }

  @SuppressLint("MissingPermission")
  private void initStreamer() {
    synchronized (mStateLock) {
      if (mSrtStreamer != null) {
        Log.d(TAG, "Releasing existing SRT streamer before reinitializing");
        releaseStreamer(true);
        try { Thread.sleep(100); } catch (InterruptedException e) { Log.w(TAG, "Interrupted"); }
      }
    }

    try {
      Log.d(TAG, "Initializing SRT streamer");
      wakeUpScreen();
      createSurface();

      final OnErrorListener errorListener = new OnErrorListener() {
        @Override
        public void onError(StreamPackError error) {
          Log.e(TAG, "SRT streaming error: " + error.getMessage());
          EventBus.getDefault().post(new StreamingEvent.Error("Streaming error: " + error.getMessage()));
          boolean isRetryable = isRetryableError(error);
          StreamingReporting.reportPackError(SrtStreamingService.this, "stream_error", error.getMessage(), isRetryable);
          if (isRetryable) {
            scheduleReconnect("stream_error");
          } else {
            if (sStatusCallback != null) sStatusCallback.onStreamError("Fatal SRT error: " + error.getMessage(), mCurrentStreamId);
            stopStreaming();
          }
        }
      };

      final OnConnectionListener connectionListener = new OnConnectionListener() {
        @Override
        public void onSuccess() {
          Log.i(TAG, "SRT connection successful");
          synchronized (mStateLock) {
            mStreamState = StreamState.STREAMING;
            mIsStreaming = true;
            mIsStreamingActive = true;
            mReconnectAttempts = 0;
            boolean wasReconnecting = mReconnecting;
            mReconnecting = false;

            long currentTime = System.currentTimeMillis();
            if (wasReconnecting) {
              long downtime = mLastReconnectionTime > 0 ? currentTime - mLastReconnectionTime : 0;
              Log.e(TAG, "🟢 SRT RECONNECTED after " + formatDuration(downtime) + " downtime");
              if (sStatusCallback != null) sStatusCallback.onReconnected(mSrtUrl, mReconnectAttempts, mCurrentStreamId);
            } else {
              Log.e(TAG, "🟢 SRT STREAM STARTED");
              if (sStatusCallback != null) sStatusCallback.onStreamStarted(mSrtUrl, mCurrentStreamId);
            }

            if (mCurrentStreamId != null && !mCurrentStreamId.isEmpty()) {
              scheduleStreamTimeout(mCurrentStreamId);
            }

            updateNotificationIfImportant();

            if (mLedEnabled && mHardwareManager != null && mHardwareManager.supportsRecordingLed()) {
              mHardwareManager.setRecordingLedOn();
            }
            if (mSoundEnabled && mHardwareManager != null && mHardwareManager.supportsAudioPlayback()) {
              mHardwareManager.playAudioAsset(AudioAssets.VIDEO_RECORDING_START);
            }

            startBatteryMonitoring();
            EventBus.getDefault().post(new StreamingEvent.Connected());
            EventBus.getDefault().post(new StreamingEvent.Started());
          }
        }

        @Override
        public void onFailed(String message) {
          long currentTime = System.currentTimeMillis();
          if (mStreamStartTime > 0 && mStreamState == StreamState.STREAMING) {
            Log.e(TAG, "🔴 SRT STREAM FAILED after " + formatDuration(currentTime - mStreamStartTime));
          }
          mLastReconnectionTime = currentTime;
          Log.e(TAG, "SRT connection failed: " + message);
          EventBus.getDefault().post(new StreamingEvent.ConnectionFailed(message));
          StreamingReporting.reportRtmpConnectionFailure(SrtStreamingService.this, mSrtUrl, message, null);

          if (!isRetryableErrorString(message)) {
            Log.w(TAG, "Fatal SRT error - stopping stream");
            if (sStatusCallback != null) sStatusCallback.onStreamError("SRT connection failed: " + message, mCurrentStreamId);
            stopStreaming();
            return;
          }

          final int currentSequence = mReconnectionSequence;
          mReconnectHandler.postDelayed(() -> {
            if (currentSequence != mReconnectionSequence) return;
            synchronized (mStateLock) {
              if (mStreamState == StreamState.STREAMING && mIsStreaming) {
                Log.d(TAG, "SRT library recovered internally");
              } else if (mStreamState == StreamState.STARTING) {
                scheduleReconnect("connection_failed");
              }
            }
          }, 1000);
        }

        @Override
        public void onLost(String message) {
          long currentTime = System.currentTimeMillis();
          long streamDuration = mStreamStartTime > 0 ? currentTime - mStreamStartTime : 0;
          Log.e(TAG, "🔴 SRT STREAM DISCONNECTED after " + formatDuration(streamDuration));
          mLastReconnectionTime = currentTime;
          EventBus.getDefault().post(new StreamingEvent.Disconnected());
          StreamingReporting.reportRtmpConnectionLost(SrtStreamingService.this, mSrtUrl, streamDuration, message);

          final int currentSequence = mReconnectionSequence;
          mReconnectHandler.postDelayed(() -> {
            if (currentSequence != mReconnectionSequence) return;
            synchronized (mStateLock) {
              if (mStreamState == StreamState.STREAMING && mIsStreaming) {
                Log.d(TAG, "SRT library recovered internally");
              } else if (mStreamState == StreamState.IDLE || mStreamState == StreamState.STOPPING) {
                Log.d(TAG, "SRT stream stopped, not reconnecting");
              } else {
                scheduleReconnect("connection_lost");
              }
            }
          }, 1000);
        }
      };

      TsServiceInfo tsServiceInfo = new TsServiceInfo(
          TsServiceInfo.ServiceType.DIGITAL_TV,
          (short) 0x4698,
          "AugmentOS",
          "Mentra"
      );
      mSrtStreamer = new CameraSrtLiveStreamer(
          this, true, tsServiceInfo, null, null, errorListener, connectionListener);

      int videoWidth = mStreamConfig.getVideoWidth();
      int videoHeight = mStreamConfig.getVideoHeight();
      int captureW = mStreamConfig.getCaptureSurfaceWidth();
      int captureH = mStreamConfig.getCaptureSurfaceHeight();
      int videoBitrate = mStreamConfig.getVideoBitrate();
      int videoFps = mStreamConfig.getVideoFps();
      int audioBitrate = mStreamConfig.getAudioBitrate();
      int audioSampleRate = mStreamConfig.getAudioSampleRate();
      boolean echoCancellation = mStreamConfig.isEchoCancellation();
      boolean noiseSuppression = mStreamConfig.isNoiseSuppression();

      Log.i(TAG, "Initializing SRT stream with config: " + mStreamConfig.toString());

      AudioConfig audioConfig = new AudioConfig(
          MediaFormat.MIMETYPE_AUDIO_AAC, audioBitrate, audioSampleRate,
          AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
          MediaCodecInfo.CodecProfileLevel.AACObjectLC, echoCancellation, noiseSuppression);

      String mimeType = MediaFormat.MIMETYPE_VIDEO_AVC;
      int profile = VideoConfig.Companion.getBestProfile(mimeType);
      int level = VideoConfig.Companion.getBestLevel(mimeType, profile);
      Size captureSize =
          (captureW != videoWidth || captureH != videoHeight)
              ? new Size(captureW, captureH)
              : null;
      VideoConfig videoConfig = new VideoConfig(
          mimeType, videoBitrate, new Size(videoWidth, videoHeight), videoFps, profile, level,
          2.0f, captureSize);

      mSrtStreamer.configure(videoConfig);
      mSrtStreamer.configure(audioConfig);
      mLastSrtStreamerForCleanup = mSrtStreamer;

      if (mSurface != null && mSurface.isValid()) {
        mSrtStreamer.startPreview(mSurface, "0");
        Log.d(TAG, "Started camera preview (SRT)");
      } else {
        Log.e(TAG, "Cannot start preview, surface is invalid");
      }

      EventBus.getDefault().post(new StreamingEvent.Ready());
      Log.i(TAG, "SRT streamer initialized successfully");

    } catch (Exception e) {
      Log.e(TAG, "Failed to initialize SRT streamer", e);
      EventBus.getDefault().post(new StreamingEvent.Error("Initialization failed: " + e.getMessage()));
      if (sStatusCallback != null) sStatusCallback.onStreamError("Initialization failed: " + e.getMessage(), mCurrentStreamId);
      StreamingReporting.reportInitializationFailure(SrtStreamingService.this, mSrtUrl, e.getMessage(), e);
    }
  }

  private void releaseStreamer() {
    releaseStreamer(false);
  }

  private void releaseStreamer(boolean preserveSession) {
    forceStopStreamingInternal(preserveSession);
    releaseWakeLocks();
  }

  public void setStreamUrl(String url) {
    this.mSrtUrl = url;
    Log.i(TAG, "SRT URL set to: " + url);
  }

  @RequiresPermission(Manifest.permission.CAMERA)
  public void startStreaming() {
    synchronized (mStateLock) {
      if (mStreamState != StreamState.IDLE) {
        Log.i(TAG, "SRT stream request while in state: " + mStreamState + " - forcing clean restart");
        String preservedStreamId = mReconnecting ? mCurrentStreamId : null;
        forceStopStreamingInternal(mReconnecting);
        if (preservedStreamId != null) mCurrentStreamId = preservedStreamId;
        try { Thread.sleep(500); } catch (InterruptedException e) { Log.w(TAG, "Interrupted during cleanup"); }
      }

      if (mReconnectHandler != null) mReconnectHandler.removeCallbacksAndMessages(null);

      if (mReconnecting) {
        // Called from scheduleReconnect() — preserve attempt count and reconnecting flag
        Log.d(TAG, "Reconnect attempt #" + mReconnectAttempts + " starting (sequence: " + mReconnectionSequence + ")");
      } else {
        // Fresh start from external caller — reset everything
        if (mReconnectAttempts > 0) {
          Log.w(TAG, "Cleaning up stale reconnection state - attempts: " + mReconnectAttempts);
          mReconnectAttempts = 0;
        }
        mReconnectionSequence++;
      }

      if (CameraNeo.isCameraInUse()) {
        String error = "camera_busy";
        Log.e(TAG, "Cannot start SRT stream - camera is busy");
        if (sStatusCallback != null) sStatusCallback.onStreamError(error, mCurrentStreamId);
        StreamingReporting.reportCameraBusyError(SrtStreamingService.this, "start_streaming");
        return;
      }

      CameraNeo.closeKeptAliveCamera();

      if (mSrtUrl == null || mSrtUrl.isEmpty()) {
        String error = "SRT URL not set";
        if (sStatusCallback != null) sStatusCallback.onStreamError(error, mCurrentStreamId);
        StreamingReporting.reportUrlValidationFailure(SrtStreamingService.this, "null", "URL is null or empty");
        return;
      }

      mStreamState = StreamState.STARTING;
    }

    try {
      wakeUpScreen();
      try { Thread.sleep(100); } catch (InterruptedException e) { Log.w(TAG, "Interrupted"); }

      if (mSrtStreamer == null) {
        Log.i(TAG, "SRT streamer is null, reinitializing");
        initStreamer();
        try { Thread.sleep(200); } catch (InterruptedException e) { Log.w(TAG, "Interrupted"); }
      }

      if (mReconnecting) {
        Log.i(TAG, "Reconnecting to SRT (attempt " + mReconnectAttempts + ")");
        if (sStatusCallback != null) sStatusCallback.onReconnecting(mReconnectAttempts, MAX_RECONNECT_ATTEMPTS, "connection_retry", mCurrentStreamId);
      } else {
        Log.i(TAG, "Starting SRT streaming to " + mSrtUrl);
        if (sStatusCallback != null) sStatusCallback.onStreamStarting(mSrtUrl, mCurrentStreamId);
      }

      releaseSurface();
      createSurface();

      if (mSurface != null && mSurface.isValid()) {
        try {
          if (mSrtStreamer != null) mSrtStreamer.stopPreview();
        } catch (Exception e) {
          Log.d(TAG, "No preview to stop: " + e.getMessage());
        }
        mSrtStreamer.startPreview(mSurface, "0");
        try { Thread.sleep(200); } catch (InterruptedException e) { Log.w(TAG, "Interrupted"); }
      } else {
        throw new Exception("Failed to create valid surface for streaming");
      }

      final Continuation<Unit> streamContinuation = new Continuation<Unit>() {
        @Override
        public CoroutineContext getContext() { return EmptyCoroutineContext.INSTANCE; }

        @Override
        public void resumeWith(Object o) {
          synchronized (mStateLock) {
            if (o instanceof Throwable) {
              String errorMsg = "Failed to start SRT streaming: " + ((Throwable) o).getMessage();
              Log.e(TAG, "Error starting SRT stream", (Throwable) o);
              mStreamState = StreamState.IDLE;
              mIsStreaming = false;
              if (sStatusCallback != null) sStatusCallback.onStreamError(errorMsg, mCurrentStreamId);
              StreamingReporting.reportStreamStartFailure(SrtStreamingService.this, mSrtUrl, ((Throwable) o).getMessage(), (Throwable) o);
              scheduleReconnect("start_error");
            } else {
              if (mStreamState == StreamState.STREAMING) return;
              Log.d(TAG, "SRT stream initialization succeeded, waiting for connection...");
              mIsStreaming = false;
              if (mStreamStartTime == 0 && !mReconnecting) mStreamStartTime = System.currentTimeMillis();
              if (mStreamState == StreamState.STARTING) EventBus.getDefault().post(new StreamingEvent.Initializing());
            }
          }
        }
      };

      mSrtStreamer.startStream(mSrtUrl, streamContinuation);

    } catch (Exception e) {
      String errorMsg = "Failed to start SRT streaming: " + e.getMessage();
      Log.e(TAG, errorMsg, e);
      synchronized (mStateLock) { mStreamState = StreamState.IDLE; mIsStreaming = false; }
      if (sStatusCallback != null) sStatusCallback.onStreamError(errorMsg, mCurrentStreamId);
      StreamingReporting.reportStreamStartFailure(SrtStreamingService.this, mSrtUrl, e.getMessage(), e);
      scheduleReconnect("start_exception");
    }
  }

  public void stopStreaming() {
    synchronized (mStateLock) {
      if (mStreamState == StreamState.STOPPING) { Log.w(TAG, "Already stopping SRT stream"); return; }
      mStreamState = StreamState.STOPPING;
    }
    Log.i(TAG, "Stopping SRT streaming");
    forceStopStreamingInternal(false);
  }

  private void forceStopStreamingInternal(boolean preserveSession) {
    Log.d(TAG, "Force stopping SRT stream (preserveSession=" + preserveSession + ")");

    if (!preserveSession) stopBatteryMonitoring();

    mReconnectionSequence++;
    if (mReconnectHandler != null) mReconnectHandler.removeCallbacksAndMessages(null);

    if (!preserveSession) cancelStreamTimeout();

    mReconnecting = preserveSession;
    if (!preserveSession) { mReconnectAttempts = 0; }

    final Continuation<kotlin.Unit> stopContinuation = new Continuation<kotlin.Unit>() {
      @Override
      public CoroutineContext getContext() { return EmptyCoroutineContext.INSTANCE; }
      @Override
      public void resumeWith(Object o) {
        if (o instanceof Throwable) {
          Log.e(TAG, "Error during SRT stream stop", (Throwable) o);
          StreamingReporting.reportStreamStopFailure(SrtStreamingService.this, "stream_stop_error", (Throwable) o);
          if (sStatusCallback != null) sStatusCallback.onStreamError("Failed to stop SRT stream: " + ((Throwable) o).getMessage(), mCurrentStreamId);
        }
        Log.d(TAG, "SRT stream stop completed");
      }
    };

    CameraSrtLiveStreamer srtStreamerToCleanup = mSrtStreamer != null ? mSrtStreamer : mLastSrtStreamerForCleanup;
    if (srtStreamerToCleanup != null) {
      try { srtStreamerToCleanup.stopStream(stopContinuation); } catch (Exception e) { Log.e(TAG, "Exception stopping SRT stream", e); }
      try { srtStreamerToCleanup.stopPreview(); Log.d(TAG, "SRT camera preview stopped"); } catch (Exception e) {
        Log.e(TAG, "Error stopping SRT preview", e);
        StreamingReporting.reportPreviewStartFailure(SrtStreamingService.this, "stop_preview_error", e);
        if (sStatusCallback != null) sStatusCallback.onStreamError("Failed to stop camera preview: " + e.getMessage(), mCurrentStreamId);
      }
      try { srtStreamerToCleanup.release(); Log.d(TAG, "SRT streamer released"); } catch (Exception e) {
        Log.e(TAG, "Error releasing SRT streamer", e);
        StreamingReporting.reportResourceCleanupFailure(SrtStreamingService.this, "streamer", "release_error", e);
        if (sStatusCallback != null) sStatusCallback.onStreamError("Failed to release SRT resources: " + e.getMessage(), mCurrentStreamId);
      }
      if (mSrtStreamer == srtStreamerToCleanup) mSrtStreamer = null;
      mLastSrtStreamerForCleanup = null;
    }

    releaseSurface();

    synchronized (mStateLock) {
      mStreamState = StreamState.IDLE;
      mIsStreaming = false;
      if (!preserveSession) {
        mIsStreamingActive = false;
        mCurrentStreamId = null;
        mStreamStartTime = 0;
        mLastReconnectionTime = 0;
      }
    }

    updateNotificationIfImportant();

    if (mLedEnabled && mHardwareManager != null && mHardwareManager.supportsRecordingLed()) {
      if (!preserveSession) mHardwareManager.setRecordingLedOff();
    }
    if (!preserveSession && mSoundEnabled && mHardwareManager != null && mHardwareManager.supportsAudioPlayback()) {
      mHardwareManager.playAudioAsset(AudioAssets.VIDEO_RECORDING_STOP);
    }

    if (!preserveSession) {
      if (sStatusCallback != null) sStatusCallback.onStreamStopped(mCurrentStreamId);
      EventBus.getDefault().post(new StreamingEvent.Stopped());
      Log.i(TAG, "SRT streaming stopped");
    }
  }

  private void scheduleReconnect(String reason) {
    if (mReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      Log.w(TAG, "Max SRT reconnection attempts reached");
      if (sStatusCallback != null) sStatusCallback.onReconnectFailed(MAX_RECONNECT_ATTEMPTS, mCurrentStreamId);
      long totalDuration = System.currentTimeMillis() - mLastReconnectionTime;
      StreamingReporting.reportReconnectionExhaustion(SrtStreamingService.this, mSrtUrl, MAX_RECONNECT_ATTEMPTS, totalDuration);
      stopStreaming();
      return;
    }

    if (mReconnectHandler != null) mReconnectHandler.removeCallbacksAndMessages(null);
    mReconnectAttempts++;
    long delay = calculateReconnectDelay(mReconnectAttempts);
    Log.d(TAG, "Scheduling SRT reconnection #" + mReconnectAttempts + " in " + delay + "ms (reason: " + reason + ")");
    if (sStatusCallback != null) sStatusCallback.onReconnecting(mReconnectAttempts, MAX_RECONNECT_ATTEMPTS, reason, mCurrentStreamId);
    mReconnecting = true;
    updateNotificationIfImportant();

    final int currentSequence = mReconnectionSequence;
    mReconnectHandler.postDelayed(() -> {
      if (currentSequence != mReconnectionSequence) return;
      synchronized (mStateLock) {
        // Allow reconnection if we're still actively reconnecting (even from IDLE after a failed attempt)
        // Only bail if an explicit stop was requested (mReconnecting would be false)
        if (!mReconnecting) {
          Log.d(TAG, "Stream was explicitly stopped during reconnection delay, cancelling reconnection");
          return;
        }
        if (mStreamState == StreamState.STOPPING) {
          Log.d(TAG, "Stream is stopping, cancelling reconnection");
          return;
        }
        mStreamState = StreamState.IDLE;
        mIsStreaming = false;
        startStreaming();
      }
    }, delay);
  }

  private long calculateReconnectDelay(int attempt) {
    double jitter = Math.random() * 0.3 * INITIAL_RECONNECT_DELAY_MS;
    return (long) (INITIAL_RECONNECT_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1) + jitter);
  }

  public static void setStreamingStatusCallback(StreamingStatusCallback callback) {
    sStatusCallback = callback;
    Log.d(TAG, "SRT streaming status callback " + (callback != null ? "registered" : "unregistered"));
  }

  private void scheduleStreamTimeout(String streamId) {
    cancelStreamTimeout();
    mCurrentStreamId = streamId;
    mIsStreamingActive = true;
    mStreamTimeoutTimer = new Timer("SrtStreamTimeout-" + streamId);
    mStreamTimeoutTimer.schedule(new TimerTask() {
      @Override
      public void run() {
        Log.w(TAG, "SRT stream timeout for streamId: " + streamId);
        mTimeoutHandler.post(() -> handleStreamTimeout(streamId));
      }
    }, STREAM_TIMEOUT_MS);
  }

  private void handleStreamTimeout(String streamId) {
    synchronized (mStateLock) {
      if (mCurrentStreamId != null && mCurrentStreamId.equals(streamId) && mIsStreamingActive) {
        Log.w(TAG, "SRT stream timed out (no keep-alive): " + streamId);
        StreamingReporting.reportTimeoutError(SrtStreamingService.this, streamId, STREAM_TIMEOUT_MS);
        if (sStatusCallback != null) sStatusCallback.onStreamError("SRT stream timed out - no keep-alive", mCurrentStreamId);
        forceStopStreamingInternal(false);
      }
    }
  }

  private void cancelStreamTimeout() {
    if (mStreamTimeoutTimer != null) { mStreamTimeoutTimer.cancel(); mStreamTimeoutTimer = null; }
    mIsStreamingActive = false;
    mCurrentStreamId = null;
  }

  public static void setStateManager(IStateManager stateManager) {
    if (sInstance != null) {
      sInstance.mStateManager = stateManager;
      Log.d(TAG, "✅ StateManager set for SRT battery monitoring");
    } else {
      sPendingStateManager = stateManager;
      Log.d(TAG, "✅ StateManager stored as pending for SRT service");
    }
  }

  private void startBatteryMonitoring() {
    if (mStateManager == null) { Log.w(TAG, "⚠️ StateManager not set - cannot monitor battery"); return; }
    stopBatteryMonitoring();
    if (mBatteryMonitorHandler == null) mBatteryMonitorHandler = new Handler(Looper.getMainLooper());

    mBatteryCheckRunnable = new Runnable() {
      @Override
      public void run() {
        boolean shouldStop = false, shouldReschedule = false;
        synchronized (mStateLock) {
          if (mIsStreaming) {
            if (mHardwareManager == null) {
              shouldReschedule = true;
            } else if (mStreamState == StreamState.STREAMING) {
              int batteryLevel = mHardwareManager.getBatteryLevel();
              if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🔋⚠️ Battery too low (" + batteryLevel + "%) - stopping SRT stream");
                shouldStop = true;
                if (mHardwareManager.supportsAudioPlayback()) mHardwareManager.playAudioAsset(AudioAssets.BATTERY_LOW);
              } else {
                shouldReschedule = true;
              }
            } else {
              shouldReschedule = true;
            }
          }
        }
        if (shouldReschedule && mBatteryMonitorHandler != null) {
          mBatteryMonitorHandler.postDelayed(this, BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
        }
        if (shouldStop) stopStreaming();
      }
    };

    mBatteryMonitorHandler.postDelayed(mBatteryCheckRunnable, BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
    Log.d(TAG, "🔋 Started battery monitoring for SRT streaming");
  }

  private void stopBatteryMonitoring() {
    if (mBatteryMonitorHandler != null) {
      if (mBatteryCheckRunnable != null) {
        mBatteryMonitorHandler.removeCallbacks(mBatteryCheckRunnable);
        mBatteryCheckRunnable = null;
      }
      mBatteryMonitorHandler.removeCallbacksAndMessages(null);
      Log.d(TAG, "🔋 Stopped SRT battery monitoring");
    }
  }

  public static void setStreamConfig(RtmpStreamConfig config) {
    if (config == null) config = new RtmpStreamConfig();
    if (sInstance != null) {
      sInstance.mStreamConfig = config;
      Log.d(TAG, "✅ SRT stream config set: " + config.toString());
    } else {
      sPendingStreamConfig = config;
      Log.d(TAG, "✅ SRT stream config stored as pending: " + config.toString());
    }
  }

  public static void startStreaming(Context context, String srtUrl, String streamId,
      boolean enableLed, boolean enableSound, RtmpStreamConfig config) {
    setStreamConfig(config);

    if (sInstance != null) {
      if (sInstance.mReconnectHandler != null) sInstance.mReconnectHandler.removeCallbacksAndMessages(null);
      sInstance.mReconnectAttempts = 0;
      sInstance.mReconnecting = false;
      sInstance.setStreamUrl(srtUrl);
      sInstance.mCurrentStreamId = streamId;
      sInstance.mLedEnabled = enableLed;
      sInstance.mSoundEnabled = enableSound;
      sInstance.startStreaming();
    } else {
      Intent intent = new Intent(context, SrtStreamingService.class);
      intent.putExtra("srt_url", srtUrl);
      if (streamId != null && !streamId.isEmpty()) intent.putExtra("stream_id", streamId);
      intent.putExtra("enable_led", enableLed);
      intent.putExtra("enable_sound", enableSound);
      context.startService(intent);
    }
  }

  public static void startStreaming(Context context, String srtUrl, String streamId,
      boolean enableLed, boolean enableSound) {
    startStreaming(context, srtUrl, streamId, enableLed, enableSound, null);
  }

  public static void startStreaming(Context context, String srtUrl, String streamId) {
    startStreaming(context, srtUrl, streamId, true, true, null);
  }

  public static void stopStreaming(Context context) {
    if (sInstance != null) {
      sInstance.stopStreaming();
    } else {
      EventBus.getDefault().post(new StreamingCommand.Stop());
    }
  }

  public static boolean isStreaming() {
    if (sInstance != null) {
      synchronized (sInstance.mStateLock) {
        return sInstance.mStreamState == StreamState.STREAMING || sInstance.mStreamState == StreamState.STARTING;
      }
    }
    return false;
  }

  public static boolean isReconnecting() {
    return sInstance != null && sInstance.mReconnecting;
  }

  public static int getReconnectAttempt() {
    return sInstance != null ? sInstance.mReconnectAttempts : 0;
  }

  public static boolean resetStreamTimeout(String streamId) {
    if (sInstance != null) {
      if (sInstance.mCurrentStreamId != null && sInstance.mCurrentStreamId.equals(streamId) && sInstance.mIsStreamingActive) {
        WakeLockManager.acquireFullWakeLockAndBringToForeground(sInstance.getApplicationContext(), 2180000, 5000);
        sInstance.scheduleStreamTimeout(streamId);
        return true;
      }
    }
    return false;
  }

  public static String getCurrentStreamId() {
    return sInstance != null ? sInstance.mCurrentStreamId : null;
  }

  @Subscribe(threadMode = ThreadMode.MAIN)
  public void onStreamingCommand(StreamingCommand command) {
    if (command instanceof StreamingCommand.Start) {
      mReconnectAttempts = 0;
      mReconnecting = false;
      startStreaming();
    } else if (command instanceof StreamingCommand.Stop) {
      stopStreaming();
    } else if (command instanceof StreamingCommand.SetRtmpUrl) {
      setStreamUrl(((StreamingCommand.SetRtmpUrl) command).getRtmpUrl());
    }
  }

  private boolean isRetryableError(StreamPackError error) {
    String message = error.getMessage();
    if (message == null) return true;
    if (message.contains("SocketException") || message.contains("Connection") || message.contains("Timeout") ||
        message.contains("Network") || message.contains("UnknownHostException") || message.contains("IOException") ||
        message.contains("ECONNREFUSED") || message.contains("ETIMEDOUT")) return true;
    if (message.contains("Permission") || message.contains("Invalid URL") || message.contains("Authentication") ||
        message.contains("Codec") || message.contains("Not supported") || message.contains("Illegal")) return false;
    if (message.contains("Camera") && (message.contains("busy") || message.contains("in use"))) return false;
    return true;
  }

  private boolean isRetryableErrorString(String message) {
    if (message == null) return true;
    String lower = message.toLowerCase();
    if (lower.contains("socket") || lower.contains("connection") || lower.contains("timeout") ||
        lower.contains("network") || lower.contains("ioexception") || lower.contains("refused") ||
        lower.contains("disconnected") || lower.contains("reset") || lower.contains("host")) return true;
    if (lower.contains("permission") || lower.contains("invalid url") || lower.contains("authentication") ||
        lower.contains("codec") || lower.contains("illegal")) return false;
    if (lower.contains("camera") && (lower.contains("busy") || lower.contains("in use"))) return false;
    return true;
  }

  private void wakeUpScreen() {
    WakeLockManager.acquireFullWakeLockAndBringToForeground(this, 2180000, 5000);
  }

  private void releaseWakeLocks() {
    WakeLockManager.releaseAllWakeLocks();
  }

  private static String formatDuration(long durationMs) {
    if (durationMs < 0) return "0s";
    long seconds = durationMs / 1000;
    long minutes = seconds / 60;
    long hours = minutes / 60;
    seconds %= 60; minutes %= 60;
    if (hours > 0) return String.format("%dh %dm %ds", hours, minutes, seconds);
    if (minutes > 0) return String.format("%dm %ds", minutes, seconds);
    return String.format("%ds", seconds);
  }
}

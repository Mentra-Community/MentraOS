package com.augmentos.asg_client.streaming;

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

import com.augmentos.asg_client.camera.CameraNeo;
import com.augmentos.asg_client.utils.WakeLockManager;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

import io.github.thibaultbee.streampack.data.AudioConfig;
import io.github.thibaultbee.streampack.data.VideoConfig;
import io.github.thibaultbee.streampack.error.StreamPackError;
import io.github.thibaultbee.streampack.ext.rtmp.streamers.CameraRtmpLiveStreamer;
import io.github.thibaultbee.streampack.listeners.OnConnectionListener;
import io.github.thibaultbee.streampack.listeners.OnErrorListener;
import io.github.thibaultbee.streampack.views.PreviewView;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;

@SuppressLint("MissingPermission")
public class RtmpStreamingService extends Service {
    private static final String TAG = "RtmpStreamingService";
    private static final String CHANNEL_ID = "RtmpStreamingChannel";
    private static final int NOTIFICATION_ID = 8888;

    // Static instance reference for static method access
    private static RtmpStreamingService sInstance;

    // Static callback for streaming status
    private static StreamingStatusCallback sStatusCallback;

    private final IBinder mBinder = new LocalBinder();
    private CameraRtmpLiveStreamer mStreamer;
    private String mRtmpUrl;
    private boolean mIsStreaming = false;
    private SurfaceTexture mSurfaceTexture;
    private Surface mSurface;
    private static final int SURFACE_WIDTH = 540;
    private static final int SURFACE_HEIGHT = 960;

    // Reconnection logic parameters
    private int mReconnectAttempts = 0;
    private static final int MAX_RECONNECT_ATTEMPTS = 10;
    private static final long INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
    private static final float BACKOFF_MULTIPLIER = 1.5f;
    private Handler mReconnectHandler;
    private boolean mReconnecting = false;

    // Consecutive failure tracking to avoid interfering with library internal recovery
    private int mConsecutiveFailures = 0;
    private static final int MIN_CONSECUTIVE_FAILURES = 3; // Only take over after 3 consecutive failures
    private long mLastFailureTime = 0;
    private int mTotalFailures = 0; // Track total failures for debugging

    // Keep-alive timeout parameters
    private Timer mRtmpStreamTimeoutTimer;
    private String mCurrentStreamId;
    private boolean mIsStreamingActive = false;
    private static final long STREAM_TIMEOUT_MS = 60000; // 60 seconds timeout
    private Handler mTimeoutHandler;

    // Notification management
    private boolean mHasShownReconnectingNotification = false;

    // Stream state management
    private enum StreamState {
        IDLE,
        STARTING,
        STREAMING,
        STOPPING
    }
    private volatile StreamState mStreamState = StreamState.IDLE;
    private final Object mStateLock = new Object();

    // Stream duration tracking
    private long mStreamStartTime = 0;
    private long mLastReconnectionTime = 0;

    // Reconnection sequence tracking to prevent stale handlers
    private int mReconnectionSequence = 0;

    public class LocalBinder extends Binder {
        public RtmpStreamingService getService() {
            return RtmpStreamingService.this;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();

        // Store static instance reference
        sInstance = this;

        // Create notification channel
        createNotificationChannel();

        // Register with EventBus
        if (!EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().register(this);
        }

        // Initialize handler for reconnection logic
        mReconnectHandler = new Handler(Looper.getMainLooper());

        // Initialize handler for timeout logic
        mTimeoutHandler = new Handler(Looper.getMainLooper());

        // Initialize the streamer
        initStreamer();
    }

    @SuppressLint("MissingPermission")
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Start as a foreground service with notification
        startForeground(NOTIFICATION_ID, createNotification());

        // Get RTMP URL and stream ID from intent if provided
        if (intent != null) {
            String rtmpUrl = intent.getStringExtra("rtmp_url");
            String streamId = intent.getStringExtra("stream_id");

            if (rtmpUrl != null && !rtmpUrl.isEmpty()) {
                setRtmpUrl(rtmpUrl);

                // Store the stream ID if provided
                if (streamId != null && !streamId.isEmpty()) {
                    mCurrentStreamId = streamId;
                    Log.d(TAG, "Stream ID set: " + streamId);
                }

                // Reset reconnection attempts
                mReconnectAttempts = 0;
                mReconnecting = false;

                // Auto-start streaming after a short delay
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    Log.d(TAG, "Auto-starting streaming");
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
        // Clear static instance reference
        if (sInstance == this) {
            sInstance = null;
        }

        // Cancel any pending reconnections
        if (mReconnectHandler != null) {
            mReconnectHandler.removeCallbacksAndMessages(null);
        }

        // Cancel timeout timer and handler
        cancelStreamTimeout();
        if (mTimeoutHandler != null) {
            mTimeoutHandler.removeCallbacksAndMessages(null);
        }

        stopStreaming();
        releaseStreamer();

        // Release the surface
        releaseSurface();

        // Release wake locks
        releaseWakeLocks();

        // Unregister from EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }

        super.onDestroy();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "RTMP Streaming Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows when the app is streaming via RTMP");
            channel.enableLights(true);
            channel.setLightColor(Color.BLUE);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification createNotification() {
        String contentText = mIsStreaming ? "Streaming to RTMP" : "Ready to stream";
        if (mReconnecting) {
            contentText = "Reconnecting... (Attempt " + mReconnectAttempts + ")";
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("AugmentOS Streaming")
                .setContentText(contentText)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, createNotification());
        }
    }

    private void updateNotificationIfImportant() {
        // Only update notifications for important state changes:
        // - Stream starting/stopping
        // - First reconnection attempt (not subsequent ones)
        boolean shouldUpdate = false;

        if (mStreamState == StreamState.STREAMING && !mReconnecting) {
            // Stream successfully started/resumed
            shouldUpdate = true;
            mHasShownReconnectingNotification = false; // Reset for next time
        } else if (mStreamState == StreamState.IDLE && !mReconnecting) {
            // Stream stopped
            shouldUpdate = true;
            mHasShownReconnectingNotification = false; // Reset for next time
        } else if (mReconnecting && !mHasShownReconnectingNotification) {
            // First reconnection attempt only
            shouldUpdate = true;
            mHasShownReconnectingNotification = true;
        }

        if (shouldUpdate) {
            updateNotification();
        }
    }

    /**
     * Creates a SurfaceTexture and Surface for the camera preview
     */
    private void createSurface() {
        if (mSurfaceTexture != null) {
            releaseSurface();
        }

        try {
            Log.d(TAG, "Creating surface texture");
            mSurfaceTexture = new SurfaceTexture(0);
            mSurfaceTexture.setDefaultBufferSize(SURFACE_WIDTH, SURFACE_HEIGHT);
            mSurface = new Surface(mSurfaceTexture);
            Log.d(TAG, "Surface created successfully");
        } catch (Exception e) {
            Log.e(TAG, "Error creating surface", e);
            EventBus.getDefault().post(new StreamingEvent.Error("Failed to create surface: " + e.getMessage()));
            if (sStatusCallback != null) {
                sStatusCallback.onStreamError("Failed to create surface: " + e.getMessage());
            }
        }
    }

    /**
     * Releases the surface and surface texture
     */
    private void releaseSurface() {
        if (mSurface != null) {
            mSurface.release();
            mSurface = null;
        }

        if (mSurfaceTexture != null) {
            mSurfaceTexture.release();
            mSurfaceTexture = null;
        }
    }

    @SuppressLint("MissingPermission")
    private void initStreamer() {
        synchronized (mStateLock) {
            if (mStreamer != null) {
                Log.d(TAG, "Releasing existing streamer before reinitializing");
                releaseStreamer();

                // Wait a bit for cleanup
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Log.w(TAG, "Interrupted during streamer cleanup wait");
                }
            }
        }

        try {
            Log.d(TAG, "Initializing streamer");

            // Wake up the screen before initializing camera (for initial setup)
            // Note: startStreaming() also calls wakeUpScreen() for reconnections
            wakeUpScreen();

            // Create a surface for the camera
            createSurface();

            // Create new streamer with error and connection listeners
            mStreamer = new CameraRtmpLiveStreamer(
                    this,
                    true,
                    new OnErrorListener() {
                        @Override
                        public void onError(StreamPackError error) {
                            Log.e(TAG, "Streaming error: " + error.getMessage());
                            EventBus.getDefault().post(new StreamingEvent.Error("Streaming error: " + error.getMessage()));

                            // Classify the error to determine if we should retry or fail immediately
                            if (isRetryableError(error)) {
                                Log.d(TAG, "Retryable error - scheduling reconnection");
                                scheduleReconnect("stream_error");
                            } else {
                                Log.e(TAG, "Fatal error - sending immediate error status");
                                if (sStatusCallback != null) {
                                    sStatusCallback.onStreamError("Fatal streaming error: " + error.getMessage());
                                }
                                // Stop streaming immediately for fatal errors
                                stopStreaming();
                            }
                        }
                    },
                    new OnConnectionListener() {
                        @Override
                        public void onSuccess() {
                            Log.i(TAG, "RTMP connection successful");

                            synchronized (mStateLock) {
                                // NOW we're actually streaming
                                mStreamState = StreamState.STREAMING;
                                mIsStreaming = true;
                                mIsStreamingActive = true; // Mark stream as active for timeout tracking

                                // Reset reconnect attempts when we get a successful connection
                                mReconnectAttempts = 0;
                                boolean wasReconnecting = mReconnecting;
                                mReconnecting = false;

                                // Track stream timing
                                long currentTime = System.currentTimeMillis();
                                if (wasReconnecting) {
                                    // Calculate downtime during reconnection
                                    long downtime = mLastReconnectionTime > 0 ? currentTime - mLastReconnectionTime : 0;
                                    Log.e(TAG, "🟢 STREAM RECONNECTED after " + formatDuration(downtime) + " downtime");
                                    Log.i(TAG, "Successfully reconnected to " + mRtmpUrl);
                                    if (sStatusCallback != null) {
                                        sStatusCallback.onReconnected(mRtmpUrl, mReconnectAttempts);
                                    }
                                } else {
                                    // Fresh stream start
                                    Log.e(TAG, "🟢 STREAM STARTED at " + new java.text.SimpleDateFormat("HH:mm:ss.SSS").format(new java.util.Date(currentTime)));
                                    if (sStatusCallback != null) {
                                        sStatusCallback.onStreamStarted(mRtmpUrl);
                                    }
                                }

                                // Start timeout tracking if we have a stream ID
                                if (mCurrentStreamId != null && !mCurrentStreamId.isEmpty()) {
                                    Log.d(TAG, "Starting timeout tracking for stream: " + mCurrentStreamId);
                                    scheduleStreamTimeout(mCurrentStreamId);
                                }

                                updateNotificationIfImportant();
                                EventBus.getDefault().post(new StreamingEvent.Connected());
                                EventBus.getDefault().post(new StreamingEvent.Started());
                            }
                        }

                        @Override
                        public void onFailed(String message) {
                            // Calculate and log stream duration if this was during active streaming
                            long currentTime = System.currentTimeMillis();
                            if (mStreamStartTime > 0 && mStreamState == StreamState.STREAMING) {
                                long streamDuration = currentTime - mStreamStartTime;
                                Log.e(TAG, "🔴 STREAM FAILED after " + formatDuration(streamDuration) + " of streaming");
                            }
                            mLastReconnectionTime = currentTime;

                            Log.e(TAG, "RTMP connection failed: " + message);
                            EventBus.getDefault().post(new StreamingEvent.ConnectionFailed(message));

                            // Only notify server immediately for fatal errors that won't be retried
                            if (!isRetryableErrorString(message)) {
                                Log.w(TAG, "Fatal error detected - notifying server to stop stream");
                                if (sStatusCallback != null) {
                                    sStatusCallback.onStreamError("RTMP connection failed: " + message);
                                }
                                return; // Don't attempt recovery for fatal errors
                            }

                            // Give the StreamPack library time to recover internally before we take over
                            // The library often recovers from brief network hiccups in 17-100ms
                            Log.d(TAG, "Waiting 1 second for library internal recovery before external reconnection");

                            // Capture current sequence for this delayed handler
                            final int currentSequence = mReconnectionSequence;

                            mReconnectHandler.postDelayed(() -> {
                                // Check if this is still the current reconnection sequence
                                if (currentSequence != mReconnectionSequence) {
                                    Log.d(TAG, "Ignoring stale recovery handler in onFailed (expected sequence: " + mReconnectionSequence + ", got: " + currentSequence + ")");
                                    return;
                                }

                                synchronized (mStateLock) {
                                    // Check if we're actually streaming (connected) or still trying to connect
                                    if (mStreamState == StreamState.STREAMING && mIsStreaming) {
                                        // We actually recovered (onSuccess was called)
                                        Log.d(TAG, "Library recovered internally, canceling external reconnection");
                                    } else if (mStreamState == StreamState.STARTING) {
                                        // Still trying to connect - library didn't recover
                                        Log.d(TAG, "Library did not recover internally (still in STARTING state), proceeding with external reconnection");
                                        scheduleReconnect("connection_failed");
                                    } else if (mStreamState == StreamState.IDLE || mStreamState == StreamState.STOPPING) {
                                        // Stream was stopped/cancelled
                                        Log.d(TAG, "Stream was stopped/cancelled, not scheduling reconnection");
                                    }
                                }
                            }, 1000); // Wait 1 second for library internal recovery
                        }

                        @Override
                        public void onLost(String message) {
                            // Calculate and log stream duration
                            long currentTime = System.currentTimeMillis();
                            if (mStreamStartTime > 0) {
                                long streamDuration = currentTime - mStreamStartTime;
                                Log.e(TAG, "🔴 STREAM DISCONNECTED after " + formatDuration(streamDuration) + " of streaming");
                                Log.e(TAG, "🔴 Stream started at: " + new java.text.SimpleDateFormat("HH:mm:ss.SSS").format(new java.util.Date(mStreamStartTime)));
                                Log.e(TAG, "🔴 Stream lost at: " + new java.text.SimpleDateFormat("HH:mm:ss.SSS").format(new java.util.Date(currentTime)));
                            }
                            mLastReconnectionTime = currentTime;

                            Log.i(TAG, "RTMP connection lost: " + message);
                            EventBus.getDefault().post(new StreamingEvent.Disconnected());

                            // Give the StreamPack library time to recover internally before we take over
                            Log.d(TAG, "Waiting 1 second for library internal recovery before external reconnection");

                            // Capture current sequence for this delayed handler
                            final int currentSequence = mReconnectionSequence;

                            mReconnectHandler.postDelayed(() -> {
                                // Check if this is still the current reconnection sequence
                                if (currentSequence != mReconnectionSequence) {
                                    Log.d(TAG, "Ignoring stale recovery handler in onLost (expected sequence: " + mReconnectionSequence + ", got: " + currentSequence + ")");
                                    return;
                                }

                                synchronized (mStateLock) {
                                    // Check if we're actually streaming (connected) or need to reconnect
                                    if (mStreamState == StreamState.STREAMING && mIsStreaming) {
                                        // We actually recovered (reconnected)
                                        Log.d(TAG, "Library recovered internally, canceling external reconnection");
                                    } else if (mStreamState == StreamState.IDLE || mStreamState == StreamState.STOPPING) {
                                        // Stream was stopped/cancelled
                                        Log.d(TAG, "Stream was stopped/cancelled, not scheduling reconnection");
                                    } else {
                                        // Connection lost and not recovered
                                        Log.d(TAG, "Library did not recover internally from connection loss, proceeding with external reconnection");
                                        scheduleReconnect("connection_lost");
                                    }
                                }
                            }, 1000); // Wait 1 second for library internal recovery
                        }
                    }
            );

            // For MIME type, use the actual mime type instead of null
            String audioMimeType = MediaFormat.MIMETYPE_AUDIO_AAC; // Default to AAC

            // Get the default profile for this MIME type
            int audioProfile = MediaCodecInfo.CodecProfileLevel.AACObjectLC; // Default for AAC

            // Configure audio settings using proper constructor
            AudioConfig audioConfig = new AudioConfig(
                    MediaFormat.MIMETYPE_AUDIO_AAC,  // Use actual mime type instead of null
                    128000,              // 128 kbps
                    44100,               // 44.1 kHz
                    AudioFormat.CHANNEL_IN_STEREO,
                    audioProfile,    // Default profile
                    0,                   // Default byte format
                    true,                // Enable echo cancellation
                    true                 // Enable noise suppression
            );

            // For MIME type, use the actual mime type instead of null
            String mimeType = MediaFormat.MIMETYPE_VIDEO_AVC; // Default to H.264
            int profile = VideoConfig.Companion.getBestProfile(mimeType);
            int level = VideoConfig.Companion.getBestLevel(mimeType, profile);

            // Configure video settings using proper constructor
            VideoConfig videoConfig = new VideoConfig(
                    MediaFormat.MIMETYPE_VIDEO_AVC,  // Use actual mime type instead of null
                    1000000,             // 1 Mbps
                    new Size(SURFACE_WIDTH, SURFACE_HEIGHT),  // Match surface size
                    14,                  // 14 frames per second
                    profile,             // Default profile
                    level,               // Default level
                    0.0f                 // Default bitrate factor
            );

            // Apply configurations
            mStreamer.configure(videoConfig);
            mStreamer.configure(audioConfig);

            // Start the preview with our surface
            if (mSurface != null && mSurface.isValid()) {
                mStreamer.startPreview(mSurface, "0"); // Using "0" for back camera
                Log.d(TAG, "Started camera preview on surface");
            } else {
                Log.e(TAG, "Cannot start preview, surface is invalid");
            }

            // Notify that we're ready to connect a preview
            EventBus.getDefault().post(new StreamingEvent.Ready());
            Log.i(TAG, "Streamer initialized successfully");

        } catch (Exception e) {
            Log.e(TAG, "Failed to initialize streamer", e);
            EventBus.getDefault().post(new StreamingEvent.Error("Initialization failed: " + e.getMessage()));
            if (sStatusCallback != null) {
                sStatusCallback.onStreamError("Initialization failed: " + e.getMessage());
            }
        }
    }

    private void releaseStreamer() {
        // Just call forceStopStreamingInternal which handles everything
        forceStopStreamingInternal();

        // Release wake locks after everything is cleaned up
        releaseWakeLocks();
    }

    /**
     * Set the RTMP URL for streaming
     * @param rtmpUrl RTMP URL in format rtmp://server/app/streamKey
     */
    public void setRtmpUrl(String rtmpUrl) {
        this.mRtmpUrl = rtmpUrl;
        Log.i(TAG, "RTMP URL set: " + rtmpUrl);
    }

    /**
     * Start streaming to the configured RTMP URL
     */
    @RequiresPermission(Manifest.permission.CAMERA)
    public void startStreaming() {
        synchronized (mStateLock) {
            // Always force a clean stop/start cycle for new stream requests
            if (mStreamState != StreamState.IDLE) {
                Log.i(TAG, "Stream request received while in state: " + mStreamState + " - forcing clean restart");
                // Force stop and clean up everything
                forceStopStreamingInternal();

                // Wait a bit for resources to be released
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    Log.w(TAG, "Interrupted while waiting for stream cleanup");
                }
            }

            // Double-check that pending reconnections are cancelled
            if (mReconnectHandler != null) {
                mReconnectHandler.removeCallbacksAndMessages(null);
            }

            // Ensure reconnection state is clean
            if (mReconnectAttempts > 0 || mReconnecting) {
                Log.w(TAG, "Cleaning up stale reconnection state - attempts: " + mReconnectAttempts + ", reconnecting: " + mReconnecting);
                mReconnectAttempts = 0;
                mReconnecting = false;
            }

            // Increment reconnection sequence to invalidate any pending reconnection handlers
            mReconnectionSequence++;
            Log.d(TAG, "Starting new stream with reconnection sequence: " + mReconnectionSequence);

            // Check if camera is busy with photo/video capture BEFORE attempting to stream
            if (CameraNeo.isCameraInUse()) {
                String error = "camera_busy";
                Log.e(TAG, "Cannot start RTMP stream - camera is busy with photo/video capture");
                EventBus.getDefault().post(new StreamingEvent.Error(error));
                if (sStatusCallback != null) {
                    sStatusCallback.onStreamError(error);
                }
                return;
            }

            if (mRtmpUrl == null || mRtmpUrl.isEmpty()) {
                String error = "RTMP URL not set";
                EventBus.getDefault().post(new StreamingEvent.Error(error));
                if (sStatusCallback != null) {
                    sStatusCallback.onStreamError(error);
                }
                return;
            }

            // Mark state as starting
            mStreamState = StreamState.STARTING;
        }

        try {
            // Always wake up the screen before any camera access
            // This is crucial for reconnection attempts when screen might be off
            Log.d(TAG, "Waking up screen before camera access");
            wakeUpScreen();

            // Give the wake lock a moment to take effect before accessing camera
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Log.w(TAG, "Interrupted while waiting for wake lock");
            }

            // Reinitialize streamer if needed
            if (mStreamer == null) {
                Log.i(TAG, "Streamer is null, reinitializing");
                initStreamer();

                // Wait a bit for initialization
                try {
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    Log.w(TAG, "Interrupted while waiting for streamer init");
                }
            }

            if (mReconnecting) {
                Log.i(TAG, "Attempting to reconnect to " + mRtmpUrl + " (Attempt " + mReconnectAttempts + ")");
                if (sStatusCallback != null) {
                    sStatusCallback.onReconnecting(mReconnectAttempts, MAX_RECONNECT_ATTEMPTS, "connection_retry");
                }
            } else {
                Log.i(TAG, "Starting streaming to " + mRtmpUrl);
                if (sStatusCallback != null) {
                    sStatusCallback.onStreamStarting(mRtmpUrl);
                }
            }

            // Always recreate surface for a fresh start
            Log.d(TAG, "Creating fresh surface for streaming");
            releaseSurface();
            createSurface();

            if (mSurface != null && mSurface.isValid()) {
                try {
                    mStreamer.stopPreview(); // Stop any existing preview first
                } catch (Exception e) {
                    Log.d(TAG, "No preview to stop: " + e.getMessage());
                }

                // Start fresh preview
                mStreamer.startPreview(mSurface, "0");
                Log.d(TAG, "Started camera preview for streaming");
            } else {
                throw new Exception("Failed to create valid surface for streaming");
            }

            // For Kotlin's suspend functions, we need to provide a Continuation
            mStreamer.startStream(mRtmpUrl, new Continuation<Unit>() {
                @Override
                public CoroutineContext getContext() {
                    return EmptyCoroutineContext.INSTANCE;
                }

                @Override
                public void resumeWith(Object o) {
                    synchronized (mStateLock) {
                        if (o instanceof Throwable) {
                            String errorMsg = "Failed to start streaming: " + ((Throwable) o).getMessage();
                            Log.e(TAG, "Error starting stream", (Throwable)o);
                            mStreamState = StreamState.IDLE;
                            mIsStreaming = false;
                            EventBus.getDefault().post(new StreamingEvent.Error(errorMsg));
                            if (sStatusCallback != null) {
                                sStatusCallback.onStreamError(errorMsg);
                            }
                            // Schedule reconnect if we couldn't start the stream
                            scheduleReconnect("start_error");
                        } else {
                            // Don't set STREAMING state yet - wait for actual RTMP connection
                            // Keep state as STARTING until OnConnectionListener.onSuccess() is called
                            Log.d(TAG, "Stream initialization succeeded, waiting for RTMP connection...");
                            mIsStreaming = false; // Not actually streaming until connected

                            // Track stream timing
                            long currentTime = System.currentTimeMillis();
                            if (mReconnecting) {
                                Log.d(TAG, "Stream initialization succeeded during reconnection attempt " + mReconnectAttempts);
                            } else {
                                // Fresh stream start - but wait for actual RTMP connection before reporting success
                                mStreamStartTime = currentTime;
                                Log.d(TAG, "🔄 STREAM INITIALIZING at " + new java.text.SimpleDateFormat("HH:mm:ss.SSS").format(new java.util.Date(currentTime)));
                                Log.i(TAG, "Stream initialization completed for " + mRtmpUrl + " - waiting for RTMP connection");
                                // Note: onStreamStarted() is called from OnConnectionListener.onSuccess() when connection is actually established
                            }
                            // Don't post Started event yet - wait for actual connection
                            EventBus.getDefault().post(new StreamingEvent.Initializing());
                        }
                    }
                }
            });
        } catch (Exception e) {
            String errorMsg = "Failed to start streaming: " + e.getMessage();
            Log.e(TAG, errorMsg, e);

            // Check if this is a camera access issue due to power policy
            if (e.getMessage() != null && e.getMessage().contains("CAMERA_DISABLED") &&
                e.getMessage().contains("disabled by policy")) {
                Log.w(TAG, "Camera disabled by power policy - likely screen is off during reconnection");
                errorMsg = "Camera disabled by power policy (screen off) - " + e.getMessage();
            }

            synchronized (mStateLock) {
                mStreamState = StreamState.IDLE;
                mIsStreaming = false;
            }
            EventBus.getDefault().post(new StreamingEvent.Error(errorMsg));
            if (sStatusCallback != null) {
                sStatusCallback.onStreamError(errorMsg);
            }
            // Schedule reconnect on exception
            scheduleReconnect("start_exception");
        }
    }

    /**
     * Stop the current streaming session
     */
    public void stopStreaming() {
        synchronized (mStateLock) {
            if (mStreamState == StreamState.STOPPING) {
                Log.w(TAG, "Already stopping stream");
                return;
            }
            mStreamState = StreamState.STOPPING;
        }

        Log.i(TAG, "Stopping streaming");
        forceStopStreamingInternal();
    }

    /**
     * Force stop streaming and clean up all resources
     * This method performs a complete cleanup regardless of current state
     */
    private void forceStopStreamingInternal() {
        Log.d(TAG, "Force stopping stream and cleaning up resources");

        // Increment reconnection sequence to invalidate any pending handlers
        mReconnectionSequence++;
        Log.d(TAG, "Stopping stream, invalidating reconnection handlers with new sequence: " + mReconnectionSequence);

        // Cancel any pending reconnects
        if (mReconnectHandler != null) {
            mReconnectHandler.removeCallbacksAndMessages(null);
        }

        // Cancel timeout timer
        cancelStreamTimeout();

        // Reset state flags
        mReconnecting = false;
        mReconnectAttempts = 0;

        // Stop the stream if we have a streamer
        if (mStreamer != null) {
            try {
                // Force stop the stream
                mStreamer.stopStream(new Continuation<kotlin.Unit>() {
                    @Override
                    public CoroutineContext getContext() {
                        return EmptyCoroutineContext.INSTANCE;
                    }

                    @Override
                    public void resumeWith(Object o) {
                        if (o instanceof Throwable) {
                            Log.e(TAG, "Error during stream stop", (Throwable)o);
                        }
                        Log.d(TAG, "Stream stop completed");
                    }
                });
            } catch (Exception e) {
                Log.e(TAG, "Exception stopping stream", e);
            }

            // Stop preview
            try {
                mStreamer.stopPreview();
                Log.d(TAG, "Camera preview stopped");
            } catch (Exception e) {
                Log.e(TAG, "Error stopping preview", e);
            }

            // Release the streamer completely
            try {
                mStreamer.release();
                Log.d(TAG, "Streamer released");
            } catch (Exception e) {
                Log.e(TAG, "Error releasing streamer", e);
            }

            mStreamer = null;
        }

        // Release surface
        releaseSurface();

        // Update state
        synchronized (mStateLock) {
            mStreamState = StreamState.IDLE;
            mIsStreaming = false;
            mIsStreamingActive = false;

            // Log stream ID being cleared for debugging
            if (mCurrentStreamId != null) {
                Log.d(TAG, "Clearing stream ID: " + mCurrentStreamId);
            }
            mCurrentStreamId = null;

            // Reset stream timing
            mStreamStartTime = 0;
            mLastReconnectionTime = 0;
        }

        // Notify listeners
        updateNotificationIfImportant();
        if (sStatusCallback != null) {
            sStatusCallback.onStreamStopped();
        }
        EventBus.getDefault().post(new StreamingEvent.Stopped());

        Log.i(TAG, "Streaming stopped and cleaned up");
    }

    /**
     * Schedule a reconnection attempt with exponential backoff
     * @param reason The reason for the reconnection
     */
    private void scheduleReconnect(String reason) {
        // Don't reconnect if we've reached the max attempts
        if (mReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            Log.w(TAG, "Maximum reconnection attempts reached, giving up.");
            EventBus.getDefault().post(new StreamingEvent.Error("Maximum reconnection attempts reached"));
            if (sStatusCallback != null) {
                // Only use onReconnectFailed to avoid duplicate error messages
                sStatusCallback.onReconnectFailed(MAX_RECONNECT_ATTEMPTS);
            }

            // Stop streaming completely when max attempts reached
            stopStreaming();
            return;
        }

        // Cancel any existing reconnect attempts
        if (mReconnectHandler != null) {
            mReconnectHandler.removeCallbacksAndMessages(null);
        }

        // Calculate delay with exponential backoff
        mReconnectAttempts++;
        long delay = calculateReconnectDelay(mReconnectAttempts);

        Log.d(TAG, "Scheduling reconnection attempt #" + mReconnectAttempts +
                " in " + delay + "ms (reason: " + reason + ")");

        if (sStatusCallback != null) {
            sStatusCallback.onReconnecting(mReconnectAttempts, MAX_RECONNECT_ATTEMPTS, reason);
        }

        mReconnecting = true;
        updateNotificationIfImportant();

        // Capture the current sequence ID
        final int currentSequence = mReconnectionSequence;

        // Schedule the reconnection
        mReconnectHandler.postDelayed(() -> {
            Log.d(TAG, "Executing reconnection attempt #" + mReconnectAttempts + " (sequence: " + currentSequence + ")");

            // Check if this is still the current reconnection sequence
            if (currentSequence != mReconnectionSequence) {
                Log.d(TAG, "Ignoring stale reconnection handler (expected sequence: " + mReconnectionSequence + ", got: " + currentSequence + ")");
                return;
            }

            // Reset state and mark that we're reconnecting
            synchronized (mStateLock) {
                // Only proceed if we're not already stopped
                if (mStreamState != StreamState.IDLE && mStreamState != StreamState.STOPPING) {
                    mStreamState = StreamState.IDLE;
                    mIsStreaming = false;
                    mReconnecting = true;
                    startStreaming();
                } else {
                    Log.d(TAG, "Stream was stopped during reconnection delay, cancelling reconnection");
                }
            }
        }, delay);
    }

    /**
     * Calculate the reconnect delay with exponential backoff
     *
     * @param attempt Current attempt number
     * @return Delay in milliseconds
     */
    private long calculateReconnectDelay(int attempt) {
        // Base delay * backoff multiplier^(attempt-1) + small random jitter
        double jitter = Math.random() * 0.3 * INITIAL_RECONNECT_DELAY_MS; // 0-30% of base delay
        return (long) (INITIAL_RECONNECT_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1) + jitter);
    }

    /**
     * Interface for monitoring streaming status changes
     */
    public interface StreamingStatusCallback {
        /**
         * Called when streaming is starting (connecting)
         *
         * @param rtmpUrl The URL being connected to
         */
        void onStreamStarting(String rtmpUrl);

        /**
         * Called when streaming has started successfully
         *
         * @param rtmpUrl The URL connected to
         */
        void onStreamStarted(String rtmpUrl);

        /**
         * Called when streaming has stopped
         */
        void onStreamStopped();

        /**
         * Called when a connection is lost and reconnection is being attempted
         *
         * @param attempt     Current reconnection attempt number
         * @param maxAttempts Maximum number of attempts that will be made
         * @param reason      Reason for reconnection
         */
        void onReconnecting(int attempt, int maxAttempts, String reason);

        /**
         * Called when reconnection was successful
         *
         * @param rtmpUrl The URL reconnected to
         * @param attempt The attempt number that succeeded
         */
        void onReconnected(String rtmpUrl, int attempt);

        /**
         * Called when all reconnection attempts have failed
         *
         * @param maxAttempts The maximum number of attempts that were made
         */
        void onReconnectFailed(int maxAttempts);

        /**
         * Called when a streaming error occurs
         *
         * @param error Error message
         */
        void onStreamError(String error);
    }

    /**
     * Register a callback to receive streaming status updates
     *
     * @param callback The callback to register, or null to unregister
     */
    public static void setStreamingStatusCallback(StreamingStatusCallback callback) {
        sStatusCallback = callback;
        Log.d(TAG, "Streaming status callback " + (callback != null ? "registered" : "unregistered"));
    }

    /**
     * Schedule a timeout for the current stream
     * @param streamId The stream ID to track
     */
    private void scheduleStreamTimeout(String streamId) {
        cancelStreamTimeout(); // Cancel any existing timeout

        mCurrentStreamId = streamId;
        mIsStreamingActive = true;

        mRtmpStreamTimeoutTimer = new Timer("RtmpStreamTimeout-" + streamId);
        mRtmpStreamTimeoutTimer.schedule(new TimerTask() {
            @Override
            public void run() {
                Log.w(TAG, "Stream timeout triggered for streamId: " + streamId);
                mTimeoutHandler.post(() -> handleStreamTimeout(streamId));
            }
        }, STREAM_TIMEOUT_MS);
    }


    /**
     * Handle stream timeout - stop streaming due to no keep-alive
     * @param streamId The stream ID that timed out
     */
    private void handleStreamTimeout(String streamId) {
        synchronized (mStateLock) {
            if (mCurrentStreamId != null && mCurrentStreamId.equals(streamId) && mIsStreamingActive) {
                Log.w(TAG, "Stream timed out due to missing keep-alive messages: " + streamId);

                // Notify about timeout
                EventBus.getDefault().post(new StreamingEvent.Error("Stream timed out - no keep-alive from cloud"));
                if (sStatusCallback != null) {
                    sStatusCallback.onStreamError("Stream timed out - no keep-alive from cloud");
                }

                // Force stop the stream immediately
                forceStopStreamingInternal();
            } else {
                Log.d(TAG, "Ignoring timeout for old stream: " + streamId +
                      " (current: " + mCurrentStreamId + ", active: " + mIsStreamingActive + ")");
            }
        }
    }

    /**
     * Cancel the current stream timeout
     */
    private void cancelStreamTimeout() {
        if (mRtmpStreamTimeoutTimer != null) {
            Log.d(TAG, "Cancelling stream timeout timer");
            mRtmpStreamTimeoutTimer.cancel();
            mRtmpStreamTimeoutTimer = null;
        }
        mIsStreamingActive = false;
        mCurrentStreamId = null;
    }


    /**
     * Static convenience methods for controlling streaming from anywhere in the app
     */

    /**
     * Start streaming to the specified RTMP URL
     * @param context Context to use for starting the service
     * @param rtmpUrl RTMP URL to stream to
     * @param streamId Stream ID for tracking (can be null)
     */
    public static void startStreaming(Context context, String rtmpUrl, String streamId) {
        // If service is running, send direct command
        if (sInstance != null) {
            // Cancel any pending reconnections first
            if (sInstance.mReconnectHandler != null) {
                sInstance.mReconnectHandler.removeCallbacksAndMessages(null);
            }

            // Reset reconnection state before starting new stream
            sInstance.mReconnectAttempts = 0;
            sInstance.mReconnecting = false;

            sInstance.setRtmpUrl(rtmpUrl);
            sInstance.mCurrentStreamId = streamId; // Set the stream ID
            sInstance.startStreaming();
        } else {
            // Start the service with the provided URL and stream ID
            Intent intent = new Intent(context, RtmpStreamingService.class);
            intent.putExtra("rtmp_url", rtmpUrl);
            if (streamId != null && !streamId.isEmpty()) {
                intent.putExtra("stream_id", streamId);
            }
            context.startService(intent);
        }
    }

    /**
     * Start streaming to the specified RTMP URL (legacy method without streamId)
     * @param context Context to use for starting the service
     * @param rtmpUrl RTMP URL to stream to
     */
    public static void startStreaming(Context context, String rtmpUrl) {
        startStreaming(context, rtmpUrl, null);
    }

    /**
     * Stop streaming
     * @param context Context to use for accessing the service
     */
    public static void stopStreaming(Context context) {
        // If service is running, send direct command
        if (sInstance != null) {
            sInstance.stopStreaming();
        } else {
            // Try to stop via EventBus (in case service is running but instance reference was lost)
            EventBus.getDefault().post(new StreamingCommand.Stop());
        }
    }

    /**
     * Check if streaming is active
     *
     * @return true if streaming, false if not or if service is not running
     */
    public static boolean isStreaming() {
        if (sInstance != null) {
            synchronized (sInstance.mStateLock) {
                return sInstance.mStreamState == StreamState.STREAMING ||
                       sInstance.mStreamState == StreamState.STARTING;
            }
        }
        return false;
    }

    /**
     * Check if the service is trying to reconnect
     *
     * @return true if reconnecting, false if not or if service is not running
     */
    public static boolean isReconnecting() {
        return sInstance != null && sInstance.mReconnecting;
    }

    /**
     * Get the current reconnection attempt count
     *
     * @return The number of reconnection attempts, or 0 if not reconnecting or service not running
     */
    public static int getReconnectAttempt() {
        return sInstance != null ? sInstance.mReconnectAttempts : 0;
    }

    /**
     * Start timeout tracking for a stream (static convenience method)
     * @param streamId The stream ID to track
     */
    public static void startStreamTimeout(String streamId) {
        if (sInstance != null) {
            sInstance.scheduleStreamTimeout(streamId);
        } else {
            Log.e(TAG, "Cannot start timeout tracking, sInstance is null");
        }
    }

    /**
     * Reset timeout for a stream (static convenience method)
     * @param streamId The stream ID that sent keep-alive
     * @return true if stream ID was valid and timeout was reset, false if unknown stream ID
     */
    public static boolean resetStreamTimeout(String streamId) {
        if (sInstance != null) {
            if (sInstance.mCurrentStreamId != null && sInstance.mCurrentStreamId.equals(streamId) && sInstance.mIsStreamingActive) {
                Log.d(TAG, "Resetting stream timeout for streamId: " + streamId);
                sInstance.scheduleStreamTimeout(streamId); // Reschedule with fresh timeout
                return true;
            } else {
                Log.w(TAG, "Received keep-alive for unknown or inactive stream: " + streamId +
                      " (current: " + sInstance.mCurrentStreamId + ", active: " + sInstance.mIsStreamingActive + ")");
                return false;
            }
        }
        return false;
    }

    /**
     * Determine if an error is retryable (network/connection) or fatal (config/permission)
     * @param error The StreamPackError to classify
     * @return true if the error should trigger reconnection attempts, false if it's fatal
     */
    private boolean isRetryableError(StreamPackError error) {
        String message = error.getMessage();
        if (message == null) {
            // Unknown error, default to retry
            return true;
        }

        // Log the error for debugging
        Log.d(TAG, "Classifying error: " + message);

        // Network/connection errors that should trigger reconnection
        if (message.contains("SocketException") ||
            message.contains("Connection") ||
            message.contains("Timeout") ||
            message.contains("Network") ||
            message.contains("UnknownHostException") ||
            message.contains("IOException") ||
            message.contains("ECONNREFUSED") ||
            message.contains("ETIMEDOUT")) {
            Log.d(TAG, "Error classified as RETRYABLE (network issue)");
            return true;
        }

        // Fatal errors that shouldn't retry
        if (message.contains("Permission") ||
            message.contains("permission") ||
            message.contains("Invalid URL") ||
            message.contains("invalid url") ||
            message.contains("Authentication") ||
            message.contains("authentication") ||
            message.contains("Unauthorized") ||
            message.contains("Codec") ||
            message.contains("codec") ||
            message.contains("Not supported") ||
            message.contains("Illegal") ||
            message.contains("Invalid parameter")) {
            Log.d(TAG, "Error classified as FATAL (configuration/permission issue)");
            return false;
        }

        // Camera-specific errors that are usually fatal
        if (message.contains("Camera") &&
            (message.contains("busy") ||
             message.contains("in use") ||
             message.contains("failed to connect"))) {
            Log.d(TAG, "Error classified as FATAL (camera unavailable)");
            return false;
        }

        // Default to retry for unknown errors
        Log.d(TAG, "Error classified as RETRYABLE (unknown error, defaulting to retry)");
        return true;
    }

    /**
     * Determine if an error message string is retryable (network/connection) or fatal (config/permission)
     * @param message The error message string to classify
     * @return true if the error should trigger reconnection attempts, false if it's fatal
     */
    private boolean isRetryableErrorString(String message) {
        if (message == null) {
            // Unknown error, default to retry
            return true;
        }

        // Log the error for debugging
        Log.d(TAG, "Classifying error message: " + message);

        // Network/connection errors that should trigger reconnection
        if (message.contains("SocketException") ||
            message.contains("Connection") ||
            message.contains("Timeout") ||
            message.contains("Network") ||
            message.contains("UnknownHostException") ||
            message.contains("IOException") ||
            message.contains("ECONNREFUSED") ||
            message.contains("ETIMEDOUT")) {
            Log.d(TAG, "Error classified as RETRYABLE (network issue)");
            return true;
        }

        // Fatal errors that shouldn't retry
        if (message.contains("Permission") ||
            message.contains("permission") ||
            message.contains("Invalid URL") ||
            message.contains("invalid url") ||
            message.contains("Authentication") ||
            message.contains("authentication") ||
            message.contains("Unauthorized") ||
            message.contains("Codec") ||
            message.contains("codec") ||
            message.contains("Not supported") ||
            message.contains("Illegal") ||
            message.contains("Invalid parameter")) {
            Log.d(TAG, "Error classified as FATAL (configuration/permission issue)");
            return false;
        }

        // Camera-specific errors that are usually fatal
        if (message.contains("Camera") &&
            (message.contains("busy") ||
             message.contains("in use") ||
             message.contains("failed to connect"))) {
            Log.d(TAG, "Error classified as FATAL (camera unavailable)");
            return false;
        }

        // Default to retry for unknown errors
        Log.d(TAG, "Error classified as RETRYABLE (unknown error, defaulting to retry)");
        return true;
    }

    /**
     * Wake up the screen to ensure camera can be accessed
     */
    private void wakeUpScreen() {
        Log.d(TAG, "Waking up screen for camera access");
        // Use the WakeLockManager to acquire both CPU and screen wake locks AND bring app to foreground
        // This prevents "Camera disabled by policy" errors when app is backgrounded
        // For streaming we use longer timeout for CPU wake lock than for photo capture
        WakeLockManager.acquireFullWakeLockAndBringToForeground(this, 180000, 5000); // 3 min CPU, 5 sec screen
    }

    /**
     * Release any held wake locks
     */
    private void releaseWakeLocks() {
        WakeLockManager.releaseAllWakeLocks();
    }

    /**
     * Attaches a PreviewView to the streamer for displaying camera preview
     * This is optional and only used if you want to show the preview in an activity
     * @param previewView the PreviewView to use for preview
     */
    public void attachPreview(PreviewView previewView) {
        if (mStreamer != null && previewView != null) {
            try {
                // Set the streamer on the PreviewView
                previewView.setStreamer(mStreamer);
                Log.d(TAG, "Preview view attached successfully");
            } catch (Exception e) {
                Log.e(TAG, "Error attaching preview", e);
                EventBus.getDefault().post(new StreamingEvent.Error("Failed to attach preview: " + e.getMessage()));
            }
        } else {
            Log.e(TAG, "Cannot attach preview: streamer or preview view is null");
        }
    }

    /**
     * Handle commands from other components
     */
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onStreamingCommand(StreamingCommand command) {
        if (command instanceof StreamingCommand.Start) {
            // Reset reconnection state on explicit start command
            mReconnectAttempts = 0;
            mReconnecting = false;
            startStreaming();
        } else if (command instanceof StreamingCommand.Stop) {
            stopStreaming();
        } else if (command instanceof StreamingCommand.SetRtmpUrl) {
            setRtmpUrl(((StreamingCommand.SetRtmpUrl) command).getRtmpUrl());
        }
    }

    /**
     * Get the current stream ID
     * @return The current stream ID, or null if no stream is active
     */
    public static String getCurrentStreamId() {
        return sInstance != null ? sInstance.mCurrentStreamId : null;
    }

    /**
     * Format duration in milliseconds to human-readable format
     * @param durationMs Duration in milliseconds
     * @return Formatted duration string (e.g., "5m 23s", "1h 15m 30s")
     */
    private static String formatDuration(long durationMs) {
        if (durationMs < 0) return "0s";

        long seconds = durationMs / 1000;
        long minutes = seconds / 60;
        long hours = minutes / 60;

        seconds = seconds % 60;
        minutes = minutes % 60;

        if (hours > 0) {
            return String.format("%dh %dm %ds", hours, minutes, seconds);
        } else if (minutes > 0) {
            return String.format("%dm %ds", minutes, seconds);
        } else {
            return String.format("%ds", seconds);
        }
    }
}
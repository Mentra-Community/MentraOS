package com.augmentos.asg_client.streaming;

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
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

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
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;

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
    private static final int SURFACE_WIDTH = 640;
    private static final int SURFACE_HEIGHT = 480;

    // Reconnection logic parameters
    private int mReconnectAttempts = 0;
    private static final int MAX_RECONNECT_ATTEMPTS = 10;
    private static final long INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
    private static final float BACKOFF_MULTIPLIER = 1.5f;
    private Handler mReconnectHandler;
    private boolean mReconnecting = false;

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

        // Initialize the streamer
        initStreamer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Start as a foreground service with notification
        startForeground(NOTIFICATION_ID, createNotification());

        // Get RTMP URL from intent if provided
        if (intent != null) {
            String rtmpUrl = intent.getStringExtra("rtmp_url");
            if (rtmpUrl != null && !rtmpUrl.isEmpty()) {
                setRtmpUrl(rtmpUrl);

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

        stopStreaming();
        releaseStreamer();

        // Release the surface
        releaseSurface();

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
        if (mStreamer != null) {
            releaseStreamer();
        }

        try {
            Log.d(TAG, "Initializing streamer");

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
                            if (sStatusCallback != null) {
                                sStatusCallback.onStreamError("Streaming error: " + error.getMessage());
                            }
                            // Don't stop streaming on errors - let the reconnect logic handle it
                            scheduleReconnect("stream_error");
                        }
                    },
                    new OnConnectionListener() {
                        @Override
                        public void onSuccess() {
                            Log.i(TAG, "RTMP connection successful");
                            // Reset reconnect attempts when we get a successful connection
                            mReconnectAttempts = 0;
                            mReconnecting = false;
                            updateNotification();
                            EventBus.getDefault().post(new StreamingEvent.Connected());
                        }

                        @Override
                        public void onFailed(String message) {
                            Log.e(TAG, "RTMP connection failed: " + message);
                            EventBus.getDefault().post(new StreamingEvent.ConnectionFailed(message));
                            // Schedule reconnect on connection failure
                            scheduleReconnect("connection_failed");
                        }

                        @Override
                        public void onLost(String message) {
                            Log.i(TAG, "RTMP connection lost: " + message);
                            EventBus.getDefault().post(new StreamingEvent.Disconnected());
                            // Schedule reconnect on connection loss
                            scheduleReconnect("connection_lost");
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
        if (mStreamer != null) {
            try {
                if (mIsStreaming) {
                    stopStreaming();
                }

                mStreamer.stopPreview();
                mStreamer.release();
                mStreamer = null;
                Log.i(TAG, "Streamer released");
            } catch (Exception e) {
                Log.e(TAG, "Error releasing streamer", e);
                if (sStatusCallback != null) {
                    sStatusCallback.onStreamError("Error releasing streamer: " + e.getMessage());
                }
            }
        }
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
    public void startStreaming() {
        if (mStreamer == null) {
            String error = "Streamer not initialized";
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

        if (mIsStreaming && !mReconnecting) {
            Log.i(TAG, "Already streaming");
            return;
        }

        try {
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

            // For Kotlin's suspend functions, we need to provide a Continuation
            mStreamer.startStream(mRtmpUrl, new Continuation<kotlin.Unit>() {
                @Override
                public CoroutineContext getContext() {
                    return EmptyCoroutineContext.INSTANCE;
                }

                @Override
                public void resumeWith(Object o) {
                    if (o instanceof Throwable) {
                        String errorMsg = "Failed to start streaming: " + ((Throwable) o).getMessage();
                        Log.e(TAG, "Error starting stream", (Throwable)o);
                        EventBus.getDefault().post(new StreamingEvent.Error(errorMsg));
                        if (sStatusCallback != null) {
                            sStatusCallback.onStreamError(errorMsg);
                        }
                        // Schedule reconnect if we couldn't start the stream
                        scheduleReconnect("start_error");
                    } else {
                        mIsStreaming = true;
                        updateNotification();
                        if (mReconnecting) {
                            Log.i(TAG, "Successfully reconnected to " + mRtmpUrl);
                            if (sStatusCallback != null) {
                                sStatusCallback.onReconnected(mRtmpUrl, mReconnectAttempts);
                            }
                            mReconnecting = false;
                        } else {
                            Log.i(TAG, "Streaming started to " + mRtmpUrl);
                            if (sStatusCallback != null) {
                                sStatusCallback.onStreamStarted(mRtmpUrl);
                            }
                        }
                        EventBus.getDefault().post(new StreamingEvent.Started());
                    }
                }
            });
        } catch (Exception e) {
            String errorMsg = "Failed to start streaming: " + e.getMessage();
            Log.e(TAG, errorMsg, e);
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
        // Cancel any pending reconnects when explicitly stopping
        if (mReconnectHandler != null) {
            mReconnectHandler.removeCallbacksAndMessages(null);
        }

        if (mStreamer != null && mIsStreaming) {
            try {
                Log.i(TAG, "Stopping streaming");

                // For Kotlin's suspend functions, we need to provide a Continuation
                mStreamer.stopStream(new Continuation<kotlin.Unit>() {
                    @Override
                    public CoroutineContext getContext() {
                        return EmptyCoroutineContext.INSTANCE;
                    }

                    @Override
                    public void resumeWith(Object o) {
                        if (o instanceof Throwable) {
                            String errorMsg = "Failed to stop streaming: " + ((Throwable) o).getMessage();
                            Log.e(TAG, "Error stopping stream", (Throwable)o);
                            EventBus.getDefault().post(new StreamingEvent.Error(errorMsg));
                            if (sStatusCallback != null) {
                                sStatusCallback.onStreamError(errorMsg);
                            }
                        } else {
                            mIsStreaming = false;
                            mReconnecting = false;
                            updateNotification();
                            Log.i(TAG, "Streaming stopped");
                            if (sStatusCallback != null) {
                                sStatusCallback.onStreamStopped();
                            }
                            EventBus.getDefault().post(new StreamingEvent.Stopped());
                        }
                    }
                });
            } catch (Exception e) {
                String errorMsg = "Failed to stop streaming: " + e.getMessage();
                Log.e(TAG, errorMsg, e);
                EventBus.getDefault().post(new StreamingEvent.Error(errorMsg));
                if (sStatusCallback != null) {
                    sStatusCallback.onStreamError(errorMsg);
                }
                mIsStreaming = false;
                mReconnecting = false;
                updateNotification();
            }
        } else if (sStatusCallback != null) {
            // Still notify that streaming is stopped even if it wasn't running
            sStatusCallback.onStreamStopped();
        }
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
                sStatusCallback.onReconnectFailed(MAX_RECONNECT_ATTEMPTS);
            }
            mIsStreaming = false;
            mReconnecting = false;
            updateNotification();
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
        updateNotification();

        // Schedule the reconnection
        mReconnectHandler.postDelayed(() -> {
            Log.d(TAG, "Executing reconnection attempt #" + mReconnectAttempts);
            // Mark that we're reconnecting so startStreaming knows
            mIsStreaming = false;
            mReconnecting = true;
            startStreaming();
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
     * Static convenience methods for controlling streaming from anywhere in the app
     */

    /**
     * Start streaming to the specified RTMP URL
     * @param context Context to use for starting the service
     * @param rtmpUrl RTMP URL to stream to
     */
    public static void startStreaming(Context context, String rtmpUrl) {
        // If service is running, send direct command
        if (sInstance != null) {
            sInstance.setRtmpUrl(rtmpUrl);
            sInstance.startStreaming();
        } else {
            // Start the service with the provided URL
            Intent intent = new Intent(context, RtmpStreamingService.class);
            intent.putExtra("rtmp_url", rtmpUrl);
            context.startService(intent);
        }
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
        return sInstance != null && sInstance.mIsStreaming;
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
}
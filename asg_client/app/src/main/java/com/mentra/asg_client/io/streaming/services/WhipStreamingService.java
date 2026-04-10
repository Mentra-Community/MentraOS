package com.mentra.asg_client.io.streaming.services;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.camera.CameraNeo;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.utils.WakeLockManager;

import org.webrtc.RTCStats;
import org.webrtc.RTCStatsCollectorCallback;
import org.webrtc.RTCStatsReport;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpParameters;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Timer;
import java.util.TimerTask;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * WHIP (WebRTC-HTTP Ingest Protocol) streaming service.
 *
 * Flow:
 *   1. Create PeerConnection with video/audio tracks
 *   2. Create SDP offer and set as local description (triggers ICE gathering)
 *   3. Wait for ICE gathering to complete so all candidates are embedded in SDP
 *   4. HTTP POST the offer SDP to the WHIP URL
 *   5. Server responds 201 with SDP answer (and optionally a Location header)
 *   6. Set answer as remote description → streaming begins
 *   7. On stop, HTTP DELETE the WHIP resource URL (if provided)
 *
 * Public API mirrors RtmpStreamingService for consistent usage:
 *   WhipStreamingService.startStreaming(context, whipUrl, streamId, enableLed, enableSound, config)
 *   WhipStreamingService.stopStreaming(context)
 *   WhipStreamingService.isStreaming()
 */
@SuppressLint("MissingPermission")
public class WhipStreamingService extends Service {

  private static final String TAG = "WhipStreamingService";
  private static final String CHANNEL_ID = "WhipStreamingChannel";
  private static final int NOTIFICATION_ID = 8891;

  // Static instance so static helper methods can reach the running service
  private static WhipStreamingService sInstance;
  private static StreamingStatusCallback sStatusCallback;
  private static WhipStreamConfig sPendingStreamConfig = null;

  // Guard: PeerConnectionFactory.initialize() registers a BroadcastReceiver and must only be
  // called once per process to avoid the NetworkMonitorAutoDetect IntentReceiver leak.
  private static boolean sPeerConnectionFactoryInitialized = false;

  // Stream parameters
  private String mWhipUrl;
  /** Resource URL returned by the WHIP server in the Location header, used for teardown. */
  private String mWhipResourceUrl;
  private String mCurrentStreamId;
  private boolean mLedEnabled = false;
  private boolean mSoundEnabled = false;

  // Current stream configuration
  private WhipStreamConfig mStreamConfig = new WhipStreamConfig();

  // ---- WebRTC components ----
  private EglBase mEglBase;
  private PeerConnectionFactory mPeerConnectionFactory;
  private PeerConnection mPeerConnection;
  private VideoSource mVideoSource;
  private AudioSource mAudioSource;
  private VideoTrack mVideoTrack;
  private AudioTrack mAudioTrack;
  private VideoCapturer mVideoCapturer;
  private SurfaceTextureHelper mSurfaceTextureHelper;

  // HTTP client for WHIP signaling
  private OkHttpClient mHttpClient;

  private IHardwareManager mHardwareManager;

  // ---- State management ----
  private enum StreamState { IDLE, STARTING, STREAMING, STOPPING, RECONNECTING }
  private volatile StreamState mStreamState = StreamState.IDLE;
  private final Object mStateLock = new Object();

  // ---- Stream timeout (keep-alive) ----
  private static final long STREAM_TIMEOUT_MS = 60000; // 60 seconds
  private Timer mStreamTimeoutTimer;

  // ---- Battery monitoring ----
  private static IStateManager sStateManager;
  private Handler mBatteryMonitorHandler;
  private Runnable mBatteryCheckRunnable;

  // ---- Reconnection ----
  private static final int MAX_RECONNECT_ATTEMPTS = 3;
  private static final long RECONNECT_DELAY_MS = 3000;
  private int mReconnectAttempts = 0;
  private volatile boolean mIsReconnecting = false;

  private Handler mMainHandler;

  private static final long STATS_INTERVAL_MS = 2000;
  private long mLastVideoBytesSent = 0;
  private long mLastAudioBytesSent = 0;
  private final Runnable mStatsRunnable = new Runnable() {
    @Override
    public void run() {
      if (mPeerConnection == null) return;
      mPeerConnection.getStats(report -> {
        long videoBytesTotal = 0, audioBytesTotal = 0;
        long videoPackets = 0, audioPackets = 0;
        for (RTCStats stats : report.getStatsMap().values()) {
          if (!"outbound-rtp".equals(stats.getType())) continue;
          Object kind  = stats.getMembers().get("kind");
          Object bytes = stats.getMembers().get("bytesSent");
          Object pkts  = stats.getMembers().get("packetsSent");
          if (bytes == null) continue;
          long b = ((Number) bytes).longValue();
          long p = pkts != null ? ((Number) pkts).longValue() : 0;
          if ("video".equals(kind)) { videoBytesTotal = b; videoPackets = p; }
          else if ("audio".equals(kind)) { audioBytesTotal = b; audioPackets = p; }
        }
        long videoDelta = videoBytesTotal - mLastVideoBytesSent;
        long audioDelta = audioBytesTotal - mLastAudioBytesSent;
        mLastVideoBytesSent = videoBytesTotal;
        mLastAudioBytesSent = audioBytesTotal;
        Log.d(TAG, String.format(
            "↑ video: %d B/s (%d pkts total)  audio: %d B/s (%d pkts total)",
            videoDelta * 1000 / STATS_INTERVAL_MS, videoPackets,
            audioDelta * 1000 / STATS_INTERVAL_MS, audioPackets));
      });
      mMainHandler.postDelayed(this, STATS_INTERVAL_MS);
    }
  };

  // -----------------------------------------------------------------------
  // Android Service lifecycle
  // -----------------------------------------------------------------------

  @Override
  public void onCreate() {
    super.onCreate();
    sInstance = this;

    if (sPendingStreamConfig != null) {
      mStreamConfig = sPendingStreamConfig;
      sPendingStreamConfig = null;
      Log.d(TAG, "Applied pending stream config: " + mStreamConfig);
    }

    mMainHandler = new Handler(Looper.getMainLooper());
    mHttpClient = new OkHttpClient();
    mHardwareManager = HardwareManagerFactory.getInstance(this);

    createNotificationChannel();
    Log.d(TAG, "WhipStreamingService created");
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    startForeground(NOTIFICATION_ID, createNotification("Ready to stream"));

    if (intent != null) {
      String whipUrl = intent.getStringExtra("whip_url");
      String streamId = intent.getStringExtra("stream_id");
      mLedEnabled = intent.getBooleanExtra("enable_led", true);
      mSoundEnabled = intent.getBooleanExtra("enable_sound", true);

      if (whipUrl != null && !whipUrl.isEmpty()) {
        mWhipUrl = whipUrl;
        if (streamId != null && !streamId.isEmpty()) {
          mCurrentStreamId = streamId;
        }
        mMainHandler.postDelayed(this::startStreaming, 500);
      }
    }

    return START_STICKY;
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    if (sInstance == this) {
      sInstance = null;
    }
    stopStreaming();
    Log.d(TAG, "WhipStreamingService destroyed");
    super.onDestroy();
  }

  // -----------------------------------------------------------------------
  // Core streaming logic
  // -----------------------------------------------------------------------

  /** Start streaming to the currently configured WHIP URL. */
  private void startStreaming() {
    // Check if camera is busy with photo/video capture
    if (CameraNeo.isCameraInUse()) {
      Log.e(TAG, "Cannot start WHIP stream - camera is busy with photo/video capture");
      notifyError("camera_busy");
      // If we were reconnecting, reset state so we don't get stuck in RECONNECTING
      if (mIsReconnecting) {
        mIsReconnecting = false;
        mReconnectAttempts = 0;
        resetState();
        notifyStopped();
      }
      return;
    }

    synchronized (mStateLock) {
      if (mStreamState != StreamState.IDLE && mStreamState != StreamState.RECONNECTING) {
        Log.w(TAG, "startStreaming() called in state " + mStreamState + ", ignoring");
        return;
      }
      mStreamState = StreamState.STARTING;
    }

    // Acquire wake lock to prevent device sleep during streaming
    WakeLockManager.acquireFullWakeLockAndBringToForeground(
        getApplicationContext(), 2180000, 5000);

    if (!mIsReconnecting) {
      mReconnectAttempts = 0;
    }

    Log.d(TAG, (mIsReconnecting ? "Re-starting" : "Starting") + " WHIP streaming to " + mWhipUrl);
    if (!mIsReconnecting) notifyStarting(mWhipUrl);
    updateNotification(mIsReconnecting ? "Reconnecting…" : "Connecting…");

    try {
      initWebRtc();
      setupCamera();
      setupAudio();
      createPeerConnectionAndOffer();
    } catch (Exception e) {
      Log.e(TAG, "Failed to start streaming", e);
      notifyError("Failed to start: " + e.getMessage());
      resetState();
    }
  }

  /** Stop the active stream and release all WebRTC resources. */
  private void stopStreaming() {
    stopStreaming(false);
  }

  private void stopStreaming(boolean forReconnect) {
    synchronized (mStateLock) {
      if (mStreamState == StreamState.IDLE || mStreamState == StreamState.STOPPING) {
        return;
      }
      mStreamState = StreamState.STOPPING;
    }

    mMainHandler.removeCallbacks(mStatsRunnable);
    cancelStreamTimeout();
    stopBatteryMonitoring();
    Log.d(TAG, "Stopping WHIP streaming (forReconnect=" + forReconnect + ")");

    if (mWhipResourceUrl != null) {
      deleteWhipResource(mWhipResourceUrl);
      mWhipResourceUrl = null;
    }

    releaseWebRtc();

    if (forReconnect) {
      synchronized (mStateLock) {
        mStreamState = StreamState.RECONNECTING;
      }
    } else {
      if (mLedEnabled && mHardwareManager != null && mHardwareManager.supportsRecordingLed()) {
        mHardwareManager.setRecordingLedOff();
      }
      if (mSoundEnabled && mHardwareManager != null && mHardwareManager.supportsAudioPlayback()) {
        mHardwareManager.playAudioAsset(AudioAssets.VIDEO_RECORDING_STOP);
      }
      mIsReconnecting = false;
      mReconnectAttempts = 0;
      WakeLockManager.releaseAllWakeLocks();
      resetState();
      notifyStopped();
      updateNotification("Stream stopped");
    }
    Log.d(TAG, "WHIP streaming stopped");
  }

  /** Attempt to reconnect after a connection failure. */
  private void attemptReconnect(String reason) {
    mReconnectAttempts++;
    if (mReconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      Log.w(TAG, "WHIP max reconnect attempts reached (" + MAX_RECONNECT_ATTEMPTS + ")");
      mIsReconnecting = false;
      mReconnectAttempts = 0;
      notifyReconnectFailed(MAX_RECONNECT_ATTEMPTS);
      stopStreaming(false);
      return;
    }

    mIsReconnecting = true;
    Log.d(TAG, "WHIP reconnect attempt " + mReconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS + " in " + RECONNECT_DELAY_MS + "ms");
    notifyReconnecting(mReconnectAttempts, MAX_RECONNECT_ATTEMPTS, reason);

    stopStreaming(true);

    mMainHandler.postDelayed(() -> {
      Log.d(TAG, "WHIP executing reconnect attempt " + mReconnectAttempts);
      startStreaming();
    }, RECONNECT_DELAY_MS);
  }

  // -----------------------------------------------------------------------
  // WebRTC initialisation
  // -----------------------------------------------------------------------

  private void initWebRtc() {
    if (!sPeerConnectionFactoryInitialized) {
      PeerConnectionFactory.InitializationOptions initOptions =
          PeerConnectionFactory.InitializationOptions.builder(this)
              .setEnableInternalTracer(false)
              .createInitializationOptions();
      PeerConnectionFactory.initialize(initOptions);
      sPeerConnectionFactoryInitialized = true;
    }

    mEglBase = EglBase.create();

    PeerConnectionFactory.Options factoryOptions = new PeerConnectionFactory.Options();
    mPeerConnectionFactory = PeerConnectionFactory.builder()
        .setOptions(factoryOptions)
        .setVideoEncoderFactory(
            new DefaultVideoEncoderFactory(mEglBase.getEglBaseContext(), true, false))
        .setVideoDecoderFactory(
            new DefaultVideoDecoderFactory(mEglBase.getEglBaseContext()))
        .createPeerConnectionFactory();

    Log.d(TAG, "PeerConnectionFactory created");
  }

  private void setupCamera() {
    mVideoCapturer = new WhipCameraCapturer();

    mSurfaceTextureHelper = SurfaceTextureHelper.create(
        "WhipCaptureThread", mEglBase.getEglBaseContext());

    mVideoSource = mPeerConnectionFactory.createVideoSource(false);
    mVideoCapturer.initialize(mSurfaceTextureHelper, this, mVideoSource.getCapturerObserver());
    mVideoCapturer.startCapture(
        mStreamConfig.getVideoWidth(),
        mStreamConfig.getVideoHeight(),
        mStreamConfig.getVideoFps());

    mVideoTrack = mPeerConnectionFactory.createVideoTrack("video0", mVideoSource);
    mVideoTrack.setEnabled(true);

    Log.d(TAG, "Camera capture started: "
        + mStreamConfig.getVideoWidth() + "x" + mStreamConfig.getVideoHeight()
        + " @" + mStreamConfig.getVideoFps() + "fps");
  }

  private void setupAudio() {
    MediaConstraints audioConstraints = new MediaConstraints();
    audioConstraints.mandatory.add(new MediaConstraints.KeyValuePair(
        "googEchoCancellation", String.valueOf(mStreamConfig.isEchoCancellation())));
    audioConstraints.mandatory.add(new MediaConstraints.KeyValuePair(
        "googNoiseSuppression", String.valueOf(mStreamConfig.isNoiseSuppression())));
    audioConstraints.mandatory.add(new MediaConstraints.KeyValuePair(
        "googHighpassFilter", "false"));

    mAudioSource = mPeerConnectionFactory.createAudioSource(audioConstraints);
    mAudioTrack = mPeerConnectionFactory.createAudioTrack("audio0", mAudioSource);
    mAudioTrack.setEnabled(true);

    Log.d(TAG, "Audio source created");
  }

  private void createPeerConnectionAndOffer() {
    // No STUN/TURN needed for WHIP: we connect outbound to a known server,
    // so host candidates (local IP) are sufficient. STUN only adds latency here.
    List<PeerConnection.IceServer> iceServers = new ArrayList<>();

    PeerConnection.RTCConfiguration rtcConfig =
        new PeerConnection.RTCConfiguration(iceServers);
    rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
    rtcConfig.continualGatheringPolicy =
        PeerConnection.ContinualGatheringPolicy.GATHER_ONCE;

    mPeerConnection = mPeerConnectionFactory.createPeerConnection(
        rtcConfig, new WhipPeerConnectionObserver());

    if (mPeerConnection == null) {
      throw new IllegalStateException("Failed to create PeerConnection");
    }

    mPeerConnection.addTrack(mVideoTrack);
    mPeerConnection.addTrack(mAudioTrack);

    for (RtpTransceiver transceiver : mPeerConnection.getTransceivers()) {
      transceiver.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY);
    }

    // Apply bitrate cap and degradation preference to reduce encoder thermal load.
    // Without this, the hardware encoder runs uncapped and overheats the SoC.
    applyBitrateConstraints();

    MediaConstraints sdpConstraints = new MediaConstraints();
    mPeerConnection.createOffer(new SdpObserver() {
      @Override
      public void onCreateSuccess(SessionDescription offer) {
        mPeerConnection.setLocalDescription(new SdpObserver() {
          @Override
          public void onSetSuccess() {
            Log.d(TAG, "Local description set, waiting for ICE gathering");
          }

          @Override
          public void onSetFailure(String error) {
            Log.e(TAG, "setLocalDescription failed: " + error);
            notifyError("setLocalDescription failed: " + error);
            resetState();
          }

          @Override public void onCreateSuccess(SessionDescription sdp) {}
          @Override public void onCreateFailure(String error) {}
        }, offer);
      }

      @Override
      public void onCreateFailure(String error) {
        Log.e(TAG, "createOffer failed: " + error);
        notifyError("createOffer failed: " + error);
        resetState();
      }

      @Override public void onSetSuccess() {}
      @Override public void onSetFailure(String error) {}
    }, sdpConstraints);
  }

  /**
   * Cap the video encoder bitrate via RTP sender parameters and set degradation
   * preference to MAINTAIN_FRAMERATE so WebRTC drops quality-per-frame instead of
   * frame rate when thermals get tight.
   */
  private void applyBitrateConstraints() {
    for (RtpSender sender : mPeerConnection.getSenders()) {
      if (sender.track() == null) continue;
      if (!"video".equals(sender.track().kind())) continue;

      RtpParameters params = sender.getParameters();
      if (params == null) continue;

      params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE;

      for (RtpParameters.Encoding encoding : params.encodings) {
        encoding.maxBitrateBps = mStreamConfig.getVideoBitrate();
      }

      sender.setParameters(params);
      Log.i(TAG, "Applied video bitrate cap: " + (mStreamConfig.getVideoBitrate() / 1000)
          + " kbps, degradation: MAINTAIN_FRAMERATE");
    }
  }

  // -----------------------------------------------------------------------
  // WHIP HTTP signaling
  // -----------------------------------------------------------------------

  private void postOfferToWhip(SessionDescription offer) {
    Log.d(TAG, "POSTing SDP offer to WHIP URL: " + mWhipUrl);

    RequestBody body = RequestBody.create(
        offer.description, MediaType.parse("application/sdp"));

    Request request = new Request.Builder()
        .url(mWhipUrl)
        .post(body)
        .addHeader("Content-Type", "application/sdp")
        .build();

    mHttpClient.newCall(request).enqueue(new Callback() {
      @Override
      public void onResponse(Call call, Response response) throws IOException {
        if (response.code() != 201) {
          String msg = "WHIP server returned " + response.code();
          Log.e(TAG, msg);
          notifyError(msg);
          resetState();
          return;
        }

        String location = response.header("Location");
        if (location != null) {
          mWhipResourceUrl = location.startsWith("http")
              ? location
              : buildAbsoluteUrl(mWhipUrl, location);
          Log.d(TAG, "WHIP resource URL: " + mWhipResourceUrl);
        }

        String answerSdp = response.body() != null ? response.body().string() : "";
        if (answerSdp.isEmpty()) {
          notifyError("WHIP server returned empty SDP answer");
          resetState();
          return;
        }

        SessionDescription answer = new SessionDescription(
            SessionDescription.Type.ANSWER, answerSdp);

        mPeerConnection.setRemoteDescription(new SdpObserver() {
          @Override
          public void onSetSuccess() {
            synchronized (mStateLock) {
              mStreamState = StreamState.STREAMING;
            }
            mLastVideoBytesSent = 0;
            mLastAudioBytesSent = 0;
            mMainHandler.postDelayed(mStatsRunnable, STATS_INTERVAL_MS);
            scheduleStreamTimeout(mCurrentStreamId);
            startBatteryMonitoring();
            Log.d(TAG, "Streaming started via WHIP");
            if (mLedEnabled && mHardwareManager != null && mHardwareManager.supportsRecordingLed()) {
              mHardwareManager.setRecordingLedOn();
            }
            if (mSoundEnabled && mHardwareManager != null && mHardwareManager.supportsAudioPlayback()) {
              mHardwareManager.playAudioAsset(AudioAssets.VIDEO_RECORDING_START);
            }
            if (mIsReconnecting) {
              int attempt = mReconnectAttempts;
              mIsReconnecting = false;
              mReconnectAttempts = 0;
              notifyReconnected(mWhipUrl, attempt);
            } else {
              notifyStarted(mWhipUrl);
            }
            updateNotification("Streaming");
          }

          @Override
          public void onSetFailure(String error) {
            Log.e(TAG, "setRemoteDescription failed: " + error);
            notifyError("setRemoteDescription failed: " + error);
            resetState();
          }

          @Override public void onCreateSuccess(SessionDescription sdp) {}
          @Override public void onCreateFailure(String error) {}
        }, answer);
      }

      @Override
      public void onFailure(Call call, IOException e) {
        Log.e(TAG, "WHIP request failed", e);
        notifyError("WHIP request failed: " + e.getMessage());
        resetState();
      }
    });
  }

  private void deleteWhipResource(String resourceUrl) {
    Request request = new Request.Builder()
        .url(resourceUrl)
        .delete()
        .build();

    mHttpClient.newCall(request).enqueue(new Callback() {
      @Override
      public void onResponse(Call call, Response response) {
        Log.d(TAG, "WHIP DELETE returned " + response.code());
      }

      @Override
      public void onFailure(Call call, IOException e) {
        Log.w(TAG, "WHIP DELETE failed (non-critical)", e);
      }
    });
  }

  // -----------------------------------------------------------------------
  // PeerConnection observer
  // -----------------------------------------------------------------------

  private class WhipPeerConnectionObserver implements PeerConnection.Observer {

    @Override
    public void onIceGatheringChange(PeerConnection.IceGatheringState newState) {
      Log.d(TAG, "ICE gathering state: " + newState);
      if (newState == PeerConnection.IceGatheringState.COMPLETE) {
        synchronized (mStateLock) {
          if (mPeerConnection == null || mStreamState == StreamState.STOPPING || mStreamState == StreamState.IDLE) {
            Log.w(TAG, "ICE gathering complete but stream already stopping/stopped, ignoring");
            return;
          }
        }
        SessionDescription localSdp = mPeerConnection.getLocalDescription();
        if (localSdp != null) {
          postOfferToWhip(localSdp);
        } else {
          Log.e(TAG, "ICE gathering complete but local SDP is null");
          notifyError("Local SDP unavailable after ICE gathering");
          resetState();
        }
      }
    }

    @Override
    public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
      Log.d(TAG, "PeerConnection state: " + newState);
      if (newState == PeerConnection.PeerConnectionState.FAILED) {
        mMainHandler.post(() -> attemptReconnect("PeerConnection failed"));
      } else if (newState == PeerConnection.PeerConnectionState.DISCONNECTED) {
        Log.w(TAG, "PeerConnection disconnected — waiting before reconnect");
        mMainHandler.postDelayed(() -> {
          synchronized (mStateLock) {
            if (mStreamState != StreamState.STREAMING) return;
          }
          attemptReconnect("PeerConnection disconnected");
        }, 2000);
      }
    }

    @Override
    public void onSignalingChange(PeerConnection.SignalingState signalingState) {
      Log.d(TAG, "Signaling state: " + signalingState);
    }

    @Override
    public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
      Log.d(TAG, "ICE connection state: " + iceConnectionState);
    }

    @Override public void onIceConnectionReceivingChange(boolean receiving) {}
    @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
    @Override public void onIceCandidate(IceCandidate candidate) {}
    @Override public void onAddStream(MediaStream stream) {}
    @Override public void onRemoveStream(MediaStream stream) {}
    @Override public void onDataChannel(DataChannel dataChannel) {}
    @Override public void onRenegotiationNeeded() {}
    @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] mediaStreams) {}
    @Override public void onTrack(RtpTransceiver transceiver) {}
  }

  // -----------------------------------------------------------------------
  // Resource release
  // -----------------------------------------------------------------------

  private void releaseWebRtc() {
    if (mVideoCapturer != null) {
      try { mVideoCapturer.stopCapture(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
      mVideoCapturer.dispose();
      mVideoCapturer = null;
    }
    synchronized (mStateLock) {
      if (mPeerConnection != null) {
        mPeerConnection.close();
        mPeerConnection = null;
      }
    }
    if (mVideoTrack != null) { mVideoTrack.dispose(); mVideoTrack = null; }
    if (mAudioTrack != null) { mAudioTrack.dispose(); mAudioTrack = null; }
    if (mVideoSource != null) { mVideoSource.dispose(); mVideoSource = null; }
    if (mAudioSource != null) { mAudioSource.dispose(); mAudioSource = null; }
    if (mSurfaceTextureHelper != null) { mSurfaceTextureHelper.dispose(); mSurfaceTextureHelper = null; }
    if (mPeerConnectionFactory != null) { mPeerConnectionFactory.dispose(); mPeerConnectionFactory = null; }
    if (mEglBase != null) { mEglBase.release(); mEglBase = null; }
    mWhipResourceUrl = null;
    Log.d(TAG, "WebRTC resources released");
  }

  private void resetState() {
    synchronized (mStateLock) {
      mStreamState = StreamState.IDLE;
    }
  }

  // -----------------------------------------------------------------------
  // Status callbacks
  // -----------------------------------------------------------------------

  private void notifyStarting(String url) {
    if (sStatusCallback != null) mMainHandler.post(() -> sStatusCallback.onStreamStarting(url, mCurrentStreamId));
  }

  private void notifyStarted(String url) {
    if (sStatusCallback != null) mMainHandler.post(() -> sStatusCallback.onStreamStarted(url, mCurrentStreamId));
  }

  private void notifyStopped() {
    if (sStatusCallback != null) mMainHandler.post(() -> sStatusCallback.onStreamStopped(mCurrentStreamId));
  }

  private void notifyReconnecting(int attempt, int maxAttempts, String reason) {
    if (sStatusCallback != null) mMainHandler.post(() -> sStatusCallback.onReconnecting(attempt, maxAttempts, reason, mCurrentStreamId));
  }

  private void notifyReconnected(String url, int attempt) {
    if (sStatusCallback != null) mMainHandler.post(() -> sStatusCallback.onReconnected(url, attempt, mCurrentStreamId));
  }

  private void notifyReconnectFailed(int maxAttempts) {
    if (sStatusCallback != null) mMainHandler.post(() -> sStatusCallback.onReconnectFailed(maxAttempts, mCurrentStreamId));
  }

  private void notifyError(String error) {
    if (sStatusCallback != null) mMainHandler.post(() -> sStatusCallback.onStreamError(error, mCurrentStreamId));
  }

  // -----------------------------------------------------------------------
  // Notification helpers
  // -----------------------------------------------------------------------

  private void createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "WHIP Streaming Service", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("Shows when the app is streaming via WHIP");
      channel.enableLights(true);
      channel.setLightColor(Color.GREEN);
      NotificationManager manager = getSystemService(NotificationManager.class);
      if (manager != null) manager.createNotificationChannel(channel);
    }
  }

  private Notification createNotification(String status) {
    return new NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("MentraOS WHIP Streaming")
        .setContentText(status)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build();
  }

  private void updateNotification(String status) {
    NotificationManager manager =
        (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(NOTIFICATION_ID, createNotification(status));
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  private String buildAbsoluteUrl(String base, String location) {
    try {
      java.net.URL baseUrl = new java.net.URL(base);
      return new java.net.URL(baseUrl, location).toString();
    } catch (java.net.MalformedURLException e) {
      Log.w(TAG, "Could not resolve relative Location header, using as-is: " + location);
      return location;
    }
  }

  // -----------------------------------------------------------------------
  // Stream timeout (keep-alive)
  // -----------------------------------------------------------------------

  private void scheduleStreamTimeout(String streamId) {
    cancelStreamTimeout();

    mStreamTimeoutTimer = new Timer("WhipStreamTimeout-" + streamId);
    mStreamTimeoutTimer.schedule(new TimerTask() {
      @Override
      public void run() {
        mMainHandler.post(() -> {
          synchronized (mStateLock) {
            if (mStreamState != StreamState.STREAMING) return;
          }
          Log.w(TAG, "Stream timed out - no keep-alive received within " + STREAM_TIMEOUT_MS + "ms");
          notifyError("Stream timed out - no keep-alive from cloud");
          stopStreaming();
        });
      }
    }, STREAM_TIMEOUT_MS);
  }

  private void cancelStreamTimeout() {
    if (mStreamTimeoutTimer != null) {
      mStreamTimeoutTimer.cancel();
      mStreamTimeoutTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Battery monitoring
  // -----------------------------------------------------------------------

  private void startBatteryMonitoring() {
    stopBatteryMonitoring();

    if (mBatteryMonitorHandler == null) {
      mBatteryMonitorHandler = new Handler(Looper.getMainLooper());
    }

    mBatteryCheckRunnable = new Runnable() {
      @Override
      public void run() {
        boolean shouldStop = false;
        boolean shouldReschedule = false;

        synchronized (mStateLock) {
          if (mStreamState == StreamState.IDLE || mStreamState == StreamState.STOPPING) {
            return; // Stream ended, stop monitoring
          }

          if (mHardwareManager == null) {
            Log.w(TAG, "HardwareManager not available during battery monitoring - will retry");
            shouldReschedule = true;
          } else if (mStreamState == StreamState.STREAMING) {
            int batteryLevel = mHardwareManager.getBatteryLevel();

            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
              Log.w(TAG, "Battery dropped to " + batteryLevel
                  + "% during WHIP streaming - stopping");
              shouldStop = true;

              if (mHardwareManager.supportsAudioPlayback()) {
                mHardwareManager.playAudioAsset(AudioAssets.BATTERY_LOW);
              }
            } else {
              shouldReschedule = true;
            }
          } else {
            // Reconnecting — keep monitoring
            shouldReschedule = true;
          }
        }

        if (shouldReschedule && mBatteryMonitorHandler != null) {
          mBatteryMonitorHandler.postDelayed(this,
              BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
        }

        if (shouldStop) {
          stopStreaming();
        }
      }
    };

    mBatteryMonitorHandler.postDelayed(mBatteryCheckRunnable,
        BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
    Log.d(TAG, "Started battery monitoring for WHIP streaming");
  }

  private void stopBatteryMonitoring() {
    if (mBatteryMonitorHandler != null) {
      if (mBatteryCheckRunnable != null) {
        mBatteryMonitorHandler.removeCallbacks(mBatteryCheckRunnable);
        mBatteryCheckRunnable = null;
      }
      mBatteryMonitorHandler.removeCallbacksAndMessages(null);
    }
  }

  // -----------------------------------------------------------------------
  // Static public API
  // -----------------------------------------------------------------------

  /**
   * Start streaming to the given WHIP URL.
   */
  public static void startStreaming(Context context, String whipUrl, String streamId,
      boolean enableLed, boolean enableSound, WhipStreamConfig config) {
    setStreamConfig(config);

    if (sInstance != null) {
      sInstance.mWhipUrl = whipUrl;
      sInstance.mCurrentStreamId = streamId;
      sInstance.mLedEnabled = enableLed;
      sInstance.mSoundEnabled = enableSound;
      sInstance.startStreaming();
    } else {
      Intent intent = new Intent(context, WhipStreamingService.class);
      intent.putExtra("whip_url", whipUrl);
      if (streamId != null) intent.putExtra("stream_id", streamId);
      intent.putExtra("enable_led", enableLed);
      intent.putExtra("enable_sound", enableSound);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent);
      } else {
        context.startService(intent);
      }
    }
  }

  public static void startStreaming(Context context, String whipUrl, String streamId,
      boolean enableLed, boolean enableSound) {
    startStreaming(context, whipUrl, streamId, enableLed, enableSound, null);
  }

  /**
   * Stop the active WHIP stream.
   */
  public static void stopStreaming(Context context) {
    if (sInstance != null) sInstance.stopStreaming();
    context.stopService(new Intent(context, WhipStreamingService.class));
  }

  /** @return true if a WHIP stream is currently active */
  public static boolean isStreaming() {
    if (sInstance == null) return false;
    synchronized (sInstance.mStateLock) {
      return sInstance.mStreamState == StreamState.STREAMING;
    }
  }

  /** @return true if a reconnection is currently in progress */
  public static boolean isReconnecting() {
    return sInstance != null && sInstance.mIsReconnecting;
  }

  /** Register a callback to receive streaming status events. Pass null to unregister. */
  public static void setStatusCallback(StreamingStatusCallback callback) {
    sStatusCallback = callback;
  }

  /** Get the current stream ID, or null if not streaming. */
  public static String getCurrentStreamId() {
    return sInstance != null ? sInstance.mCurrentStreamId : null;
  }

  /** Set the state manager for battery monitoring. */
  public static void setStateManager(IStateManager stateManager) {
    sStateManager = stateManager;
  }

  /**
   * Reset the stream timeout timer (called by keep-alive commands).
   * @return true if the streamId matches the current stream
   */
  public static boolean resetStreamTimeout(String streamId) {
    if (sInstance == null) return false;
    boolean matches = streamId != null && streamId.equals(sInstance.mCurrentStreamId);
    if (matches) {
      sInstance.scheduleStreamTimeout(streamId);
      // Re-acquire wake lock on keep-alive
      WakeLockManager.acquireFullWakeLockAndBringToForeground(
          sInstance.getApplicationContext(), 2180000, 5000);
    }
    return matches;
  }

  public static void setStreamConfig(WhipStreamConfig config) {
    if (config == null) return;
    if (sInstance != null) {
      sInstance.mStreamConfig = config;
    } else {
      sPendingStreamConfig = config;
    }
  }
}

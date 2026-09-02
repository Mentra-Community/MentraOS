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
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.network.utils.HotspotAwareNetworkChangeDetector;
import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.utils.WakeLockManager;

import org.json.JSONObject;

import org.webrtc.RTCStats;
import org.webrtc.RTCStatsCollectorCallback;
import org.webrtc.RTCStatsReport;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.NetworkMonitor;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpCapabilities;
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
import io.github.thibaultbee.streampack.internal.sources.camera.CameraController;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

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
  private static final Object sConfigLock = new Object();
  private static volatile WhipStreamingService sInstance;
  private static StreamingStatusCallback sStatusCallback;
  private static WhipStreamConfig sPendingStreamConfig = null;

  // Guard: PeerConnectionFactory.initialize() registers a BroadcastReceiver and must only be
  // called once per process to avoid the NetworkMonitorAutoDetect IntentReceiver leak.
  private static boolean sPeerConnectionFactoryInitialized = false;

  // Stream parameters
  private String mWhipUrl;
  /** Optional Bearer token for WHIP Authorization header (custom authenticated endpoints). */
  private String mAuthToken;
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

  /** Local candidates gathered for the current negotiation attempt; diagnostic only. */
  private volatile int mIceCandidateCount = 0;

  // WHIP has no trickle ICE. GATHER_ONCE + STUN can sit in GATHERING for minutes
  // after the useful host/srflx candidates are already in the local SDP. Phone
  // startExternallyManagedStream times out at 15s, so POST as soon as we have a
  // server-reflexive candidate, or after a short cap, whichever comes first.
  private static final long ICE_GATHER_POST_TIMEOUT_MS = 1500L;
  private static final long ICE_CONNECT_TIMEOUT_MS = 8000L;
  private volatile boolean mWhipOfferPosted = false;
  private volatile boolean mWhipStreamingNotified = false;
  /** Bumped on each new PeerConnection so queued ICE/HTTP callbacks cannot act on a later negotiation. */
  private volatile int mNegotiationGeneration = 0;
  private Runnable mPostOfferTimeoutRunnable = () -> {};
  private Runnable mIceConnectTimeoutRunnable = this::failIceConnectTimeout;

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
  private long mStartupStartedAtMs;
  /** Last `[STREAM_STARTUP]` stage successfully logged; used as `failedStage` context on failure. */
  private volatile String mLastStartupStage = "not_started";

  private long mLastVideoBytesSent = 0;
  private long mLastAudioBytesSent = 0;
  private long mLastStatsAtMs = 0;
  private long mStreamStartedAtMs = 0;
  private final Runnable mStatsRunnable = new Runnable() {
    @Override
    public void run() {
      if (!AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY) return;
      if (mPeerConnection == null) return;
      mPeerConnection.getStats(report -> {
        long videoBytesTotal = 0, audioBytesTotal = 0;
        long videoPackets = 0, audioPackets = 0;
        long droppedFrames = 0;
        double measuredFps = Double.NaN;
        for (RTCStats stats : report.getStatsMap().values()) {
          if (!"outbound-rtp".equals(stats.getType())) continue;
          Object kind  = stats.getMembers().get("kind");
          Object bytes = stats.getMembers().get("bytesSent");
          Object pkts  = stats.getMembers().get("packetsSent");
          if (bytes == null) continue;
          long b = ((Number) bytes).longValue();
          long p = pkts != null ? ((Number) pkts).longValue() : 0;
          if ("video".equals(kind)) {
            videoBytesTotal += b;
            videoPackets += p;
            Object dropped = stats.getMembers().get("framesDropped");
            if (!(dropped instanceof Number)) {
              dropped = stats.getMembers().get("framesDiscardedOnSend");
            }
            if (dropped instanceof Number) {
              droppedFrames += ((Number) dropped).longValue();
            }
            Object fps = stats.getMembers().get("framesPerSecond");
            if (fps instanceof Number) {
              measuredFps = Math.max(
                  Double.isFinite(measuredFps) ? measuredFps : 0,
                  ((Number) fps).doubleValue());
            }
          }
          else if ("audio".equals(kind)) { audioBytesTotal = b; audioPackets = p; }
        }
        long now = SystemClock.elapsedRealtime();
        long elapsedMs = mLastStatsAtMs > 0
            ? now - mLastStatsAtMs
            : AsgConstants.STREAM_METRICS_INTERVAL_MS;
        long videoDelta = Math.max(0, videoBytesTotal - mLastVideoBytesSent);
        long audioDelta = Math.max(0, audioBytesTotal - mLastAudioBytesSent);
        mLastVideoBytesSent = videoBytesTotal;
        mLastAudioBytesSent = audioBytesTotal;
        mLastStatsAtMs = now;
        long videoBitrateBps = elapsedMs > 0 ? videoDelta * 8_000L / elapsedMs : 0;
        double fps = Double.isFinite(measuredFps) ? measuredFps : mStreamConfig.getVideoFps();
        long durationSeconds = mStreamStartedAtMs > 0
            ? Math.max(0, (now - mStreamStartedAtMs) / 1_000L)
            : 0;
        double temperatureC = StreamThermalReader.readCpuTemperatureC();
        notifyMetrics(
            videoBitrateBps,
            fps,
            droppedFrames,
            durationSeconds,
            temperatureC);
        PeriodicStreamMetricsReporter.logQuality(
            "whip",
            mCurrentStreamId,
            new PeriodicStreamMetricsReporter.MetricsSample(
                mStreamConfig.getVideoWidth(),
                mStreamConfig.getVideoHeight(),
                mStreamConfig.getVideoBitrate(),
                videoBitrateBps,
                mStreamConfig.getVideoFps(),
                Double.isFinite(measuredFps) ? measuredFps : Double.NaN,
                mStreamConfig.getMeasuredCameraFps(),
                droppedFrames,
                durationSeconds,
                temperatureC));
        Log.d(TAG, String.format(
            "↑ video: %d B/s (%d pkts total)  audio: %d B/s (%d pkts total)",
            elapsedMs > 0 ? videoDelta * 1000 / elapsedMs : 0, videoPackets,
            elapsedMs > 0 ? audioDelta * 1000 / elapsedMs : 0, audioPackets));

        synchronized (mStateLock) {
          if (mStreamState != StreamState.STREAMING || mPeerConnection == null) {
            return;
          }
        }
        mMainHandler.postDelayed(this, AsgConstants.STREAM_METRICS_INTERVAL_MS);
      });
    }
  };

  // -----------------------------------------------------------------------
  // Android Service lifecycle
  // -----------------------------------------------------------------------

  @Override
  public void onCreate() {
    super.onCreate();

    boolean appliedPendingStreamConfig = false;
    synchronized (sConfigLock) {
      if (sPendingStreamConfig != null) {
        mStreamConfig = sPendingStreamConfig;
        sPendingStreamConfig = null;
        appliedPendingStreamConfig = true;
      }

      sInstance = this;
    }
    if (appliedPendingStreamConfig) {
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
      mAuthToken = intent.getStringExtra("auth_token");

      if (whipUrl != null && !whipUrl.isEmpty()) {
        mWhipUrl = whipUrl;
        if (streamId != null && !streamId.isEmpty()) {
          mCurrentStreamId = streamId;
        }
        mStartupStartedAtMs = SystemClock.elapsedRealtime();
        logStartupStage("service_command_received");
        // Defer until onStartCommand returns, without adding a fixed delay.
        mMainHandler.post(this::startStreaming);
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
    synchronized (sConfigLock) {
      if (sInstance == this) {
        sInstance = null;
      }
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
    if (CameraNeoService.isCameraInUse()) {
      handleStartupFailure("camera_busy", "Cannot start WHIP stream - camera is busy with photo/video capture");
      return;
    }

    synchronized (mStateLock) {
      if (mStreamState != StreamState.IDLE && mStreamState != StreamState.RECONNECTING) {
        Log.w(TAG, "startStreaming() called in state " + mStreamState + ", ignoring");
        return;
      }
      mStreamState = StreamState.STARTING;
    }
    if (!mIsReconnecting && mStartupStartedAtMs == 0) {
      mStartupStartedAtMs = SystemClock.elapsedRealtime();
    }
    logStartupStage("pipeline_started");

    // Acquire wake lock to prevent device sleep during streaming
    WakeLockManager.acquireFullWakeLockAndBringToForeground(
        getApplicationContext(), WakeLockManager.WakeOwner.STREAMING, 2180000, 5000);

    if (!mIsReconnecting) {
      mReconnectAttempts = 0;
    }

    Log.d(TAG, (mIsReconnecting ? "Re-starting" : "Starting") + " WHIP streaming to " + mWhipUrl);
    if (!mIsReconnecting) notifyStarting(mWhipUrl);
    updateNotification(mIsReconnecting ? "Reconnecting…" : "Connecting…");

    try {
      initWebRtc();
      logStartupStage("peer_connection_factory_ready");
      setupCamera();
      logStartupStage("camera_started");
      if (mStreamConfig.isCaptureAudio()) {
        setupAudio();
        logStartupStage("audio_started");
      } else {
        Log.i(TAG, "Skipping glasses mic capture (captureAudio=false)");
        logStartupStage("audio_skipped");
      }
      createPeerConnectionAndOffer();
      logStartupStage("offer_requested");
    } catch (Exception e) {
      Log.e(TAG, "Failed to start streaming", e);
      handleStartupFailure("exception", "Failed to start: " + e.getMessage());
    }
  }

  /** Stop the active stream and release all WebRTC resources. */
  private void stopStreaming() {
    stopStreaming(false);
  }

  private void stopStreaming(boolean forReconnect) {
    boolean hasWebRtcResources = hasWebRtcResources();
    synchronized (mStateLock) {
      if (mStreamState == StreamState.STOPPING) {
        return;
      }
      if (mStreamState == StreamState.IDLE && !hasWebRtcResources) {
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
      WakeLockManager.release(WakeLockManager.WakeOwner.STREAMING);
      restoreEisDefault();
      resetState();
      notifyStopped();
      updateNotification("Stream stopped");
    }
    Log.d(TAG, "WHIP streaming stopped");
  }

  /**
   * Livestream EIS is armed by StreamCommandHandler at start and restored there only on an
   * explicit stop command. Stops that originate inside this service (keep-alive timeout,
   * battery cutoff, reconnect give-up) never passed through the handler, so the vendor EIS
   * property and the capture-request flag stayed armed for the next photo/video. Every
   * terminal stop now restores the boot default (off); the handler's own restore is idempotent.
   */
  private void restoreEisDefault() {
    if (!CameraController.enablePixsmartEisOnRequest) return;
    Log.i(TAG, "EIS stage=stream-stop enable=false reason=service-terminal-stop");
    CameraController.enablePixsmartEisOnRequest = false;
    try {
      SystemControllerFactory.get(getApplicationContext()).setEisEnabled(false);
    } catch (Exception e) {
      Log.w(TAG, "Failed to restore EIS default after stream stop", e);
    }
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
      // ConnectivityManager omits the tethering-side ap0 interface. Supply a detector that also
      // inventories that local-only network so ICE can gather and bind an AP candidate.
      NetworkMonitor.getInstance()
          .setNetworkChangeDetectorFactory(HotspotAwareNetworkChangeDetector::new);
      PeerConnectionFactory.InitializationOptions initOptions =
          PeerConnectionFactory.InitializationOptions.builder(this)
              .setEnableInternalTracer(false)
              .createInitializationOptions();
      PeerConnectionFactory.initialize(initOptions);
      sPeerConnectionFactoryInitialized = true;
    }

    mEglBase = EglBase.create();

    PeerConnectionFactory.Options factoryOptions = new PeerConnectionFactory.Options();
    // Loopback interfaces (127.0.0.1, ::1) can never reach an external STUN server, but the
    // ICE agent still waits out the full STUN retransmission timeout on them before declaring
    // gathering complete, which was delaying the WHIP offer by ~40s. Ignoring loopback here
    // makes the network monitor skip it entirely so gathering completes as soon as the real
    // network interface's candidates (including srflx) are ready.
    factoryOptions.networkIgnoreMask = PeerConnectionFactory.Options.ADAPTER_TYPE_LOOPBACK;
    mPeerConnectionFactory = PeerConnectionFactory.builder()
        .setOptions(factoryOptions)
        .setVideoEncoderFactory(
            new HardwareFirstVideoEncoderFactory(mEglBase.getEglBaseContext()))
        .setVideoDecoderFactory(
            new DefaultVideoDecoderFactory(mEglBase.getEglBaseContext()))
        .createPeerConnectionFactory();

    Log.d(TAG, "PeerConnectionFactory created");
  }

  private void setupCamera() {
    WhipCameraCapturer whipCapturer = new WhipCameraCapturer();
    whipCapturer.setCameraFpsListener(fps -> mStreamConfig.setStatusVideoFps(fps));
    mVideoCapturer = whipCapturer;

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
    final int generation = ++mNegotiationGeneration;
    mWhipOfferPosted = false;
    mWhipStreamingNotified = false;
    if (mMainHandler != null) {
      mMainHandler.removeCallbacks(mPostOfferTimeoutRunnable);
      mMainHandler.removeCallbacks(mIceConnectTimeoutRunnable);
    }

    List<PeerConnection.IceServer> iceServers = new ArrayList<>();
    String stunServer = mStreamConfig.getStunServer();
    if (stunServer != null && !stunServer.isEmpty()) {
      iceServers.add(PeerConnection.IceServer.builder(stunServer).createIceServer());
    }

    mIceCandidateCount = 0;

    PeerConnection.RTCConfiguration rtcConfig =
        new PeerConnection.RTCConfiguration(iceServers);
    rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
    rtcConfig.continualGatheringPolicy =
        PeerConnection.ContinualGatheringPolicy.GATHER_ONCE;

    mPeerConnection = mPeerConnectionFactory.createPeerConnection(
        rtcConfig, new WhipPeerConnectionObserver(generation));

    if (mPeerConnection == null) {
      throw new IllegalStateException("Failed to create PeerConnection");
    }

    mPeerConnection.addTrack(mVideoTrack);
    if (mAudioTrack != null) {
      mPeerConnection.addTrack(mAudioTrack);
    }

    for (RtpTransceiver transceiver : mPeerConnection.getTransceivers()) {
      transceiver.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY);
    }

    preferHardwareVideoCodec();

    // Apply bitrate cap and degradation preference to reduce encoder thermal load.
    // Without this, the encoder runs uncapped and overheats the SoC.
    applyBitrateConstraints();

    MediaConstraints sdpConstraints = new MediaConstraints();
    mPeerConnection.createOffer(new SdpObserver() {
      @Override
      public void onCreateSuccess(SessionDescription offer) {
        if (generation != mNegotiationGeneration || mPeerConnection == null) return;
        mPeerConnection.setLocalDescription(new SdpObserver() {
          @Override
          public void onSetSuccess() {
            if (generation != mNegotiationGeneration) return;
            Log.d(TAG, "Local description set, posting WHIP offer after first srflx or "
                + ICE_GATHER_POST_TIMEOUT_MS + "ms");
            mPostOfferTimeoutRunnable = () -> {
              if (generation != mNegotiationGeneration) return;
              postOfferIfReady("timeout", generation);
            };
            mMainHandler.postDelayed(mPostOfferTimeoutRunnable, ICE_GATHER_POST_TIMEOUT_MS);
          }

          @Override
          public void onSetFailure(String error) {
            if (generation != mNegotiationGeneration) return;
            handleStartupFailure("set_local_description_failed", "setLocalDescription failed: " + error);
          }

          @Override public void onCreateSuccess(SessionDescription sdp) {}
          @Override public void onCreateFailure(String error) {}
        }, offer);
      }

      @Override
      public void onCreateFailure(String error) {
        if (generation != mNegotiationGeneration) return;
        handleStartupFailure("create_offer_failed", "createOffer failed: " + error);
      }

      @Override public void onSetSuccess() {}
      @Override public void onSetFailure(String error) {}
    }, sdpConstraints);
  }

  /**
   * Move H.264 to the front of the video codec preference list. The SDP offer follows
   * this order and WHIP servers generally answer with the first offered codec they
   * support. H.264 is the only codec with a hardware encoder on Mentra Live; VP8/VP9/AV1
   * only exist as software encoders (libvpx/libaom) that burn CPU and heat the SoC.
   * VP8 and friends stay in the list as a fallback for servers without H.264 support.
   */
  private void preferHardwareVideoCodec() {
    RtpCapabilities capabilities = mPeerConnectionFactory.getRtpSenderCapabilities(
        MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO);

    List<RtpCapabilities.CodecCapability> h264 = new ArrayList<>();
    List<RtpCapabilities.CodecCapability> others = new ArrayList<>();
    for (RtpCapabilities.CodecCapability codec : capabilities.codecs) {
      if ("H264".equalsIgnoreCase(codec.name)) {
        h264.add(codec);
      } else {
        others.add(codec);
      }
    }

    if (h264.isEmpty()) {
      Log.w(TAG, "No H264 sender capability, keeping default codec order");
      return;
    }

    List<RtpCapabilities.CodecCapability> preferred = new ArrayList<>(h264);
    preferred.addAll(others);

    for (RtpTransceiver transceiver : mPeerConnection.getTransceivers()) {
      if (transceiver.getMediaType() == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) {
        transceiver.setCodecPreferences(preferred);
      }
    }
    Log.i(TAG, "Video codec preference: H264 first ("
        + h264.size() + " H264 entries, " + others.size() + " others)");
  }

  /**
   * Seed WebRTC above its conservative startup default, cap the video encoder bitrate, and set
   * degradation preference to MAINTAIN_FRAMERATE so WebRTC drops quality-per-frame instead of
   * frame rate when thermals get tight.
   */
  private void applyBitrateConstraints() {
    int maximumBitrateBps = mStreamConfig.getVideoBitrate();
    int initialBitrateBps = WhipBitratePolicy.initialBitrateBps(maximumBitrateBps);

    for (RtpSender sender : mPeerConnection.getSenders()) {
      if (sender.track() == null) continue;
      if (!"video".equals(sender.track().kind())) continue;

      RtpParameters params = sender.getParameters();
      if (params == null) continue;

      params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE;

      for (RtpParameters.Encoding encoding : params.encodings) {
        encoding.maxBitrateBps = maximumBitrateBps;
      }

      sender.setParameters(params);
    }

    boolean bitratePreferencesApplied =
        WhipBitratePolicy.applyTo(mPeerConnection, maximumBitrateBps);
    if (!bitratePreferencesApplied) {
      Log.w(TAG, "Failed to apply WHIP initial/max bitrate preferences");
    }
    Log.i(TAG, "Applied video bitrate constraints: start=" + (initialBitrateBps / 1000)
        + " kbps, max=" + (maximumBitrateBps / 1000)
        + " kbps, degradation=MAINTAIN_FRAMERATE");
  }

  // -----------------------------------------------------------------------
  // WHIP HTTP signaling
  // -----------------------------------------------------------------------

  /**
   * Extracts the codec name of the first payload in the SDP's m=video line — the codec
   * the far end selected. Diagnostic only: on Mentra Live "H264" means hardware encode,
   * "VP8"/"VP9"/"AV1" mean software encode on the CPU.
   */
  private static String firstVideoCodecFromSdp(String sdp) {
    String firstPayloadType = null;
    for (String line : sdp.split("\r?\n")) {
      if (line.startsWith("m=video")) {
        // m=video 9 UDP/TLS/RTP/SAVPF 102 103 ... — first payload type is index 3
        String[] parts = line.trim().split(" ");
        if (parts.length > 3) {
          firstPayloadType = parts[3];
        }
      } else if (firstPayloadType != null
          && line.startsWith("a=rtpmap:" + firstPayloadType + " ")) {
        return line.substring(("a=rtpmap:" + firstPayloadType + " ").length());
      }
    }
    return "unknown";
  }

  /**
   * Logs the m=video line plus its rtpmap/fmtp attributes. Codec negotiation problems
   * (e.g. an H264 profile mismatch making the encoder factory silently return null)
   * are invisible without seeing what each side actually put on the wire.
   */
  private static void logSdpVideoSection(String label, String sdp) {
    StringBuilder section = new StringBuilder();
    boolean inVideo = false;
    for (String line : sdp.split("\r?\n")) {
      if (line.startsWith("m=")) {
        inVideo = line.startsWith("m=video");
        if (inVideo) {
          section.append(line).append('\n');
        }
      } else if (inVideo && (line.startsWith("a=rtpmap:") || line.startsWith("a=fmtp:"))) {
        section.append(line).append('\n');
      }
    }
    Log.i(TAG, label + " video section:\n" + section);
  }

  /**
   * POST the local SDP once. Triggered by first srflx, the gather timeout, or
   * GATHERING COMPLETE — whichever wins. Later triggers are no-ops.
   */
  private void postOfferIfReady(String reason, int generation) {
    PeerConnection peerConnection;
    synchronized (mStateLock) {
      if (generation != mNegotiationGeneration) {
        return;
      }
      if (mWhipOfferPosted) {
        return;
      }
      if (mPeerConnection == null || mStreamState == StreamState.STOPPING
          || mStreamState == StreamState.IDLE) {
        Log.w(TAG, "Skipping WHIP POST (" + reason + "): stream already stopping/stopped");
        return;
      }
      mWhipOfferPosted = true;
      peerConnection = mPeerConnection;
    }
    if (mMainHandler != null) {
      mMainHandler.removeCallbacks(mPostOfferTimeoutRunnable);
    }

    SessionDescription localSdp = peerConnection.getLocalDescription();

    if (localSdp != null) {
      Log.i(TAG, "Posting WHIP offer after ICE trigger=" + reason
          + " candidates=" + mIceCandidateCount);
      postOfferToWhip(localSdp, generation);
    } else {
      Log.e(TAG, "WHIP POST trigger=" + reason + " but local SDP is null");
      synchronized (mStateLock) {
        if (generation != mNegotiationGeneration) {
          return;
        }
        mWhipOfferPosted = false;
      }
      handleStartupFailure("local_sdp_missing", "Local SDP unavailable before WHIP POST");
    }
  }

  private void completeWhipStartupIfNeeded() {
    synchronized (mStateLock) {
      if (mWhipStreamingNotified) return;
      if (mPeerConnection == null || mStreamState == StreamState.STOPPING
          || mStreamState == StreamState.IDLE) {
        return;
      }
      mWhipStreamingNotified = true;
      mStreamState = StreamState.STREAMING;
    }
    if (mMainHandler != null) {
      mMainHandler.removeCallbacks(mIceConnectTimeoutRunnable);
    }
    logStartupStage("streaming_live", "candidates=" + mIceCandidateCount);

    SessionDescription remote = mPeerConnection != null ? mPeerConnection.getRemoteDescription() : null;
    String answerSdp = remote != null ? remote.description : "";
    mLastVideoBytesSent = 0;
    mLastAudioBytesSent = 0;
    mLastStatsAtMs = SystemClock.elapsedRealtime();
    if (!mIsReconnecting || mStreamStartedAtMs == 0) {
      mStreamStartedAtMs = mLastStatsAtMs;
    }
    if (AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY) {
      mMainHandler.postDelayed(mStatsRunnable, AsgConstants.STREAM_METRICS_INTERVAL_MS);
    }
    scheduleStreamTimeout(mCurrentStreamId);
    startBatteryMonitoring();
    Log.i(TAG, "Streaming started via WHIP, negotiated video codec: "
        + firstVideoCodecFromSdp(answerSdp));
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

  private void failIceConnectTimeout() {
    boolean reconnecting;
    synchronized (mStateLock) {
      if (mWhipStreamingNotified) return;
      if (mStreamState != StreamState.STARTING && mStreamState != StreamState.RECONNECTING) {
        return;
      }
      reconnecting = mIsReconnecting;
      if (!reconnecting) {
        mWhipStreamingNotified = true;
      }
    }
    if (mMainHandler != null) {
      mMainHandler.removeCallbacks(mIceConnectTimeoutRunnable);
    }
    // Reconnect attempts also pass through STARTING. A mid-call ICE miss must
    // retry, not run the terminal first-start failure path.
    if (reconnecting) {
      attemptReconnect("ICE did not connect");
      return;
    }
    handleStartupFailure("ice_timeout", "ICE did not connect; WHIP media path failed");
  }

  private void postOfferToWhip(SessionDescription offer, int generation) {
    logStartupStage("whip_request_started");
    Log.d(TAG, "POSTing SDP offer to WHIP URL: " + mWhipUrl);
    logSdpVideoSection("Offer", offer.description);

    RequestBody body = RequestBody.create(
        offer.description, MediaType.parse("application/sdp"));

    Request.Builder requestBuilder = new Request.Builder()
        .url(mWhipUrl)
        .post(body)
        .addHeader("Content-Type", "application/sdp");
    addWhipAuth(requestBuilder);
    Request request = requestBuilder.build();

    mHttpClient.newCall(request).enqueue(new Callback() {
      @Override
      public void onResponse(Call call, Response response) throws IOException {
        if (generation != mNegotiationGeneration) {
          String location = response.header("Location");
          if (location != null) {
            String staleUrl = location.startsWith("http")
                ? location
                : buildAbsoluteUrl(mWhipUrl, location);
            deleteWhipResource(staleUrl);
          }
          response.close();
          return;
        }
        if (response.code() != 201) {
          String msg = "WHIP server returned " + response.code();
          handleStartupFailure("http_" + response.code(), msg);
          return;
        }

        String location = response.header("Location");
        String resourceUrl = null;
        if (location != null) {
          resourceUrl = location.startsWith("http")
              ? location
              : buildAbsoluteUrl(mWhipUrl, location);
        }

        String answerSdp = response.body() != null ? response.body().string() : "";
        if (answerSdp.isEmpty()) {
          handleStartupFailure("empty_answer_sdp", "WHIP server returned empty SDP answer");
          return;
        }

        int remoteCandidateCount = 0;
        for (String line : answerSdp.split("\r?\n")) {
          if (line.startsWith("a=candidate")) remoteCandidateCount++;
        }
        logStartupStage("whip_answer_received", "remoteCandidates=" + remoteCandidateCount);

        // A late WHIP answer can arrive after the stream was stopped or its startup failed
        // and WebRTC was torn down (releaseWebRtc nulls mPeerConnection on another thread).
        // Don't dereference a released peer connection or revive a torn-down session.
        PeerConnection peerConnection;
        synchronized (mStateLock) {
          if (generation != mNegotiationGeneration || mPeerConnection == null
              || mStreamState == StreamState.STOPPING
              || mStreamState == StreamState.IDLE) {
            Log.w(TAG, "WHIP answer received but stream already stopping/stopped, ignoring");
            if (resourceUrl != null) {
              deleteWhipResource(resourceUrl);
            }
            return;
          }
          peerConnection = mPeerConnection;
          mWhipResourceUrl = resourceUrl;
        }
        if (resourceUrl != null) {
          Log.d(TAG, "WHIP resource URL: " + mWhipResourceUrl);
        }

        logSdpVideoSection("Answer", answerSdp);
        SessionDescription answer = new SessionDescription(
            SessionDescription.Type.ANSWER, answerSdp);

        peerConnection.setRemoteDescription(new SdpObserver() {
          @Override
          public void onSetSuccess() {
            synchronized (mStateLock) {
              if (generation != mNegotiationGeneration || mPeerConnection == null
                  || mStreamState == StreamState.STOPPING
                  || mStreamState == StreamState.IDLE) {
                Log.w(TAG, "WHIP remote description set but stream already stopping/stopped, ignoring");
                return;
              }
            }
            logStartupStage("whip_answer_applied");
            Log.i(TAG, "WHIP answer applied, waiting for ICE connect (max "
                + ICE_CONNECT_TIMEOUT_MS + "ms)");
            mMainHandler.post(() -> {
              if (generation != mNegotiationGeneration) return;
              mMainHandler.removeCallbacks(mIceConnectTimeoutRunnable);
              mIceConnectTimeoutRunnable = () -> {
                if (generation != mNegotiationGeneration) return;
                failIceConnectTimeout();
              };
              mMainHandler.postDelayed(mIceConnectTimeoutRunnable, ICE_CONNECT_TIMEOUT_MS);
            });
          }

          @Override
          public void onSetFailure(String error) {
            if (generation != mNegotiationGeneration) return;
            handleStartupFailure("set_remote_description_failed", "setRemoteDescription failed: " + error);
          }

          @Override public void onCreateSuccess(SessionDescription sdp) {}
          @Override public void onCreateFailure(String error) {}
        }, answer);
      }

      @Override
      public void onFailure(Call call, IOException e) {
        if (generation != mNegotiationGeneration) return;
        Log.e(TAG, "WHIP request failed", e);
        handleStartupFailure("whip_request_failed", "WHIP request failed: " + e.getMessage());
      }
    });
  }

  private void addWhipAuth(Request.Builder builder) {
    if (mAuthToken == null || mAuthToken.isEmpty()) return;
    String token = mAuthToken.startsWith("Bearer ") ? mAuthToken : "Bearer " + mAuthToken;
    builder.addHeader("Authorization", token);
  }

  private void deleteWhipResource(String resourceUrl) {
    Request.Builder requestBuilder = new Request.Builder()
        .url(resourceUrl)
        .delete();
    addWhipAuth(requestBuilder);
    Request request = requestBuilder.build();

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
    private final int generation;

    WhipPeerConnectionObserver(int generation) {
      this.generation = generation;
    }

    private boolean isStale() {
      return generation != mNegotiationGeneration;
    }

    @Override
    public void onIceGatheringChange(PeerConnection.IceGatheringState newState) {
      Log.d(TAG, "ICE gathering state: " + newState);
      if (isStale()) return;
      if (newState == PeerConnection.IceGatheringState.COMPLETE) {
        logStartupStage("ice_gathering_complete", "candidates=" + mIceCandidateCount);
        postOfferIfReady("complete", generation);
      }
    }

    @Override
    public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
      Log.d(TAG, "PeerConnection state: " + newState);
      if (isStale()) return;
      if (newState == PeerConnection.PeerConnectionState.FAILED) {
        mMainHandler.post(() -> {
          if (isStale()) return;
          synchronized (mStateLock) {
            if (mStreamState == StreamState.STARTING && !mIsReconnecting) {
              failIceConnectTimeout();
              return;
            }
          }
          attemptReconnect("PeerConnection failed");
        });
      } else if (newState == PeerConnection.PeerConnectionState.CONNECTED) {
        mMainHandler.post(() -> {
          if (isStale()) return;
          completeWhipStartupIfNeeded();
        });
      } else if (newState == PeerConnection.PeerConnectionState.DISCONNECTED) {
        Log.w(TAG, "PeerConnection disconnected — waiting before reconnect");
        mMainHandler.postDelayed(() -> {
          if (isStale()) return;
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
      if (isStale()) return;
      if (iceConnectionState == PeerConnection.IceConnectionState.CONNECTED
          || iceConnectionState == PeerConnection.IceConnectionState.COMPLETED) {
        mMainHandler.post(() -> {
          if (isStale()) return;
          completeWhipStartupIfNeeded();
        });
      } else if (iceConnectionState == PeerConnection.IceConnectionState.FAILED) {
        mMainHandler.post(() -> {
          if (isStale()) return;
          synchronized (mStateLock) {
            if (mStreamState == StreamState.STARTING && !mIsReconnecting) {
              failIceConnectTimeout();
              return;
            }
          }
          attemptReconnect("ICE failed");
        });
      }
    }

    @Override public void onIceConnectionReceivingChange(boolean receiving) {}
    @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}

    @Override
    public void onIceCandidate(IceCandidate candidate) {
      if (isStale()) return;
      mIceCandidateCount++;
      if (candidate.sdp != null && candidate.sdp.contains("typ srflx")) {
        mMainHandler.post(() -> {
          if (isStale()) return;
          postOfferIfReady("srflx", generation);
        });
      }
    }
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
    mNegotiationGeneration++;
    if (mMainHandler != null) {
      mMainHandler.removeCallbacks(mPostOfferTimeoutRunnable);
      mMainHandler.removeCallbacks(mIceConnectTimeoutRunnable);
    }
    mWhipOfferPosted = false;
    mWhipStreamingNotified = false;
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

  private boolean hasWebRtcResources() {
    return mVideoCapturer != null
        || mPeerConnection != null
        || mVideoTrack != null
        || mAudioTrack != null
        || mVideoSource != null
        || mAudioSource != null
        || mSurfaceTextureHelper != null
        || mPeerConnectionFactory != null
        || mEglBase != null;
  }

  private void cleanupFailedStartup() {
    mMainHandler.removeCallbacks(mStatsRunnable);
    cancelStreamTimeout();
    stopBatteryMonitoring();
    if (mWhipResourceUrl != null) {
      deleteWhipResource(mWhipResourceUrl);
      mWhipResourceUrl = null;
    }
    releaseWebRtc();
    if (mLedEnabled && mHardwareManager != null && mHardwareManager.supportsRecordingLed()) {
      mHardwareManager.setRecordingLedOff();
    }
    mIsReconnecting = false;
    mReconnectAttempts = 0;
    mStreamStartedAtMs = 0;
    mLastStatsAtMs = 0;
    WakeLockManager.release(WakeLockManager.WakeOwner.STREAMING);
    resetState();
    updateNotification("Stream failed");
  }

  /**
   * @param reasonCode short, aggregable failure code (e.g. "ice_timeout", "http_403")
   * @param message human-readable detail, forwarded to status listeners / UI
   */
  private void handleStartupFailure(String reasonCode, String message) {
    if (mMainHandler != null && Looper.myLooper() != Looper.getMainLooper()) {
      mMainHandler.post(() -> handleStartupFailure(reasonCode, message));
      return;
    }
    logStartupFailure(reasonCode);
    notifyError(message);
    cleanupFailedStartup();
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
    StreamingStatusCallback callback = sStatusCallback;
    if (callback != null) {
      // Capture now: by the time the posted runnable runs, a newer start may
      // already have overwritten mCurrentStreamId.
      String streamId = mCurrentStreamId;
      mMainHandler.post(() -> callback.onStreamStopped(streamId));
    }
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
    StreamingStatusCallback callback = sStatusCallback;
    if (callback != null) {
      String streamId = mCurrentStreamId;
      Runnable notify = () -> callback.onStreamError(error, streamId);
      if (Looper.myLooper() == Looper.getMainLooper()) {
        notify.run();
      } else {
        mMainHandler.post(notify);
      }
    }
  }

  private void notifyMetrics(
      long bitrateBps,
      double fps,
      long droppedFrames,
      long durationSeconds,
      double temperatureC) {
    if (!AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY) return;
    StreamingStatusCallback callback = sStatusCallback;
    String streamId = mCurrentStreamId;
    if (callback == null) return;
    mMainHandler.post(() -> {
      synchronized (mStateLock) {
        if (mStreamState != StreamState.STREAMING
            || (streamId != null && !streamId.equals(mCurrentStreamId))) {
          return;
        }
      }
      callback.onStreamMetrics(
          streamId, bitrateBps, fps, droppedFrames, durationSeconds, temperatureC);
    });
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

  private void logStartupStage(String stage) {
    logStartupStage(stage, null);
  }

  /** @param extra optional additional "key=value" fields appended to the stage line */
  private void logStartupStage(String stage, String extra) {
    if (mStartupStartedAtMs == 0) return;
    mLastStartupStage = stage;
    StringBuilder line = new StringBuilder("[STREAM_STARTUP] streamId=")
        .append(mCurrentStreamId)
        .append(" stage=").append(stage)
        .append(" elapsedMs=").append(SystemClock.elapsedRealtime() - mStartupStartedAtMs);
    if (extra != null && !extra.isEmpty()) {
      line.append(' ').append(extra);
    }
    Log.i(TAG, line.toString());
  }

  /** Structured startup failure: aggregable by `reason` instead of grepping message prose. */
  private void logStartupFailure(String reasonCode) {
    if (mStartupStartedAtMs == 0) return;
    Log.w(
        TAG,
        "[STREAM_STARTUP] streamId=" + mCurrentStreamId
            + " stage=startup_failed"
            + " failedStage=" + mLastStartupStage
            + " elapsedMs=" + (SystemClock.elapsedRealtime() - mStartupStartedAtMs)
            + " reason=" + reasonCode);
  }

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

    if (AsgConstants.DISABLE_STREAM_KEEP_ALIVE_TIMEOUT) {
      Log.i(TAG, "Keep-alive timeout disabled; stream will not auto-stop: " + streamId);
      return;
    }

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
        int stopBatteryLevel = -1;

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
              stopBatteryLevel = batteryLevel;

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
          // Name the reason before the stop. A bare `stopped` looks like a clean end to the
          // phone, so Mentra Call kept trying to restart a stream the glasses would only
          // reject again and the wearer never learned the battery was the problem.
          notifyError("Battery too low (" + stopBatteryLevel + "%) - streaming stopped; minimum "
              + BatteryConstants.MIN_BATTERY_LEVEL + "% required");
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
    startStreaming(context, whipUrl, streamId, enableLed, enableSound, config, null);
  }

  /**
   * Start streaming to the given WHIP URL with an optional Authorization bearer token.
   */
  public static void startStreaming(Context context, String whipUrl, String streamId,
      boolean enableLed, boolean enableSound, WhipStreamConfig config, String authToken) {
    setStreamConfig(config);

    if (sInstance != null) {
      sInstance.mWhipUrl = whipUrl;
      sInstance.mAuthToken = authToken;
      sInstance.mCurrentStreamId = streamId;
      sInstance.mLedEnabled = enableLed;
      sInstance.mSoundEnabled = enableSound;
      sInstance.mStartupStartedAtMs = SystemClock.elapsedRealtime();
      sInstance.logStartupStage("service_command_received");
      sInstance.startStreaming();
    } else {
      Intent intent = new Intent(context, WhipStreamingService.class);
      intent.putExtra("whip_url", whipUrl);
      if (streamId != null) intent.putExtra("stream_id", streamId);
      intent.putExtra("enable_led", enableLed);
      intent.putExtra("enable_sound", enableSound);
      if (authToken != null && !authToken.isEmpty()) {
        intent.putExtra("auth_token", authToken);
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent);
      } else {
        context.startService(intent);
      }
    }
  }

  public static void startStreaming(Context context, String whipUrl, String streamId,
      boolean enableLed, boolean enableSound) {
    startStreaming(context, whipUrl, streamId, enableLed, enableSound, null, null);
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
    WhipStreamingService instance = sInstance;
    if (instance == null) return false;
    synchronized (instance.mStateLock) {
      return instance.mStreamState == StreamState.STREAMING
          || instance.mStreamState == StreamState.STARTING;
    }
  }

  /** @return true only after WHIP negotiation has reached a live streaming state. */
  public static boolean isActivelyStreaming() {
    WhipStreamingService instance = sInstance;
    if (instance == null) return false;
    synchronized (instance.mStateLock) {
      return instance.mStreamState == StreamState.STREAMING;
    }
  }

  /** @return true while WHIP startup is in progress before ingest is live. */
  public static boolean isStarting() {
    WhipStreamingService instance = sInstance;
    if (instance == null) return false;
    synchronized (instance.mStateLock) {
      return instance.mStreamState == StreamState.STARTING;
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
          sInstance.getApplicationContext(), WakeLockManager.WakeOwner.STREAMING, 2180000, 5000);
    }
    return matches;
  }

  public static void setStreamConfig(WhipStreamConfig config) {
    if (config == null) return;
    synchronized (sConfigLock) {
      if (sInstance != null) {
        sInstance.mStreamConfig = config;
      } else {
        sPendingStreamConfig = config;
      }
    }
  }

  /** Returns the effective configuration for the active or pending WHIP stream. */
  public static JSONObject getCurrentResolvedConfig() {
    synchronized (sConfigLock) {
      WhipStreamConfig config = null;
      if (sInstance != null) {
        config = sInstance.mStreamConfig;
      } else if (sPendingStreamConfig != null) {
        config = sPendingStreamConfig;
      }
      return config != null ? config.toStatusJson("whip") : null;
    }
  }
}

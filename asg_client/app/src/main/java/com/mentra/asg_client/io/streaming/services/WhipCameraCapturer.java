package com.mentra.asg_client.io.streaming.services;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.view.WindowManager;

import androidx.annotation.NonNull;

import com.mentra.asg_client.service.utils.ServiceUtils;

import org.webrtc.CapturerObserver;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.TextureBufferImpl;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoFrame;

import java.util.Arrays;
import java.util.Collections;

/**
 * Custom Camera2-based {@link VideoCapturer} that applies the same power-saving
 * CaptureRequest optimizations used by StreamPackLite for RTMP/SRT streaming.
 *
 * The stock {@code Camera2Capturer} from webrtc-sdk does not set any of these
 * optimizations, leaving the camera HAL running CPU-intensive post-processing
 * (noise reduction, edge enhancement, hot-pixel correction, video stabilization).
 *
 * Key optimizations:
 * <ul>
 *   <li>TEMPLATE_RECORD for stable framerate from camera HAL</li>
 *   <li>NOISE_REDUCTION_MODE_FAST — hardware-accelerated instead of CPU-intensive</li>
 *   <li>EDGE_MODE_FAST</li>
 *   <li>HOT_PIXEL_MODE_FAST</li>
 *   <li>Video stabilization OFF</li>
 *   <li>Fixed FPS range [fps, fps]</li>
 *   <li>Low-priority camera handler thread</li>
 * </ul>
 */
@SuppressLint("MissingPermission")
public class WhipCameraCapturer implements VideoCapturer {

  private static final String TAG = "WhipCameraCapturer";

  private SurfaceTextureHelper mSurfaceTextureHelper;
  private Context mContext;
  private CapturerObserver mObserver;

  private HandlerThread mCameraThread;
  private Handler mCameraHandler;

  private CameraDevice mCameraDevice;
  private CameraCaptureSession mCaptureSession;

  private int mWidth;
  private int mHeight;
  private int mFps;
  private int mCaptureWidth;
  private int mCaptureHeight;
  private int mSensorOrientation;
  private int mFrameRotation;
  private boolean mIsFrontCamera;
  private boolean mLoggedFrameSize = false;

  @Override
  public void initialize(SurfaceTextureHelper surfaceTextureHelper, Context context,
      CapturerObserver observer) {
    mSurfaceTextureHelper = surfaceTextureHelper;
    mContext = context;
    mObserver = observer;
  }

  @Override
  public void startCapture(int width, int height, int fps) {
    mWidth = width;
    mHeight = height;
    mFps = fps;
    mLoggedFrameSize = false;

    // Low-priority camera thread (matches StreamPackLite CameraExecutorManager)
    mCameraThread = new HandlerThread("WhipCameraThread");
    mCameraThread.start();
    mCameraThread.getLooper().getThread().setPriority(Thread.MIN_PRIORITY);
    mCameraHandler = new Handler(mCameraThread.getLooper());

    mSurfaceTextureHelper.setTextureSize(width, height);

    CameraManager cameraManager =
        (CameraManager) mContext.getSystemService(Context.CAMERA_SERVICE);

    String cameraId = selectBackCamera(cameraManager);
    if (cameraId == null) {
      Log.e(TAG, "No back-facing camera found");
      mObserver.onCapturerStarted(false);
      return;
    }

    try {
      CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
      Integer sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
      mSensorOrientation = sensorOrientation != null ? sensorOrientation : 90;
      Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
      mIsFrontCamera = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT;
      Size captureSize = chooseCaptureSize(chars, width, height);
      mCaptureWidth = captureSize.getWidth();
      mCaptureHeight = captureSize.getHeight();
      mSurfaceTextureHelper.setTextureSize(mCaptureWidth, mCaptureHeight);
      mFrameRotation = getFrameOrientation();
    } catch (CameraAccessException e) {
      Log.w(TAG, "Failed to get camera characteristics", e);
      mSensorOrientation = 90;
      mIsFrontCamera = false;
      mCaptureWidth = width;
      mCaptureHeight = height;
      mSurfaceTextureHelper.setTextureSize(mCaptureWidth, mCaptureHeight);
      mFrameRotation = 0;
    }

    Log.d(TAG, "Requested capture: " + mWidth + "x" + mHeight
        + ", selected camera size: " + mCaptureWidth + "x" + mCaptureHeight
        + ", sensor orientation: " + mSensorOrientation
        + ", isFront: " + mIsFrontCamera
        + ", frame rotation: " + mFrameRotation);

    try {
      cameraManager.openCamera(cameraId, new CameraDevice.StateCallback() {
        @Override
        public void onOpened(@NonNull CameraDevice camera) {
          mCameraDevice = camera;
          createCaptureSession();
        }

        @Override
        public void onDisconnected(@NonNull CameraDevice camera) {
          Log.w(TAG, "Camera disconnected");
          camera.close();
          mCameraDevice = null;
          mObserver.onCapturerStarted(false);
        }

        @Override
        public void onError(@NonNull CameraDevice camera, int error) {
          Log.e(TAG, "Camera error: " + error);
          camera.close();
          mCameraDevice = null;
          mObserver.onCapturerStarted(false);
        }
      }, mCameraHandler);
    } catch (CameraAccessException e) {
      Log.e(TAG, "Failed to open camera", e);
      mObserver.onCapturerStarted(false);
    }
  }

  private void createCaptureSession() {
    Surface surface = new Surface(mSurfaceTextureHelper.getSurfaceTexture());

    try {
      mCameraDevice.createCaptureSession(
          Collections.singletonList(surface),
          new CameraCaptureSession.StateCallback() {
            @Override
            public void onConfigured(@NonNull CameraCaptureSession session) {
              mCaptureSession = session;
              startRepeatingRequest(surface);
            }

            @Override
            public void onConfigureFailed(@NonNull CameraCaptureSession session) {
              Log.e(TAG, "Capture session configuration failed");
              mObserver.onCapturerStarted(false);
            }
          },
          mCameraHandler);
    } catch (CameraAccessException e) {
      Log.e(TAG, "Failed to create capture session", e);
      mObserver.onCapturerStarted(false);
    }
  }

  /**
   * Build and start a repeating capture request with StreamPackLite's
   * power-saving optimizations applied.
   */
  private void startRepeatingRequest(Surface surface) {
    try {
      // TEMPLATE_PREVIEW: lighter processing than TEMPLATE_RECORD, reduces thermal load
      CaptureRequest.Builder builder =
          mCameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
      builder.addTarget(surface);

      // Fixed FPS range
      builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
          new Range<>(mFps, mFps));
      builder.set(CaptureRequest.CONTROL_MODE,
          CaptureRequest.CONTROL_MODE_AUTO);

      // Power-saving: disable video stabilization
      builder.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
          CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF);

      // Continuous video autofocus (less CPU than picture mode)
      builder.set(CaptureRequest.CONTROL_AF_MODE,
          CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);

      // Auto white balance
      builder.set(CaptureRequest.CONTROL_AWB_MODE,
          CaptureRequest.CONTROL_AWB_MODE_AUTO);

      // All post-processing OFF: maximum thermal savings
      builder.set(CaptureRequest.NOISE_REDUCTION_MODE,
          CaptureRequest.NOISE_REDUCTION_MODE_OFF);
      builder.set(CaptureRequest.EDGE_MODE,
          CaptureRequest.EDGE_MODE_OFF);
      builder.set(CaptureRequest.HOT_PIXEL_MODE,
          CaptureRequest.HOT_PIXEL_MODE_OFF);

      mCaptureSession.setRepeatingRequest(builder.build(), null, mCameraHandler);

      // Match the stock WebRTC Camera2 session semantics:
      // 1. Apply a texture transform for sensor/front-camera correction.
      // 2. Preserve frame rotation metadata so downstream width/height handling stays correct.
      mSurfaceTextureHelper.startListening(frame -> {
        TextureBufferImpl texBuffer = (TextureBufferImpl) frame.getBuffer();

        if (!mLoggedFrameSize) {
          mLoggedFrameSize = true;
          Log.i(TAG, "DIAG: First frame buffer size: " + texBuffer.getWidth() + "x"
              + texBuffer.getHeight() + " (requested: " + mWidth + "x" + mHeight
              + ", selected camera size: " + mCaptureWidth + "x" + mCaptureHeight
              + ", sensor orientation: " + mSensorOrientation
              + ", frame rotation: " + mFrameRotation + ")");
        }

        TextureBufferImpl modifiedBuffer = texBuffer.applyTransformMatrix(
            createTextureTransformMatrix(), texBuffer.getWidth(), texBuffer.getHeight());

        VideoFrame modifiedFrame = new VideoFrame(
            modifiedBuffer, mFrameRotation, frame.getTimestampNs());
        mObserver.onFrameCaptured(modifiedFrame);
        modifiedFrame.release();
      });

      mObserver.onCapturerStarted(true);
      Log.d(TAG, "Camera capture started with power-saving optimizations: "
          + mCaptureWidth + "x" + mCaptureHeight + " @" + mFps + "fps");

    } catch (CameraAccessException e) {
      Log.e(TAG, "Failed to start repeating request", e);
      mObserver.onCapturerStarted(false);
    }
  }

  @Override
  public void stopCapture() throws InterruptedException {
    if (mSurfaceTextureHelper != null) {
      mSurfaceTextureHelper.stopListening();
    }

    if (mCaptureSession != null) {
      try {
        mCaptureSession.stopRepeating();
      } catch (CameraAccessException e) {
        Log.w(TAG, "Error stopping repeating request", e);
      }
      mCaptureSession.close();
      mCaptureSession = null;
    }

    if (mCameraDevice != null) {
      mCameraDevice.close();
      mCameraDevice = null;
    }

    if (mCameraThread != null) {
      mCameraThread.quitSafely();
      mCameraThread.join(2000);
      mCameraThread = null;
      mCameraHandler = null;
    }

    Log.d(TAG, "Camera capture stopped");
  }

  @Override
  public void changeCaptureFormat(int width, int height, int fps) {
    try {
      stopCapture();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
    startCapture(width, height, fps);
  }

  @Override
  public void dispose() {
    try {
      stopCapture();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  @Override
  public boolean isScreencast() {
    return false;
  }

  private String selectBackCamera(CameraManager cameraManager) {
    try {
      for (String id : cameraManager.getCameraIdList()) {
        CameraCharacteristics chars = cameraManager.getCameraCharacteristics(id);
        Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
        if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
          return id;
        }
      }
      // Fallback: return first available camera
      String[] ids = cameraManager.getCameraIdList();
      return ids.length > 0 ? ids[0] : null;
    } catch (CameraAccessException e) {
      Log.e(TAG, "Failed to enumerate cameras", e);
      return null;
    }
  }

  private Matrix createTextureTransformMatrix() {
    Matrix transformMatrix = new Matrix();
    transformMatrix.preTranslate(0.5f, 0.5f);
    if (mIsFrontCamera) {
      transformMatrix.preScale(-1f, 1f);
    }
    transformMatrix.preRotate(-mSensorOrientation);
    transformMatrix.preTranslate(-0.5f, -0.5f);
    return transformMatrix;
  }

  private int getFrameOrientation() {
    int deviceOrientation = getDeviceOrientationDegrees();
    if (!mIsFrontCamera) {
      deviceOrientation = (360 - deviceOrientation) % 360;
    }
    return (mSensorOrientation + deviceOrientation) % 360;
  }

  private int getDeviceOrientationDegrees() {
    if (ServiceUtils.isK900Device(mContext)) {
      return ServiceUtils.determineDefaultRotationForDevice(mContext);
    }

    WindowManager windowManager =
        (WindowManager) mContext.getSystemService(Context.WINDOW_SERVICE);
    if (windowManager == null) {
      return ServiceUtils.determineDefaultRotationForDevice(mContext);
    }

    switch (windowManager.getDefaultDisplay().getRotation()) {
      case Surface.ROTATION_90:
        return 90;
      case Surface.ROTATION_180:
        return 180;
      case Surface.ROTATION_270:
        return 270;
      case Surface.ROTATION_0:
      default:
        return 0;
    }
  }

  private Size chooseCaptureSize(CameraCharacteristics characteristics, int requestedWidth,
      int requestedHeight) {
    StreamConfigurationMap configurationMap =
        characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    if (configurationMap == null) {
      Log.w(TAG, "No stream configuration map; using requested size "
          + requestedWidth + "x" + requestedHeight);
      return new Size(requestedWidth, requestedHeight);
    }

    Size[] outputSizes = configurationMap.getOutputSizes(SurfaceTexture.class);
    if (outputSizes == null || outputSizes.length == 0) {
      Log.w(TAG, "No SurfaceTexture output sizes; using requested size "
          + requestedWidth + "x" + requestedHeight);
      return new Size(requestedWidth, requestedHeight);
    }

    Size requestedSize = normalizeLandscapeSize(new Size(requestedWidth, requestedHeight));
    Size bestSize = normalizeLandscapeSize(outputSizes[0]);
    float requestedAspectRatio = requestedSize.getWidth() / (float) requestedSize.getHeight();
    long requestedArea = (long) requestedSize.getWidth() * requestedSize.getHeight();
    double bestAspectDelta = Double.MAX_VALUE;
    boolean bestMeetsRequestedSize = false;
    long bestAreaDelta = Long.MAX_VALUE;

    for (Size rawSize : outputSizes) {
      Size candidate = normalizeLandscapeSize(rawSize);
      float candidateAspectRatio = candidate.getWidth() / (float) candidate.getHeight();
      double aspectDelta = Math.abs(candidateAspectRatio - requestedAspectRatio);
      boolean meetsRequestedSize = candidate.getWidth() >= requestedSize.getWidth()
          && candidate.getHeight() >= requestedSize.getHeight();
      long candidateArea = (long) candidate.getWidth() * candidate.getHeight();
      long areaDelta = Math.abs(candidateArea - requestedArea);

      boolean isBetter = aspectDelta < bestAspectDelta
          || (Double.compare(aspectDelta, bestAspectDelta) == 0
              && meetsRequestedSize && !bestMeetsRequestedSize)
          || (Double.compare(aspectDelta, bestAspectDelta) == 0
              && meetsRequestedSize == bestMeetsRequestedSize
              && areaDelta < bestAreaDelta);

      if (isBetter) {
        bestSize = candidate;
        bestAspectDelta = aspectDelta;
        bestMeetsRequestedSize = meetsRequestedSize;
        bestAreaDelta = areaDelta;
      }
    }

    Log.d(TAG, "Available SurfaceTexture sizes: " + Arrays.toString(outputSizes));
    if (bestAspectDelta > 0.01d) {
      Log.w(TAG, "Selected camera size " + bestSize.getWidth() + "x" + bestSize.getHeight()
          + " is not a close aspect-ratio match for requested " + requestedWidth + "x"
          + requestedHeight);
    }
    return bestSize;
  }

  private Size normalizeLandscapeSize(Size size) {
    return new Size(Math.max(size.getWidth(), size.getHeight()),
        Math.min(size.getWidth(), size.getHeight()));
  }
}

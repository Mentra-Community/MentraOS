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
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Range;
import android.util.Size;
import android.view.Display;
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
  private int mCameraSurfaceWidth;
  private int mCameraSurfaceHeight;
  private int mCaptureWidth;
  private int mCaptureHeight;
  private int mCropX;
  private int mCropY;
  private int mCropWidth;
  private int mCropHeight;
  private int mSensorOrientation;
  private boolean mUseFixedDeviceRotation;
  private int mFallbackDeviceRotation;
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

    CameraManager cameraManager =
        (CameraManager) mContext.getSystemService(Context.CAMERA_SERVICE);

    int initialFrameRotation;
    try {
      String cameraId = WhipCameraFormatSelector.selectBackCamera(cameraManager);
      if (cameraId == null) {
        Log.e(TAG, "No back-facing camera found");
        mObserver.onCapturerStarted(false);
        return;
      }

      CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
      Integer sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
      mSensorOrientation = sensorOrientation != null ? sensorOrientation : 90;
      Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
      mIsFrontCamera = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT;
      WhipCameraFormatSelector.SelectionResult selection =
          WhipCameraFormatSelector.selectCaptureSize(chars, width, height);
      Size captureSize = selection.getRawCaptureSize();
      mCameraSurfaceWidth = captureSize.getWidth();
      mCameraSurfaceHeight = captureSize.getHeight();
      Size normalizedCaptureSize = selection.getNormalizedCaptureSize();
      mCaptureWidth = normalizedCaptureSize.getWidth();
      mCaptureHeight = normalizedCaptureSize.getHeight();
      initializeDeviceRotationState();
      updateOutputCrop();
      mSurfaceTextureHelper.setTextureSize(mCameraSurfaceWidth, mCameraSurfaceHeight);
      initialFrameRotation = getFrameOrientation();

      if (selection.hasSupportedSizes()) {
        Log.d(TAG, "Available SurfaceTexture sizes: "
            + Arrays.toString(selection.getAvailableOutputSizes()));
        if (selection.getTransformPenalty() == 1) {
          Log.d(TAG, "Selected camera size " + mCameraSurfaceWidth + "x" + mCameraSurfaceHeight
              + " will be cropped and downscaled to " + width + "x" + height);
        } else if (selection.getTransformPenalty() == 2) {
          Log.w(TAG, "Selected camera size " + mCameraSurfaceWidth + "x" + mCameraSurfaceHeight
              + " cannot reach requested " + width + "x" + height + " without upscaling");
        }
      }

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
      mSensorOrientation = 90;
      mIsFrontCamera = false;
      mCameraSurfaceWidth = width;
      mCameraSurfaceHeight = height;
      mCaptureWidth = width;
      mCaptureHeight = height;
      initializeDeviceRotationState();
      updateOutputCrop();
      mSurfaceTextureHelper.setTextureSize(mCameraSurfaceWidth, mCameraSurfaceHeight);
      initialFrameRotation = 0;
      Log.e(TAG, "Failed to configure or open camera", e);
      mObserver.onCapturerStarted(false);
      return;
    }

    Log.d(TAG, "Requested capture: " + mWidth + "x" + mHeight
        + ", selected camera size: " + mCameraSurfaceWidth + "x" + mCameraSurfaceHeight
        + ", normalized capture size: " + mCaptureWidth + "x" + mCaptureHeight
        + ", crop window: " + mCropWidth + "x" + mCropHeight + " @ (" + mCropX + ", " + mCropY
        + ")"
        + ", sensor orientation: " + mSensorOrientation
        + ", isFront: " + mIsFrontCamera
        + ", frame rotation: " + initialFrameRotation);
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
        int frameRotation = getFrameOrientation();

        if (!mLoggedFrameSize) {
          mLoggedFrameSize = true;
          Log.i(TAG, "DIAG: First frame buffer size: " + texBuffer.getWidth() + "x"
              + texBuffer.getHeight() + " (requested: " + mWidth + "x" + mHeight
              + ", selected camera size: " + mCameraSurfaceWidth + "x" + mCameraSurfaceHeight
              + ", normalized capture size: " + mCaptureWidth + "x" + mCaptureHeight
              + ", crop window: " + mCropWidth + "x" + mCropHeight + " @ (" + mCropX + ", "
              + mCropY + ")"
              + ", sensor orientation: " + mSensorOrientation
              + ", frame rotation: " + frameRotation + ")");
        }

        TextureBufferImpl modifiedBuffer = texBuffer.applyTransformMatrix(
            createTextureTransformMatrix(), texBuffer.getWidth(), texBuffer.getHeight());
        VideoFrame.Buffer outputBuffer = adaptOutputBuffer(modifiedBuffer);
        if (outputBuffer != modifiedBuffer) {
          modifiedBuffer.release();
        }

        VideoFrame modifiedFrame = new VideoFrame(
            outputBuffer, frameRotation, frame.getTimestampNs());
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

  private void initializeDeviceRotationState() {
    mUseFixedDeviceRotation = ServiceUtils.isK900Device(mContext);
    mFallbackDeviceRotation = ServiceUtils.determineDefaultRotationForDevice(mContext);
  }

  private int getDeviceOrientationDegrees() {
    if (mUseFixedDeviceRotation) {
      return mFallbackDeviceRotation;
    }

    WindowManager windowManager =
        (WindowManager) mContext.getSystemService(Context.WINDOW_SERVICE);
    if (windowManager == null) {
      return mFallbackDeviceRotation;
    }

    Display display = null;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      display = mContext.getDisplay();
    }
    if (display == null) {
      @SuppressWarnings("deprecation")
      Display fallbackDisplay = windowManager.getDefaultDisplay();
      display = fallbackDisplay;
    }
    if (display == null) {
      return mFallbackDeviceRotation;
    }

    switch (display.getRotation()) {
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

  private void updateOutputCrop() {
    Size cropSize = getCenterCropSize(mCaptureWidth, mCaptureHeight, mWidth, mHeight);
    mCropWidth = cropSize.getWidth();
    mCropHeight = cropSize.getHeight();
    mCropX = Math.max(0, (mCaptureWidth - mCropWidth) / 2);
    mCropY = Math.max(0, (mCaptureHeight - mCropHeight) / 2);
  }

  private VideoFrame.Buffer adaptOutputBuffer(TextureBufferImpl buffer) {
    boolean needsCrop = mCropX != 0 || mCropY != 0
        || mCropWidth != buffer.getWidth() || mCropHeight != buffer.getHeight();
    boolean needsScale = buffer.getWidth() != mWidth || buffer.getHeight() != mHeight;

    if (!needsCrop && !needsScale) {
      return buffer;
    }

    return buffer.cropAndScale(mCropX, mCropY, mCropWidth, mCropHeight, mWidth, mHeight);
  }

  private Size getCenterCropSize(int sourceWidth, int sourceHeight, int targetWidth,
      int targetHeight) {
    if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
      return new Size(sourceWidth, sourceHeight);
    }

    float sourceAspectRatio = sourceWidth / (float) sourceHeight;
    float targetAspectRatio = targetWidth / (float) targetHeight;
    int cropWidth = sourceWidth;
    int cropHeight = sourceHeight;

    if (Math.abs(sourceAspectRatio - targetAspectRatio) > 0.0001f) {
      if (sourceAspectRatio > targetAspectRatio) {
        cropWidth = Math.round(sourceHeight * targetAspectRatio);
      } else {
        cropHeight = Math.round(sourceWidth / targetAspectRatio);
      }
    }

    cropWidth = Math.max(1, Math.min(sourceWidth, cropWidth));
    cropHeight = Math.max(1, Math.min(sourceHeight, cropHeight));
    return new Size(cropWidth, cropHeight);
  }

  private Size normalizeLandscapeSize(Size size) {
    return new Size(Math.max(size.getWidth(), size.getHeight()),
        Math.min(size.getWidth(), size.getHeight()));
  }
}

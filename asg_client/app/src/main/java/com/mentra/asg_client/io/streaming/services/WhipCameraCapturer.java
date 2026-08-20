package com.mentra.asg_client.io.streaming.services;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Matrix;
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
import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;
import com.mentra.asg_client.service.utils.DeviceProfile;
import com.mentra.asg_client.service.utils.ServiceUtils;
import java.util.Collections;
import org.webrtc.CapturerObserver;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.TextureBufferImpl;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoFrame;

/**
 * Custom Camera2-based {@link VideoCapturer} that applies the same power-saving CaptureRequest
 * optimizations used by StreamPackLite for RTMP/SRT streaming.
 *
 * <p>The stock {@code Camera2Capturer} from webrtc-sdk does not set any of these optimizations,
 * leaving the camera HAL running CPU-intensive post-processing (noise reduction, edge enhancement,
 * hot-pixel correction, video stabilization).
 *
 * <p>Key optimizations:
 *
 * <ul>
 *   <li>TEMPLATE_RECORD for stable framerate from camera HAL
 *   <li>NOISE_REDUCTION_MODE_FAST — hardware-accelerated instead of CPU-intensive
 *   <li>EDGE_MODE_FAST
 *   <li>HOT_PIXEL_MODE_FAST
 *   <li>Video stabilization OFF
 *   <li>Fixed FPS range [fps, fps]
 *   <li>Low-priority camera handler thread
 * </ul>
 */
@SuppressLint("MissingPermission")
public class WhipCameraCapturer implements VideoCapturer {

    private static final String TAG = "WhipCameraCapturer";

    private SurfaceTextureHelper mSurfaceTextureHelper;
    private Context mContext;
    private CapturerObserver mObserver;
    private CameraFpsListener mCameraFpsListener;

    private HandlerThread mCameraThread;
    private Handler mCameraHandler;

    private final Object mCameraStateLock = new Object();
    private CameraDevice mCameraDevice;
    private CameraCaptureSession mCaptureSession;
    private boolean mStopRequested;

    private int mWidth;
    private int mHeight;
    private int mRequestedFps;
    private int mOutputFps;
    private int mCameraFps;
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
    private long mNextForwardFrameTimestampNs;
    private long mOutputFrameIntervalNs;
    private int mDroppedFrameCount;

    public interface CameraFpsListener {
        void onCameraFpsChanged(double fps);
    }

    @Override
    public void initialize(
            SurfaceTextureHelper surfaceTextureHelper, Context context, CapturerObserver observer) {
        mSurfaceTextureHelper = surfaceTextureHelper;
        mContext = context;
        mObserver = observer;
    }

    public void setCameraFpsListener(CameraFpsListener listener) {
        mCameraFpsListener = listener;
    }

    @Override
    public void startCapture(int width, int height, int fps) {
        mWidth = width;
        mHeight = height;
        mRequestedFps = fps;
        mOutputFps = clamp(fps, WhipStreamConfig.MIN_VIDEO_FPS, WhipStreamConfig.MAX_VIDEO_FPS);
        mCameraFps = mOutputFps;
        mOutputFrameIntervalNs = fpsToIntervalNs(mOutputFps);
        mNextForwardFrameTimestampNs = 0L;
        mDroppedFrameCount = 0;
        mLoggedFrameSize = false;
        synchronized (mCameraStateLock) {
            mStopRequested = false;
            mCameraDevice = null;
            mCaptureSession = null;
        }

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
                cleanupAfterStartFailure();
                return;
            }

            CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
            Integer sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            mSensorOrientation = sensorOrientation != null ? sensorOrientation : 90;
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            mIsFrontCamera = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT;
            mCameraFps = resolveCameraFps(chars, mOutputFps);
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

            WhipCameraFormatSelector.logCameraLivestreamResolutions(
                    cameraId, width, height, selection);

            Log.i(
                    TAG,
                    "Resolved WHIP capture fps: requested="
                            + mRequestedFps
                            + ", output="
                            + mOutputFps
                            + ", camera="
                            + mCameraFps);
            // Report the effective transmitted rate: when the camera runs faster than the output
            // target, frames are dropped to pace the track at mOutputFps; when it runs slower, the
            // track is capped at mCameraFps. The resolved fps is the lower of the two.
            notifyCameraFps(Math.min(mCameraFps, mOutputFps));

            cameraManager.openCamera(
                    cameraId,
                    new CameraDevice.StateCallback() {
                        @Override
                        public void onOpened(@NonNull CameraDevice camera) {
                            synchronized (mCameraStateLock) {
                                if (mStopRequested) {
                                    Log.w(TAG, "Camera opened after WHIP capture stopped; closing stale camera");
                                    camera.close();
                                    return;
                                }
                                mCameraDevice = camera;
                            }
                            createCaptureSession();
                        }

                        @Override
                        public void onDisconnected(@NonNull CameraDevice camera) {
                            Log.w(TAG, "Camera disconnected");
                            camera.close();
                            boolean notifyFailure;
                            synchronized (mCameraStateLock) {
                                if (mCameraDevice == camera) {
                                    mCameraDevice = null;
                                }
                                notifyFailure = !mStopRequested;
                            }
                            if (notifyFailure) {
                                mObserver.onCapturerStarted(false);
                                cleanupAfterStartFailure();
                            }
                        }

                        @Override
                        public void onError(@NonNull CameraDevice camera, int error) {
                            Log.e(TAG, "Camera error: " + error);
                            camera.close();
                            boolean notifyFailure;
                            synchronized (mCameraStateLock) {
                                if (mCameraDevice == camera) {
                                    mCameraDevice = null;
                                }
                                notifyFailure = !mStopRequested;
                            }
                            if (notifyFailure) {
                                mObserver.onCapturerStarted(false);
                                cleanupAfterStartFailure();
                            }
                        }
                    },
                    mCameraHandler);
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
            cleanupAfterStartFailure();
            return;
        }

        Log.d(
                TAG,
                "Requested capture: "
                        + mWidth
                        + "x"
                        + mHeight
                        + " @"
                        + mRequestedFps
                        + "fps"
                        + ", output fps: "
                        + mOutputFps
                        + ", camera fps: "
                        + mCameraFps
                        + ", selected camera size: "
                        + mCameraSurfaceWidth
                        + "x"
                        + mCameraSurfaceHeight
                        + ", normalized capture size: "
                        + mCaptureWidth
                        + "x"
                        + mCaptureHeight
                        + ", crop window: "
                        + mCropWidth
                        + "x"
                        + mCropHeight
                        + " @ ("
                        + mCropX
                        + ", "
                        + mCropY
                        + ")"
                        + ", sensor orientation: "
                        + mSensorOrientation
                        + ", isFront: "
                        + mIsFrontCamera
                        + ", frame rotation: "
                        + initialFrameRotation);
    }

    private void createCaptureSession() {
        CameraDevice cameraDevice;
        Handler cameraHandler;
        synchronized (mCameraStateLock) {
            if (mStopRequested || mCameraDevice == null || mCameraHandler == null) {
                Log.w(TAG, "Skipping WHIP capture session creation after capture stopped");
                return;
            }
            cameraDevice = mCameraDevice;
            cameraHandler = mCameraHandler;
        }
        Surface surface = new Surface(mSurfaceTextureHelper.getSurfaceTexture());

        try {
            cameraDevice.createCaptureSession(
                    Collections.singletonList(surface),
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(@NonNull CameraCaptureSession session) {
                            synchronized (mCameraStateLock) {
                                if (mStopRequested
                                        || mCameraDevice == null
                                        || session.getDevice() != mCameraDevice) {
                                    Log.w(
                                            TAG,
                                            "WHIP capture session configured after capture stopped or camera changed; closing stale session");
                                    session.close();
                                    return;
                                }
                                mCaptureSession = session;
                            }
                            startRepeatingRequest(surface);
                        }

                        @Override
                        public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                            Log.e(TAG, "Capture session configuration failed");
                            if (!isStopRequested()) {
                                mObserver.onCapturerStarted(false);
                                cleanupAfterStartFailure();
                            }
                        }
                    },
                    cameraHandler);
        } catch (CameraAccessException e) {
            Log.e(TAG, "Failed to create capture session", e);
            if (!isStopRequested()) {
                mObserver.onCapturerStarted(false);
                cleanupAfterStartFailure();
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "Failed to create capture session due to stale camera state", e);
            if (!isStopRequested()) {
                mObserver.onCapturerStarted(false);
                cleanupAfterStartFailure();
            }
        }
    }

    /**
     * Build and start a repeating capture request with StreamPackLite's power-saving optimizations
     * applied.
     */
    private void startRepeatingRequest(Surface surface) {
        CameraDevice cameraDevice;
        CameraCaptureSession captureSession;
        Handler cameraHandler;
        synchronized (mCameraStateLock) {
            if (mStopRequested
                    || mCameraDevice == null
                    || mCaptureSession == null
                    || mCameraHandler == null) {
                Log.w(TAG, "Skipping stale WHIP repeating request after capture stopped");
                return;
            }
            cameraDevice = mCameraDevice;
            captureSession = mCaptureSession;
            cameraHandler = mCameraHandler;
        }

        try {
            // TEMPLATE_PREVIEW: lighter processing than TEMPLATE_RECORD, reduces thermal load
            CaptureRequest.Builder builder =
                    cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(surface);

            // Fixed FPS range. On K900, values inside the advertised [5,30] range are honored
            // even when they are not listed as standalone fixed ranges.
            builder.set(
                    CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
                    new Range<>(mCameraFps, mCameraFps));
            builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);

            // Power-saving: disable video stabilization
            builder.set(
                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF);

            // Continuous video autofocus (less CPU than picture mode)
            builder.set(
                    CaptureRequest.CONTROL_AF_MODE,
                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);

            // Auto white balance
            builder.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);

            // All post-processing OFF: maximum thermal savings
            builder.set(
                    CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_OFF);
            builder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_OFF);
            builder.set(CaptureRequest.HOT_PIXEL_MODE, CaptureRequest.HOT_PIXEL_MODE_OFF);

            // Avoid per-frame metadata callbacks: SENSOR_FRAME_DURATION is instantaneous and can
            // make
            // resolvedConfig.video.fps jitter even though the requested camera FPS is stable.
            captureSession.setRepeatingRequest(builder.build(), null, cameraHandler);

            // Match the stock WebRTC Camera2 session semantics:
            // 1. Apply a texture transform for sensor/front-camera correction.
            // 2. Preserve frame rotation metadata so downstream width/height handling stays
            // correct.
            mSurfaceTextureHelper.startListening(
                    frame -> {
                        if (shouldDropFrame(frame.getTimestampNs())) {
                            // SurfaceTextureHelper owns and releases this input frame after onFrame
                            // returns.
                            return;
                        }

                        TextureBufferImpl texBuffer = (TextureBufferImpl) frame.getBuffer();
                        int frameRotation = getFrameOrientation();

                        if (!mLoggedFrameSize) {
                            mLoggedFrameSize = true;
                            Log.i(
                                    TAG,
                                    "DIAG: First frame buffer size: "
                                            + texBuffer.getWidth()
                                            + "x"
                                            + texBuffer.getHeight()
                                            + " (requested: "
                                            + mWidth
                                            + "x"
                                            + mHeight
                                            + ", selected camera size: "
                                            + mCameraSurfaceWidth
                                            + "x"
                                            + mCameraSurfaceHeight
                                            + ", normalized capture size: "
                                            + mCaptureWidth
                                            + "x"
                                            + mCaptureHeight
                                            + ", output fps: "
                                            + mOutputFps
                                            + ", camera fps: "
                                            + mCameraFps
                                            + ", crop window: "
                                            + mCropWidth
                                            + "x"
                                            + mCropHeight
                                            + " @ ("
                                            + mCropX
                                            + ", "
                                            + mCropY
                                            + ")"
                                            + ", sensor orientation: "
                                            + mSensorOrientation
                                            + ", frame rotation: "
                                            + frameRotation
                                            + ")");
                        }

                        TextureBufferImpl modifiedBuffer = null;
                        VideoFrame.Buffer outputBuffer = null;
                        VideoFrame modifiedFrame = null;
                        try {
                            modifiedBuffer =
                                    texBuffer.applyTransformMatrix(
                                            createTextureTransformMatrix(),
                                            texBuffer.getWidth(),
                                            texBuffer.getHeight());
                            outputBuffer = adaptOutputBuffer(modifiedBuffer);
                            if (outputBuffer != modifiedBuffer) {
                                modifiedBuffer.release();
                                modifiedBuffer = null;
                            }

                            VideoFrame.Buffer frameBuffer = outputBuffer;
                            if (frameBuffer == modifiedBuffer) {
                                modifiedBuffer = null;
                            }
                            modifiedFrame =
                                    new VideoFrame(
                                            frameBuffer, frameRotation, frame.getTimestampNs());
                            outputBuffer = null;
                            mObserver.onFrameCaptured(modifiedFrame);
                        } finally {
                            if (modifiedFrame != null) {
                                modifiedFrame.release();
                            } else {
                                if (outputBuffer != null) {
                                    outputBuffer.release();
                                }
                                if (modifiedBuffer != null) {
                                    modifiedBuffer.release();
                                }
                            }
                        }
                    });

            mObserver.onCapturerStarted(true);
            Log.d(
                    TAG,
                    "Camera capture started with power-saving optimizations: "
                            + mCaptureWidth
                            + "x"
                            + mCaptureHeight
                            + " @ camera "
                            + mCameraFps
                            + "fps, output "
                            + mOutputFps
                            + "fps");

        } catch (CameraAccessException e) {
            Log.e(TAG, "Failed to start repeating request", e);
            if (!isStopRequested()) {
                mObserver.onCapturerStarted(false);
                cleanupAfterStartFailure();
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "Failed to start repeating request due to stale camera state", e);
            if (!isStopRequested()) {
                mObserver.onCapturerStarted(false);
                cleanupAfterStartFailure();
            }
        }
    }

    @Override
    public void stopCapture() throws InterruptedException {
        CameraCaptureSession captureSession;
        CameraDevice cameraDevice;
        synchronized (mCameraStateLock) {
            mStopRequested = true;
            captureSession = mCaptureSession;
            mCaptureSession = null;
            cameraDevice = mCameraDevice;
            mCameraDevice = null;
        }

        if (mSurfaceTextureHelper != null) {
            mSurfaceTextureHelper.stopListening();
        }

        if (captureSession != null) {
            try {
                captureSession.stopRepeating();
            } catch (CameraAccessException e) {
                Log.w(TAG, "Error stopping repeating request", e);
            }
            captureSession.close();
        }

        if (cameraDevice != null) {
            cameraDevice.close();
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

    private void cleanupAfterStartFailure() {
        CameraCaptureSession captureSession;
        CameraDevice cameraDevice;
        HandlerThread cameraThread;
        synchronized (mCameraStateLock) {
            mStopRequested = true;
            captureSession = mCaptureSession;
            mCaptureSession = null;
            cameraDevice = mCameraDevice;
            mCameraDevice = null;
            cameraThread = mCameraThread;
            mCameraThread = null;
            mCameraHandler = null;
        }

        if (mSurfaceTextureHelper != null) {
            mSurfaceTextureHelper.stopListening();
        }

        if (captureSession != null) {
            captureSession.close();
        }

        if (cameraDevice != null) {
            cameraDevice.close();
        }

        if (cameraThread != null) {
            cameraThread.quitSafely();
            if (Thread.currentThread() != cameraThread) {
                try {
                    cameraThread.join(2000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    private boolean isStopRequested() {
        synchronized (mCameraStateLock) {
            return mStopRequested;
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static long fpsToIntervalNs(int fps) {
        return Math.round(1_000_000_000.0 / Math.max(1, fps));
    }

    public static int resolveCameraFps(CameraCharacteristics chars, int outputFps) {
        Range<Integer>[] ranges =
                chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (ranges == null || ranges.length == 0) {
            return clamp(outputFps, WhipStreamConfig.MIN_VIDEO_FPS, WhipStreamConfig.MAX_VIDEO_FPS);
        }

        int minSupportedFps = Integer.MAX_VALUE;
        int maxSupportedFps = 0;
        int closestFps = outputFps;
        int closestDistance = Integer.MAX_VALUE;

        for (Range<Integer> range : ranges) {
            int lower = range.getLower();
            int upper = range.getUpper();
            minSupportedFps = Math.min(minSupportedFps, lower);
            maxSupportedFps = Math.max(maxSupportedFps, upper);

            if (range.contains(outputFps)) {
                return outputFps;
            }

            int lowerDistance = Math.abs(outputFps - lower);
            if (lowerDistance < closestDistance) {
                closestDistance = lowerDistance;
                closestFps = lower;
            }

            int upperDistance = Math.abs(outputFps - upper);
            if (upperDistance < closestDistance) {
                closestDistance = upperDistance;
                closestFps = upper;
            }
        }

        if (outputFps < minSupportedFps) {
            return minSupportedFps;
        }
        if (outputFps > maxSupportedFps) {
            return maxSupportedFps;
        }
        return closestFps;
    }

    private boolean shouldDropFrame(long frameTimestampNs) {
        if (mCameraFps <= mOutputFps) {
            return false;
        }

        long timestampNs = frameTimestampNs > 0 ? frameTimestampNs : System.nanoTime();
        if (mNextForwardFrameTimestampNs <= 0L) {
            mNextForwardFrameTimestampNs = timestampNs + mOutputFrameIntervalNs;
            return false;
        }

        if (timestampNs < mNextForwardFrameTimestampNs) {
            mDroppedFrameCount++;
            if (mDroppedFrameCount % Math.max(1, mCameraFps) == 0) {
                Log.d(
                        TAG,
                        "Dropped "
                                + mDroppedFrameCount
                                + " WHIP frames to keep output at "
                                + mOutputFps
                                + "fps from camera "
                                + mCameraFps
                                + "fps");
            }
            return true;
        }

        while (mNextForwardFrameTimestampNs <= timestampNs) {
            mNextForwardFrameTimestampNs += mOutputFrameIntervalNs;
        }
        return false;
    }

    private void notifyCameraFps(double fps) {
        CameraFpsListener listener = mCameraFpsListener;
        if (listener != null) {
            listener.onCameraFpsChanged(fps);
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

    private void initializeDeviceRotationState() {
        mUseFixedDeviceRotation = DeviceProfile.detect(mContext).isK900();
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
        boolean needsCrop =
                mCropX != 0
                        || mCropY != 0
                        || mCropWidth != buffer.getWidth()
                        || mCropHeight != buffer.getHeight();
        boolean needsScale = buffer.getWidth() != mWidth || buffer.getHeight() != mHeight;

        if (!needsCrop && !needsScale) {
            return buffer;
        }

        if (mCropWidth < mWidth || mCropHeight < mHeight) {
            Log.w(
                    TAG,
                    "UNEXPECTED upscale path: crop "
                            + mCropWidth
                            + "x"
                            + mCropHeight
                            + " -> output "
                            + mWidth
                            + "x"
                            + mHeight
                            + " (preflight should have rejected this)");
        }

        return buffer.cropAndScale(mCropX, mCropY, mCropWidth, mCropHeight, mWidth, mHeight);
    }

    private Size getCenterCropSize(
            int sourceWidth, int sourceHeight, int targetWidth, int targetHeight) {
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
        return new Size(
                Math.max(size.getWidth(), size.getHeight()),
                Math.min(size.getWidth(), size.getHeight()));
    }
}

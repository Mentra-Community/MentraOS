package com.augmentos.asg_client.camera;

import static com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.isK900Device;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.util.Log;
import android.util.Size;
import android.view.Surface;
import android.view.WindowManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.lifecycle.LifecycleService;

import com.augmentos.asg_client.R;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

public class CameraNeo extends LifecycleService {
    private static final String TAG = "CameraNeo";
    private static final String CHANNEL_ID = "CameraNeoServiceChannel";
    private static final int NOTIFICATION_ID = 1;
    
    // Camera variables
    private CameraDevice cameraDevice = null;
    private CaptureRequest.Builder captureRequestBuilder;
    private CameraCaptureSession cameraCaptureSession;
    private ImageReader imageReader;
    private HandlerThread backgroundThread;
    private Handler backgroundHandler;
    private Semaphore cameraOpenCloseLock = new Semaphore(1);
    private Size jpegSize;
    private String cameraId;
    private boolean isK900Device = false;
    
    // Screen wake variables
    private PowerManager.WakeLock wakeLock;
    private PowerManager.WakeLock fullWakeLock;
    
    // Target photo resolution (4:3 landscape orientation)
    private static final int TARGET_WIDTH = 1440;
    private static final int TARGET_HEIGHT = 1080;
    
    // Callback and execution handling
    private final Executor executor = Executors.newSingleThreadExecutor();

    // Intent action definitions (MOVED TO TOP)
    public static final String ACTION_TAKE_PHOTO = "com.augmentos.camera.ACTION_TAKE_PHOTO";
    public static final String EXTRA_PHOTO_FILE_PATH = "com.augmentos.camera.EXTRA_PHOTO_FILE_PATH";
    public static final String ACTION_START_VIDEO_RECORDING = "com.augmentos.camera.ACTION_START_VIDEO_RECORDING";
    public static final String ACTION_STOP_VIDEO_RECORDING = "com.augmentos.camera.ACTION_STOP_VIDEO_RECORDING";
    public static final String EXTRA_VIDEO_FILE_PATH = "com.augmentos.camera.EXTRA_VIDEO_FILE_PATH";
    public static final String EXTRA_VIDEO_ID = "com.augmentos.camera.EXTRA_VIDEO_ID";
    
    // Callback interface for photo capture
    public interface PhotoCaptureCallback {
        void onPhotoCaptured(String filePath);
        void onPhotoError(String errorMessage);
    }

    // Static callback for photo capture
    private static PhotoCaptureCallback sPhotoCallback;

    // For compatibility with CameraRecordingService
    private static String lastPhotoPath;

    // Video recording components
    private MediaRecorder mediaRecorder;
    private Surface recorderSurface;
    private boolean isRecording = false;
    private String currentVideoId;
    private String currentVideoPath;
    private static VideoRecordingCallback sVideoCallback;
    private long recordingStartTime;
    private Timer recordingTimer;
    private Size videoSize; // To store selected video size

    // Static instance for checking camera status
    private static CameraNeo sInstance;

    /**
     * Interface for video recording callbacks
     */
    public interface VideoRecordingCallback {
        void onRecordingStarted(String videoId);

        void onRecordingProgress(String videoId, long durationMs);

        void onRecordingStopped(String videoId, String filePath);

        void onRecordingError(String videoId, String errorMessage);
    }

    /**
     * Get the path to the most recently captured photo
     * Added for compatibility with CameraRecordingService
     */
    public static String getLastPhotoPath() {
        return lastPhotoPath;
    }

    /**
     * Check if the camera is currently in use for photo capture or video recording.
     * This relies on the service instance being available.
     *
     * @return true if the camera is active, false otherwise.
     */
    public static boolean isCameraInUse() {
        if (sInstance != null) {
            // Check if a photo capture session is active (e.g., cameraDevice is open and not for video)
            // or if video recording is active.
            boolean photoSessionActive = (sInstance.cameraDevice != null && sInstance.imageReader != null && !sInstance.isRecording);
            return photoSessionActive || sInstance.isRecording;
        }
        return false; // Service not running or instance not set
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "CameraNeo Camera2 service created");
        createNotificationChannel();
        showNotification("Camera Service", "Service is running");
        startBackgroundThread();
        sInstance = this; // Set static instance
    }

    /**
     * Take a picture and get notified through callback when complete
     *
     * @param context Application context
     * @param filePath File path to save the photo
     * @param callback Callback to be notified when photo is captured
     */
    public static void takePictureWithCallback(Context context, String filePath, PhotoCaptureCallback callback) {
        sPhotoCallback = callback;

        Intent intent = new Intent(context, CameraNeo.class);
        intent.setAction(ACTION_TAKE_PHOTO);
        intent.putExtra(EXTRA_PHOTO_FILE_PATH, filePath);
        context.startForegroundService(intent);
    }

    /**
     * Start video recording and get notified through callback
     *
     * @param context  Application context
     * @param videoId  Unique ID for this video recording session
     * @param filePath File path to save the video
     * @param callback Callback for recording events
     */
    public static void startVideoRecording(Context context, String videoId, String filePath, VideoRecordingCallback callback) {
        sVideoCallback = callback;

        Intent intent = new Intent(context, CameraNeo.class);
        intent.setAction(ACTION_START_VIDEO_RECORDING);
        intent.putExtra(EXTRA_VIDEO_ID, videoId);
        intent.putExtra(EXTRA_VIDEO_FILE_PATH, filePath);
        context.startForegroundService(intent);
    }

    /**
     * Stop the current video recording session
     *
     * @param context Application context
     * @param videoId ID of the video recording session to stop (must match active session)
     */
    public static void stopVideoRecording(Context context, String videoId) {
        Intent intent = new Intent(context, CameraNeo.class);
        intent.setAction(ACTION_STOP_VIDEO_RECORDING);
        intent.putExtra(EXTRA_VIDEO_ID, videoId);
        context.startForegroundService(intent);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);

        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();
            Log.d(TAG, "CameraNeo received action: " + action);

            switch (action) {
                case ACTION_TAKE_PHOTO:
                    String photoFilePath = intent.getStringExtra(EXTRA_PHOTO_FILE_PATH);
                    if (photoFilePath == null || photoFilePath.isEmpty()) {
                        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                        photoFilePath = getExternalFilesDir(null) + File.separator + "IMG_" + timeStamp + ".jpg";
                    }
                    setupCameraAndTakePicture(photoFilePath);
                    break;
                case ACTION_START_VIDEO_RECORDING:
                    currentVideoId = intent.getStringExtra(EXTRA_VIDEO_ID);
                    currentVideoPath = intent.getStringExtra(EXTRA_VIDEO_FILE_PATH);
                    if (currentVideoPath == null || currentVideoPath.isEmpty()) {
                        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                        currentVideoPath = getExternalFilesDir(null) + File.separator + "VID_" + timeStamp + ".mp4";
                    }
                    setupCameraAndStartRecording(currentVideoId, currentVideoPath);
                    break;
                case ACTION_STOP_VIDEO_RECORDING:
                    String videoIdToStop = intent.getStringExtra(EXTRA_VIDEO_ID);
                    stopCurrentVideoRecording(videoIdToStop);
                    break;
            }
        }
        return START_STICKY;
    }

    private void setupCameraAndTakePicture(String filePath) {
        wakeUpScreen();
        isK900Device = isK900Device(getApplicationContext());
        Log.d(TAG, "Device is K900: " + isK900Device);
        openCameraInternal(filePath, false); // false indicates not for video
    }

    private void setupCameraAndStartRecording(String videoId, String filePath) {
        if (isRecording) {
            notifyVideoError(videoId, "Already recording another video.");
            return;
        }
        wakeUpScreen();
        isK900Device = isK900Device(getApplicationContext());
        currentVideoId = videoId;
        currentVideoPath = filePath;
        openCameraInternal(filePath, true); // true indicates for video
    }

    private void stopCurrentVideoRecording(String videoIdToStop) {
        if (!isRecording) {
            Log.w(TAG, "Stop recording requested, but not currently recording.");
            // Optionally notify error or just ignore if it's a common race condition
            if (sVideoCallback != null && videoIdToStop != null) {
                sVideoCallback.onRecordingError(videoIdToStop, "Not recording");
            }
            return;
        }
        if (videoIdToStop == null || !videoIdToStop.equals(currentVideoId)) {
            Log.w(TAG, "Stop recording requested for ID " + videoIdToStop + " but current is " + currentVideoId);
            if (sVideoCallback != null && videoIdToStop != null) {
                sVideoCallback.onRecordingError(videoIdToStop, "Video ID mismatch");
            }
            return;
        }

        try {
            if (mediaRecorder != null) {
                mediaRecorder.stop();
                mediaRecorder.reset();
            }
            Log.d(TAG, "Video recording stopped for: " + currentVideoId);
            if (sVideoCallback != null) {
                sVideoCallback.onRecordingStopped(currentVideoId, currentVideoPath);
            }
        } catch (RuntimeException stopErr) {
            Log.e(TAG, "MediaRecorder.stop() failed", stopErr);
            if (sVideoCallback != null) {
                sVideoCallback.onRecordingError(currentVideoId, "Failed to stop recorder: " + stopErr.getMessage());
            }
            // Still try to clean up even if stop failed
        } finally {
            isRecording = false;
            if (recordingTimer != null) {
                recordingTimer.cancel();
                recordingTimer = null;
            }
            closeCamera();
            stopSelf();
        }
    }

    @SuppressLint("MissingPermission")
    private void openCameraInternal(String filePath, boolean forVideo) {
        CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            Log.e(TAG, "Could not get camera manager");
            if (forVideo) notifyVideoError(currentVideoId, "Camera service unavailable");
            else notifyPhotoError("Camera service unavailable");
            stopSelf();
            return;
        }

        try {
            String[] cameraIds = manager.getCameraIdList();
            if (isK900Device) {
                if (cameraIds.length > 0) this.cameraId = "0";
                else {
                    if (forVideo) notifyVideoError(currentVideoId, "No K900 camera");
                    else notifyPhotoError("No K900 camera");
                    stopSelf();
                    return;
                }
            } else {
                for (String id : cameraIds) {
                    CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
                    Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                    if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                        this.cameraId = id;
                        break;
                    }
                }
                
                // If no back camera found, use the first available camera
                if (this.cameraId == null && cameraIds.length > 0) {
                    this.cameraId = cameraIds[0];
                    Log.d(TAG, "No back camera found, using camera ID: " + this.cameraId);
                }
            }

            // Verify that we have a valid camera ID
            if (this.cameraId == null) {
                if (forVideo) notifyVideoError(currentVideoId, "No suitable camera found");
                else notifyPhotoError("No suitable camera found");
                stopSelf();
                return;
            }

            // Get characteristics for the selected camera
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(this.cameraId);

            // Check if this camera supports JPEG format
            StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) {
                if (forVideo)
                    notifyVideoError(currentVideoId, "Camera " + this.cameraId + " doesn't support configuration maps");
                else
                    notifyPhotoError("Camera " + this.cameraId + " doesn't support configuration maps");
                stopSelf();
                return;
            }

            // Find the closest available JPEG size to our target
            Size[] jpegSizes = map.getOutputSizes(ImageFormat.JPEG);
            if (jpegSizes == null || jpegSizes.length == 0) {
                if (forVideo)
                    notifyVideoError(currentVideoId, "Camera doesn't support JPEG format");
                else notifyPhotoError("Camera doesn't support JPEG format");
                stopSelf();
                return;
            }

            // Log available sizes
            Log.d(TAG, "Available JPEG sizes for camera " + this.cameraId + ":");
            for (Size size : jpegSizes) {
                Log.d(TAG, "  " + size.getWidth() + "x" + size.getHeight());
            }

            jpegSize = chooseOptimalSize(jpegSizes, TARGET_WIDTH, TARGET_HEIGHT);
            Log.d(TAG, "Selected JPEG size: " + jpegSize.getWidth() + "x" + jpegSize.getHeight());

            // If this is for video, set up video size too
            if (forVideo) {
                // Find a suitable video size
                Size[] videoSizes = map.getOutputSizes(MediaRecorder.class);

                if (videoSizes == null || videoSizes.length == 0) {
                    notifyVideoError(currentVideoId, "Camera doesn't support MediaRecorder");
                    stopSelf();
                    return;
                }

                // Log available video sizes
                Log.d(TAG, "Available video sizes for camera " + this.cameraId + ":");
                for (Size size : videoSizes) {
                    Log.d(TAG, "  " + size.getWidth() + "x" + size.getHeight());
                }

                // Default to 720p if available, otherwise find closest
                int targetVideoWidth = 1280;
                int targetVideoHeight = 720;
                videoSize = chooseOptimalSize(videoSizes, targetVideoWidth, targetVideoHeight);
                Log.d(TAG, "Selected video size: " + videoSize.getWidth() + "x" + videoSize.getHeight());

                // Initialize MediaRecorder
                setupMediaRecorder(currentVideoPath);
            }

            // Setup ImageReader for JPEG data
            imageReader = ImageReader.newInstance(
                    jpegSize.getWidth(), jpegSize.getHeight(),
                    ImageFormat.JPEG, 2);

            imageReader.setOnImageAvailableListener(reader -> {
                // Process the captured JPEG
                try (Image image = reader.acquireLatestImage()) {
                    if (image == null) {
                        Log.e(TAG, "Acquired image is null");
                        notifyPhotoError("Failed to acquire image data");
                        stopSelf();
                        return;
                    }
                    
                    ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                    byte[] bytes = new byte[buffer.remaining()];
                    buffer.get(bytes);
                    
                    // Save the image data to the file
                    boolean success = saveImageDataToFile(bytes, filePath);
                    
                    if (success) {
                        lastPhotoPath = filePath;
                        notifyPhotoCaptured(filePath);
                    } else {
                        notifyPhotoError("Failed to save image");
                    }
                    
                    // Clean up resources
                    closeCamera();
                    stopSelf();
                } catch (Exception e) {
                    Log.e(TAG, "Error handling image data", e);
                    notifyPhotoError("Error processing photo: " + e.getMessage());
                    closeCamera();
                    stopSelf();
                }
            }, backgroundHandler);

            // Open the camera
            if (!cameraOpenCloseLock.tryAcquire(2500, TimeUnit.MILLISECONDS)) {
                throw new RuntimeException("Time out waiting to lock camera opening.");
            }

            Log.d(TAG, "Opening camera ID: " + this.cameraId);
            manager.openCamera(this.cameraId, forVideo ? videoStateCallback : photoStateCallback, backgroundHandler);

        } catch (CameraAccessException e) {
            Log.e(TAG, "Camera access exception", e);
            notifyPhotoError("Could not access camera: " + e.getMessage());
            stopSelf();
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted while trying to lock camera", e);
            notifyPhotoError("Camera operation interrupted");
            stopSelf();
        } catch (Exception e) {
            Log.e(TAG, "Error setting up camera", e);
            notifyPhotoError("Error setting up camera: " + e.getMessage());
            stopSelf();
        }
    }

    /**
     * Setup MediaRecorder for video recording
     */
    private void setupMediaRecorder(String filePath) {
        try {
            if (mediaRecorder == null) {
                mediaRecorder = new MediaRecorder();
            } else {
                mediaRecorder.reset();
            }

            // Set up media recorder sources and formats
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            mediaRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);

            // Set output format
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);

            // Set output file
            mediaRecorder.setOutputFile(filePath);

            // Set video encoding parameters
            mediaRecorder.setVideoEncodingBitRate(10000000); // 10Mbps
            mediaRecorder.setVideoFrameRate(30);
            mediaRecorder.setVideoSize(videoSize.getWidth(), videoSize.getHeight());
            mediaRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);

            // Set audio encoding parameters
            mediaRecorder.setAudioEncodingBitRate(128000);
            mediaRecorder.setAudioSamplingRate(44100);
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);

            // Set the orientation
            if (isK900Device) {
                mediaRecorder.setOrientationHint(0); // For K900 device
            } else {
                mediaRecorder.setOrientationHint(90); // Default orientation
            }

            // Prepare the recorder
            mediaRecorder.prepare();

            // Get the surface from the recorder
            recorderSurface = mediaRecorder.getSurface();

            Log.d(TAG, "MediaRecorder setup complete for: " + filePath);
        } catch (Exception e) {
            Log.e(TAG, "Error setting up MediaRecorder", e);
            if (mediaRecorder != null) {
                mediaRecorder.release();
                mediaRecorder = null;
            }
            notifyVideoError(currentVideoId, "Failed to set up video recorder: " + e.getMessage());
        }
    }

    /**
     * Save image data to file
     */
    private boolean saveImageDataToFile(byte[] data, String filePath) {
        try {
            File file = new File(filePath);
            
            // Ensure parent directory exists
            File parentDir = file.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs();
            }
            
            // Write image data to file
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(data);
            }
            
            Log.d(TAG, "Saved image to: " + filePath);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error saving image", e);
            return false;
        }
    }
    
    /**
     * Camera state callback for Camera2 API
     */
    private final CameraDevice.StateCallback photoStateCallback = new CameraDevice.StateCallback() {
        @Override
        public void onOpened(@NonNull CameraDevice camera) {
            Log.d(TAG, "Camera device opened successfully");
            cameraOpenCloseLock.release();
            cameraDevice = camera;
            createCameraSessionInternal(false); // false for photo
        }

        @Override
        public void onDisconnected(@NonNull CameraDevice camera) {
            Log.d(TAG, "Camera device disconnected");
            cameraOpenCloseLock.release();
            camera.close();
            cameraDevice = null;
            notifyPhotoError("Camera disconnected");
            stopSelf();
        }

        @Override
        public void onError(@NonNull CameraDevice camera, int error) {
            Log.e(TAG, "Camera device error: " + error);
            cameraOpenCloseLock.release();
            camera.close();
            cameraDevice = null;
            notifyPhotoError("Camera device error: " + error);
            stopSelf();
        }
    };

    private final CameraDevice.StateCallback videoStateCallback = new CameraDevice.StateCallback() {
        @Override
        public void onOpened(@NonNull CameraDevice camera) {
            Log.d(TAG, "Camera device opened successfully");
            cameraOpenCloseLock.release();
            cameraDevice = camera;
            createCameraSessionInternal(true); // true for video
        }

        @Override
        public void onDisconnected(@NonNull CameraDevice camera) {
            Log.d(TAG, "Camera device disconnected");
            cameraOpenCloseLock.release();
            camera.close();
            cameraDevice = null;
            notifyVideoError(currentVideoId, "Camera disconnected");
            stopSelf();
        }

        @Override
        public void onError(@NonNull CameraDevice camera, int error) {
            Log.e(TAG, "Camera device error: " + error);
            cameraOpenCloseLock.release();
            camera.close();
            cameraDevice = null;
            notifyVideoError(currentVideoId, "Camera device error: " + error);
            stopSelf();
        }
    };

    private void createCameraSessionInternal(boolean forVideo) {
        try {
            if (cameraDevice == null) {
                Log.e(TAG, "Camera device is null in createCameraSessionInternal");
                if (forVideo) notifyVideoError(currentVideoId, "Camera not initialized");
                else notifyPhotoError("Camera not initialized");
                stopSelf();
                return;
            }

            List<Surface> surfaces = new ArrayList<>();
            if (forVideo) {
                if (recorderSurface == null) {
                    notifyVideoError(currentVideoId, "Recorder surface null");
                    stopSelf();
                    return;
                }
                surfaces.add(recorderSurface);
                captureRequestBuilder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                captureRequestBuilder.addTarget(recorderSurface);
            } else {
                if (imageReader == null || imageReader.getSurface() == null) {
                    notifyPhotoError("ImageReader surface null");
                    stopSelf();
                    return;
                }
                surfaces.add(imageReader.getSurface());
                captureRequestBuilder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                captureRequestBuilder.addTarget(imageReader.getSurface());
            }

            captureRequestBuilder.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            if (!isK900Device) {
                captureRequestBuilder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            }
            captureRequestBuilder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            if (isK900Device) {
                captureRequestBuilder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, 0);
                captureRequestBuilder.set(CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[]{
                        new MeteringRectangle(0, 0, 4208, 3120, MeteringRectangle.METERING_WEIGHT_MAX)
                });
                captureRequestBuilder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
                captureRequestBuilder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
                captureRequestBuilder.set(CaptureRequest.JPEG_QUALITY, (byte) 95);
            } else {
                captureRequestBuilder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, 1);
                captureRequestBuilder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
                captureRequestBuilder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
                captureRequestBuilder.set(CaptureRequest.JPEG_QUALITY, (byte) 90);
            }
            if (!forVideo) {
                captureRequestBuilder.set(CaptureRequest.JPEG_ORIENTATION, 270);
            }

            CameraCaptureSession.StateCallback sessionStateCallback = new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(@NonNull CameraCaptureSession session) {
                    cameraCaptureSession = session;
                    if (forVideo) {
                        startRecordingInternal();
                    } else {
                        capturePhotoInternal();
                    }
                }

                @Override
                public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                    Log.e(TAG, "Failed to configure camera session for " + (forVideo ? "video" : "photo"));
                    if (forVideo)
                        notifyVideoError(currentVideoId, "Failed to configure camera for video");
                    else notifyPhotoError("Failed to configure camera for photo");
                    stopSelf();
                }
            };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                List<OutputConfiguration> outputConfigurations = new ArrayList<>();
                for (Surface surface : surfaces) {
                    outputConfigurations.add(new OutputConfiguration(surface));
                }
                SessionConfiguration config = new SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outputConfigurations, executor, sessionStateCallback);
                cameraDevice.createCaptureSession(config);
            } else {
                cameraDevice.createCaptureSession(surfaces, sessionStateCallback, backgroundHandler);
            }
        } catch (CameraAccessException e) {
            Log.e(TAG, "Camera access exception in createCameraSessionInternal", e);
            if (forVideo) notifyVideoError(currentVideoId, "Camera access error");
            else notifyPhotoError("Camera access error");
            stopSelf();
        } catch (IllegalStateException e) {
            Log.e(TAG, "Illegal state in createCameraSessionInternal", e);
            if (forVideo) notifyVideoError(currentVideoId, "Camera illegal state");
            else notifyPhotoError("Camera illegal state");
            stopSelf();
        }
    }

    private void startRecordingInternal() {
        if (cameraDevice == null || cameraCaptureSession == null || mediaRecorder == null) {
            notifyVideoError(currentVideoId, "Cannot start recording, camera not ready.");
            return;
        }
        try {
            cameraCaptureSession.setRepeatingRequest(captureRequestBuilder.build(), null, backgroundHandler);
            mediaRecorder.start();
            isRecording = true;
            recordingStartTime = System.currentTimeMillis();
            if (sVideoCallback != null) {
                sVideoCallback.onRecordingStarted(currentVideoId);
            }
            // Start progress timer if callback is interested
            if (sVideoCallback != null) {
                recordingTimer = new Timer();
                recordingTimer.schedule(new TimerTask() {
                    @Override
                    public void run() {
                        if (isRecording && sVideoCallback != null) {
                            long duration = System.currentTimeMillis() - recordingStartTime;
                            sVideoCallback.onRecordingProgress(currentVideoId, duration);
                        }
                    }
                }, 1000, 1000); // Update every second
            }
            Log.d(TAG, "Video recording started for: " + currentVideoId);
        } catch (CameraAccessException | IllegalStateException e) {
            Log.e(TAG, "Failed to start video recording", e);
            notifyVideoError(currentVideoId, "Failed to start recording: " + e.getMessage());
            isRecording = false;
        }
    }

    private void capturePhotoInternal() {
        if (cameraDevice == null || cameraCaptureSession == null) {
            notifyPhotoError("Camera not ready for photo capture");
            return;
        }
        try {
            Log.d(TAG, "Capturing photo...");

            // This is where we finally take the picture
            cameraCaptureSession.capture(captureRequestBuilder.build(), new CameraCaptureSession.CaptureCallback() {
                @Override
                public void onCaptureCompleted(@NonNull CameraCaptureSession session, @NonNull CaptureRequest request, @NonNull TotalCaptureResult result) {
                    Log.d(TAG, "Image capture completed");
                }

                @Override
                public void onCaptureFailed(@NonNull CameraCaptureSession session, @NonNull CaptureRequest request, @NonNull CaptureFailure failure) {
                    Log.e(TAG, "Image capture failed: " + failure.getReason());
                    notifyPhotoError("Capture failed: " + failure.getReason());
                    closeCamera();
                    stopSelf();
                }
            }, backgroundHandler);
        } catch (CameraAccessException e) {
            Log.e(TAG, "Error during photo capture", e);
            notifyPhotoError("Error capturing image: " + e.getMessage());
            closeCamera();
            stopSelf();
        }
    }

    private Size chooseOptimalSize(Size[] choices, int desiredWidth, int desiredHeight) {
        // Simplified: find exact match or largest available if no exact match for simplicity.
        // A more robust version would consider aspect ratio and closest area.
        for (Size option : choices) {
            if (option.getWidth() == desiredWidth && option.getHeight() == desiredHeight) {
                return option;
            }
        }
        // Fallback: return the largest available size if no exact match (or first if choices is empty)
        if (choices.length > 0) {
            Size largest = choices[0];
            for (Size option : choices) {
                if (option.getWidth() * option.getHeight() > largest.getWidth() * largest.getHeight()) {
                    largest = option;
                }
            }
            return largest;
        }
        return null; // Should not happen if map.getOutputSizes returns valid data
    }

    private void notifyVideoError(String videoId, String errorMessage) {
        if (sVideoCallback != null && videoId != null) {
            executor.execute(() -> sVideoCallback.onRecordingError(videoId, errorMessage));
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (isRecording) {
            stopCurrentVideoRecording(currentVideoId);
        }
        closeCamera();
        stopBackgroundThread();
        releaseWakeLocks();
        sInstance = null;
    }

    private void notifyPhotoCaptured(String filePath) {
        if (sPhotoCallback != null) {
            executor.execute(() -> sPhotoCallback.onPhotoCaptured(filePath));
        }
    }
    
    private void notifyPhotoError(String errorMessage) {
        if (sPhotoCallback != null) {
            executor.execute(() -> sPhotoCallback.onPhotoError(errorMessage));
        }
    }
    
    /**
     * Start background thread
     */
    private void startBackgroundThread() {
        backgroundThread = new HandlerThread("CameraNeoBackground");
        backgroundThread.start();
        backgroundHandler = new Handler(backgroundThread.getLooper());
    }
    
    /**
     * Stop background thread
     */
    private void stopBackgroundThread() {
        if (backgroundThread != null) {
            backgroundThread.quitSafely();
            try {
                backgroundThread.join();
                backgroundThread = null;
                backgroundHandler = null;
            } catch (InterruptedException e) {
                Log.e(TAG, "Interrupted when stopping background thread", e);
            }
        }
    }
    
    /**
     * Close camera resources
     */
    private void closeCamera() {
        try {
            cameraOpenCloseLock.acquire();
            if (cameraCaptureSession != null) {
                cameraCaptureSession.close();
                cameraCaptureSession = null;
            }
            if (cameraDevice != null) {
                cameraDevice.close();
                cameraDevice = null;
            }
            if (imageReader != null) {
                imageReader.close();
                imageReader = null;
            }
            if (mediaRecorder != null) {
                mediaRecorder.release();
                mediaRecorder = null;
            }
            if (recorderSurface != null) {
                recorderSurface.release();
                recorderSurface = null;
            }
            releaseWakeLocks();
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted while closing camera", e);
        } finally {
            cameraOpenCloseLock.release();
        }
    }
    
    /**
     * Release wake locks to avoid battery drain
     */
    private void releaseWakeLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                wakeLock = null;
                Log.d(TAG, "Partial wake lock released");
            }
            
            if (fullWakeLock != null && fullWakeLock.isHeld()) {
                fullWakeLock.release();
                fullWakeLock = null;
                Log.d(TAG, "Full wake lock released");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error releasing wake locks", e);
        }
    }

    /**
     * Force the screen to turn on so camera can be accessed
     */
    private void wakeUpScreen() {
        Log.d(TAG, "Waking up screen for camera access");

        try {
            // Create a partial wake lock to keep CPU running
            PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
            if (powerManager == null) {
                Log.e(TAG, "PowerManager is null");
                return;
            }

            // First create a partial wake lock to keep the CPU running
            if (wakeLock == null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                        "AugmentOS:CameraWakeLock");
                wakeLock.acquire(60000); // 60-second timeout
            }

            // Then create a full wake lock to turn the screen on
            if (fullWakeLock == null) {
                fullWakeLock = powerManager.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK |
                                PowerManager.ACQUIRE_CAUSES_WAKEUP |
                                PowerManager.ON_AFTER_RELEASE,
                        "AugmentOS:CameraFullWakeLock");
                fullWakeLock.acquire(5000); // 5-second timeout
            }

            Log.d(TAG, "Screen wake locks acquired");
        } catch (Exception e) {
            Log.e(TAG, "Error acquiring wake locks", e);
        }
    }

    // -----------------------------------------------------------------------------------
    // Notification handling
    // -----------------------------------------------------------------------------------

    private void showNotification(String title, String message) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(false);

        // Start in foreground
        startForeground(NOTIFICATION_ID, builder.build());
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Camera Neo Service Channel",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
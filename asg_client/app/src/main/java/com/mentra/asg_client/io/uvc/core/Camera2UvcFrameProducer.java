package com.mentra.asg_client.io.uvc.core;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;
import android.view.Surface;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicReference;

public class Camera2UvcFrameProducer implements UvcFrameProducer {
  private static final String TAG = "Camera2UvcProducer";

  private final Context context;
  private final AtomicReference<byte[]> latestJpeg = new AtomicReference<>(null);

  private HandlerThread cameraThread;
  private Handler cameraHandler;
  private CameraDevice cameraDevice;
  private CameraCaptureSession captureSession;
  private ImageReader imageReader;

  public Camera2UvcFrameProducer(Context context) {
    this.context = context;
  }

  @Override
  public void open(UvcConfig config) throws Exception {
    startThread();
    String cameraId = resolveCameraId(config);
    Size chosenSize = chooseJpegSize(cameraId, config);
    imageReader = ImageReader.newInstance(chosenSize.getWidth(), chosenSize.getHeight(), ImageFormat.JPEG, 3);
    imageReader.setOnImageAvailableListener(this::onImageAvailable, cameraHandler);
    openCamera(cameraId);
  }

  @Override
  public byte[] nextFrame(long frameIndex, long timestampNs) {
    return latestJpeg.get();
  }

  @Override
  public void close() {
    if (captureSession != null) {
      try {
        captureSession.stopRepeating();
      } catch (Exception ignored) {
      }
      try {
        captureSession.close();
      } catch (Exception ignored) {
      }
      captureSession = null;
    }

    if (cameraDevice != null) {
      try {
        cameraDevice.close();
      } catch (Exception ignored) {
      }
      cameraDevice = null;
    }

    if (imageReader != null) {
      try {
        imageReader.close();
      } catch (Exception ignored) {
      }
      imageReader = null;
    }

    stopThread();
    latestJpeg.set(null);
  }

  @Override
  public String getName() {
    return "Camera2UvcFrameProducer";
  }

  private void onImageAvailable(ImageReader reader) {
    Image image = null;
    try {
      image = reader.acquireLatestImage();
      if (image == null || image.getFormat() != ImageFormat.JPEG) {
        return;
      }
      ByteBuffer buffer = image.getPlanes()[0].getBuffer();
      byte[] payload = new byte[buffer.remaining()];
      buffer.get(payload);
      latestJpeg.set(payload);
    } catch (Exception e) {
      Log.w(TAG, "Failed to read Camera2 frame", e);
    } finally {
      if (image != null) {
        image.close();
      }
    }
  }

  @SuppressLint("MissingPermission")
  private void openCamera(String cameraId) throws Exception {
    CameraManager cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
    if (cameraManager == null) {
      throw new IllegalStateException("CameraManager unavailable");
    }

    final Object openLock = new Object();
    final Exception[] openError = new Exception[1];

    cameraManager.openCamera(cameraId, new CameraDevice.StateCallback() {
      @Override
      public void onOpened(CameraDevice camera) {
        synchronized (openLock) {
          cameraDevice = camera;
          openLock.notifyAll();
        }
        createSession();
      }

      @Override
      public void onDisconnected(CameraDevice camera) {
        synchronized (openLock) {
          openError[0] = new IllegalStateException("Camera disconnected");
          openLock.notifyAll();
        }
      }

      @Override
      public void onError(CameraDevice camera, int error) {
        synchronized (openLock) {
          openError[0] = new IllegalStateException("Camera error " + error);
          openLock.notifyAll();
        }
      }
    }, cameraHandler);

    synchronized (openLock) {
      openLock.wait(2000L);
    }

    if (openError[0] != null) {
      throw openError[0];
    }
    if (cameraDevice == null) {
      throw new IllegalStateException("Camera open timed out");
    }
  }

  private void createSession() {
    if (cameraDevice == null || imageReader == null) {
      return;
    }

    try {
      Surface surface = imageReader.getSurface();
      cameraDevice.createCaptureSession(Collections.singletonList(surface), new CameraCaptureSession.StateCallback() {
        @Override
        public void onConfigured(CameraCaptureSession session) {
          captureSession = session;
          try {
            CaptureRequest.Builder builder =
                cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(surface);
            session.setRepeatingRequest(builder.build(), null, cameraHandler);
          } catch (Exception e) {
            Log.e(TAG, "Failed to start Camera2 repeating request", e);
          }
        }

        @Override
        public void onConfigureFailed(CameraCaptureSession session) {
          Log.e(TAG, "Failed to configure Camera2 capture session");
        }
      }, cameraHandler);
    } catch (Exception e) {
      Log.e(TAG, "Failed to create Camera2 capture session", e);
    }
  }

  private String resolveCameraId(UvcConfig config) throws Exception {
    if (config != null && config.getCameraId() != null && !config.getCameraId().trim().isEmpty()) {
      return config.getCameraId().trim();
    }

    CameraManager cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
    if (cameraManager == null) {
      throw new IllegalStateException("CameraManager unavailable");
    }
    String[] ids = cameraManager.getCameraIdList();
    if (ids.length == 0) {
      throw new IllegalStateException("No Camera2 devices available");
    }
    return ids[0];
  }

  private Size chooseJpegSize(String cameraId, UvcConfig config) throws Exception {
    CameraManager cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
    if (cameraManager == null) {
      return new Size(config.getWidth(), config.getHeight());
    }

    CameraCharacteristics characteristics = cameraManager.getCameraCharacteristics(cameraId);
    android.hardware.camera2.params.StreamConfigurationMap map =
        characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    if (map == null) {
      return new Size(config.getWidth(), config.getHeight());
    }

    Size[] sizes = map.getOutputSizes(ImageFormat.JPEG);
    if (sizes == null || sizes.length == 0) {
      return new Size(config.getWidth(), config.getHeight());
    }

    Size best = sizes[0];
    int targetW = config.getWidth();
    int targetH = config.getHeight();
    long bestDistance = distance(best, targetW, targetH);
    for (Size size : sizes) {
      long candidateDistance = distance(size, targetW, targetH);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        best = size;
      }
    }
    return best;
  }

  private long distance(Size size, int targetW, int targetH) {
    return Math.abs(size.getWidth() - targetW) + Math.abs(size.getHeight() - targetH);
  }

  private void startThread() {
    if (cameraThread != null) {
      return;
    }
    cameraThread = new HandlerThread("uvc-camera2-producer");
    cameraThread.start();
    cameraHandler = new Handler(cameraThread.getLooper());
  }

  private void stopThread() {
    if (cameraThread == null) {
      return;
    }
    cameraThread.quitSafely();
    cameraThread = null;
    cameraHandler = null;
  }
}

package com.mentra.asg_client.camera;

import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;

import androidx.annotation.NonNull;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Scratch feasibility probe for a ZSL-style YUV ring buffer on the Mentra Live MTK HAL.
 * Not part of the shipped suite — run manually, read results from logcat tag ZslProbe:
 *
 *   ./gradlew :app:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.mentra.asg_client.camera.ZslFeasibilityProbeTest
 *
 * Measures: (1) HAL reprocessing capabilities + YUV/JPEG stream configs and stall durations,
 * (2) live YUV stream frame cadence at the SDK photo resolution, (3) software JPEG encode
 * latency from a grabbed YUV frame (the manual-ring fallback path).
 */
@RunWith(AndroidJUnit4.class)
public class ZslFeasibilityProbeTest {

    private static final String TAG = "ZslProbe";
    private static final Size SDK_SIZE = new Size(1280, 960);

    @Test
    public void probeCharacteristicsAndYuvRing() throws Exception {
        Context ctx = ApplicationProvider.getApplicationContext();
        CameraManager mgr = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);

        // K900 power model: the camera HAL device only registers while the screen/SoC is awake
        // (CameraNeoService.wakeUpScreen() does this before every open). Mirror it, then poll
        // for the device to appear.
        com.mentra.asg_client.utils.WakeLockManager.acquireFullWakeLockAndBringToForeground(
                ctx, 120000, 30000);
        String id = null;
        long tWake = System.nanoTime();
        for (int i = 0; i < 50; i++) {
            String[] ids = mgr.getCameraIdList();
            if (ids.length > 0) {
                id = ids[0];
                break;
            }
            Thread.sleep(100);
        }
        Log.i(TAG, "camera device registered " + ((System.nanoTime() - tWake) / 1_000_000)
                + "ms after wake (id=" + id + ")");
        if (id == null) {
            Log.e(TAG, "RESULT: camera never appeared after 5s awake — probe aborted");
            return;
        }
        CameraCharacteristics ch = mgr.getCameraCharacteristics(id);

        // ---- 1. Static capabilities ----
        int[] caps = ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        Log.i(TAG, "CAPABILITIES=" + Arrays.toString(caps)
                + " (4=PRIVATE_REPROCESSING, 7=YUV_REPROCESSING, 12=CONSTRAINED_HIGH_SPEED)");
        Integer maxInput = ch.get(CameraCharacteristics.REQUEST_MAX_NUM_INPUT_STREAMS);
        Log.i(TAG, "MAX_NUM_INPUT_STREAMS=" + maxInput);
        Integer partial = ch.get(CameraCharacteristics.REQUEST_PARTIAL_RESULT_COUNT);
        Byte pipelineDepth = ch.get(CameraCharacteristics.REQUEST_PIPELINE_MAX_DEPTH);
        Log.i(TAG, "PARTIAL_RESULT_COUNT=" + partial + " PIPELINE_MAX_DEPTH=" + pipelineDepth);

        StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        int[] inputFormats = map.getInputFormats();
        Log.i(TAG, "INPUT_FORMATS=" + Arrays.toString(inputFormats));
        for (int f : inputFormats) {
            Log.i(TAG, "  input fmt " + f + " sizes=" + Arrays.toString(map.getInputSizes(f)));
        }

        for (Size s : map.getOutputSizes(ImageFormat.YUV_420_888)) {
            long minFrame = map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, s);
            long stall = map.getOutputStallDuration(ImageFormat.YUV_420_888, s);
            Log.i(TAG, "YUV " + s + " minFrameMs=" + (minFrame / 1e6) + " stallMs=" + (stall / 1e6));
        }
        for (Size s : map.getOutputSizes(ImageFormat.JPEG)) {
            long minFrame = map.getOutputMinFrameDuration(ImageFormat.JPEG, s);
            long stall = map.getOutputStallDuration(ImageFormat.JPEG, s);
            Log.i(TAG, "JPEG " + s + " minFrameMs=" + (minFrame / 1e6) + " stallMs=" + (stall / 1e6));
        }

        // ---- 2. Live YUV stream cadence at SDK photo size ----
        HandlerThread ht = new HandlerThread("ZslProbe");
        ht.start();
        Handler h = new Handler(ht.getLooper());

        ImageReader yuvReader =
                ImageReader.newInstance(SDK_SIZE.getWidth(), SDK_SIZE.getHeight(),
                        ImageFormat.YUV_420_888, 4);
        List<Long> frameTimesNs = new ArrayList<>();
        AtomicLong lastImageNs = new AtomicLong(0);
        final Image[] latest = new Image[1];
        yuvReader.setOnImageAvailableListener(reader -> {
            Image img = reader.acquireLatestImage();
            if (img == null) return;
            synchronized (latest) {
                if (latest[0] != null) latest[0].close();
                latest[0] = img;
            }
            long now = System.nanoTime();
            lastImageNs.set(now);
            synchronized (frameTimesNs) {
                frameTimesNs.add(now);
            }
        }, h);

        CountDownLatch opened = new CountDownLatch(1);
        final CameraDevice[] devHolder = new CameraDevice[1];
        long tOpen = System.nanoTime();
        mgr.openCamera(id, new CameraDevice.StateCallback() {
            @Override public void onOpened(@NonNull CameraDevice d) { devHolder[0] = d; opened.countDown(); }
            @Override public void onDisconnected(@NonNull CameraDevice d) { d.close(); opened.countDown(); }
            @Override public void onError(@NonNull CameraDevice d, int e) {
                Log.e(TAG, "open error " + e); d.close(); opened.countDown();
            }
        }, h);
        if (!opened.await(5, TimeUnit.SECONDS) || devHolder[0] == null) {
            Log.e(TAG, "RESULT: camera open failed/busy — is CameraNeoService holding it?");
            ht.quitSafely();
            return;
        }
        CameraDevice dev = devHolder[0];
        Log.i(TAG, "camera opened in " + ((System.nanoTime() - tOpen) / 1_000_000) + "ms");

        CountDownLatch configured = new CountDownLatch(1);
        final CameraCaptureSession[] sesHolder = new CameraCaptureSession[1];
        long tCfg = System.nanoTime();
        dev.createCaptureSession(Arrays.asList(yuvReader.getSurface()),
                new CameraCaptureSession.StateCallback() {
                    @Override public void onConfigured(@NonNull CameraCaptureSession s) {
                        sesHolder[0] = s; configured.countDown();
                    }
                    @Override public void onConfigureFailed(@NonNull CameraCaptureSession s) {
                        Log.e(TAG, "session configure FAILED for YUV " + SDK_SIZE);
                        configured.countDown();
                    }
                }, h);
        configured.await(5, TimeUnit.SECONDS);
        if (sesHolder[0] == null) {
            dev.close(); ht.quitSafely();
            return;
        }
        Log.i(TAG, "YUV-only session configured in " + ((System.nanoTime() - tCfg) / 1_000_000) + "ms");

        CaptureRequest.Builder b = dev.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
        b.addTarget(yuvReader.getSurface());
        final Integer[] lastAeState = new Integer[1];
        sesHolder[0].setRepeatingRequest(b.build(), new CameraCaptureSession.CaptureCallback() {
            @Override public void onCaptureCompleted(@NonNull CameraCaptureSession s,
                    @NonNull CaptureRequest r, @NonNull TotalCaptureResult res) {
                lastAeState[0] = res.get(CaptureResult.CONTROL_AE_STATE);
            }
        }, h);

        Thread.sleep(3000); // let AE converge and cadence settle

        long[] times;
        synchronized (frameTimesNs) {
            times = new long[frameTimesNs.size()];
            for (int i = 0; i < times.length; i++) times[i] = frameTimesNs.get(i);
        }
        if (times.length >= 12) {
            long spanNs = times[times.length - 1] - times[times.length - 11];
            Log.i(TAG, "YUV cadence: last 10 intervals avg " + (spanNs / 10 / 1_000_000.0)
                    + "ms (" + times.length + " frames in 3s), AE_STATE=" + lastAeState[0]);
        } else {
            Log.e(TAG, "YUV cadence: only " + times.length + " frames in 3s — stream is NOT viable");
        }

        // ---- 3. Grab latest frame + software JPEG encode (manual ring path) ----
        for (int run = 0; run < 3; run++) {
            Image img;
            synchronized (latest) {
                img = latest[0];
                latest[0] = null;
            }
            if (img == null) {
                Log.e(TAG, "no frame available for encode run " + run);
                Thread.sleep(200);
                continue;
            }
            long t0 = System.nanoTime();
            byte[] nv21 = yuv420ToNv21(img);
            long t1 = System.nanoTime();
            img.close();
            YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21,
                    SDK_SIZE.getWidth(), SDK_SIZE.getHeight(), null);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(512 * 1024);
            yuv.compressToJpeg(new Rect(0, 0, SDK_SIZE.getWidth(), SDK_SIZE.getHeight()), 90, bos);
            long t2 = System.nanoTime();
            byte[] jpeg = bos.toByteArray();
            Log.i(TAG, "ENCODE run " + run + ": yuv->nv21 " + ((t1 - t0) / 1_000_000)
                    + "ms, compressToJpeg " + ((t2 - t1) / 1_000_000) + "ms, jpeg "
                    + (jpeg.length / 1024) + "KB");
            if (run == 2) {
                File out = new File(ctx.getExternalFilesDir(null), "zsl_probe.jpg");
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(jpeg);
                }
                Log.i(TAG, "saved sample to " + out.getAbsolutePath());
            }
            Thread.sleep(300); // let a fresh frame land
        }

        sesHolder[0].close();
        dev.close();
        synchronized (latest) {
            if (latest[0] != null) latest[0].close();
        }
        yuvReader.close();
        ht.quitSafely();
        Log.i(TAG, "probe complete");
    }

    /** YUV_420_888 → NV21, handling both pixelStride 1 and 2 chroma layouts. */
    private static byte[] yuv420ToNv21(Image img) {
        int w = img.getWidth(), hgt = img.getHeight();
        byte[] out = new byte[w * hgt * 3 / 2];
        Image.Plane yP = img.getPlanes()[0];
        ByteBuffer yBuf = yP.getBuffer();
        int yRowStride = yP.getRowStride();
        int pos = 0;
        if (yRowStride == w) {
            int n = w * hgt;
            yBuf.get(out, 0, n);
            pos = n;
        } else {
            byte[] row = new byte[yRowStride];
            for (int r = 0; r < hgt; r++) {
                yBuf.position(r * yRowStride);
                yBuf.get(row, 0, w);
                System.arraycopy(row, 0, out, pos, w);
                pos += w;
            }
        }
        Image.Plane uP = img.getPlanes()[1];
        Image.Plane vP = img.getPlanes()[2];
        ByteBuffer uBuf = uP.getBuffer();
        ByteBuffer vBuf = vP.getBuffer();
        int cRowStride = vP.getRowStride();
        int cPixStride = vP.getPixelStride();
        int cH = hgt / 2, cW = w / 2;
        if (cPixStride == 2 && cRowStride >= w && uBuf.remaining() >= 1) {
            // Semi-planar (NV12/NV21-style): V plane interleaved; copy VU pairs row by row.
            byte[] vRow = new byte[cRowStride];
            byte[] uRow = new byte[cRowStride];
            for (int r = 0; r < cH; r++) {
                int vLen = Math.min(cRowStride, vBuf.limit() - r * cRowStride);
                int uLen = Math.min(cRowStride, uBuf.limit() - r * cRowStride);
                if (vLen <= 0 || uLen <= 0) break;
                vBuf.position(r * cRowStride);
                vBuf.get(vRow, 0, vLen);
                uBuf.position(r * cRowStride);
                uBuf.get(uRow, 0, uLen);
                for (int c = 0; c < cW; c++) {
                    out[pos++] = vRow[c * 2];
                    out[pos++] = uRow[c * 2];
                }
            }
        } else {
            // Planar: interleave V and U samples.
            for (int r = 0; r < cH; r++) {
                for (int c = 0; c < cW; c++) {
                    out[pos++] = vBuf.get(r * cRowStride + c * cPixStride);
                    out[pos++] = uBuf.get(r * cRowStride + c * cPixStride);
                }
            }
        }
        return out;
    }
}

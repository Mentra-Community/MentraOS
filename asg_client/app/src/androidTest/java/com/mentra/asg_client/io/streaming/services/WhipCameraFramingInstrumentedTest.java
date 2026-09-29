package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.dev.api.DevApi;
import com.mentra.asg_client.camera.policy.CameraFovPolicy;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.service.core.CameraFovController;
import com.mentra.asg_client.service.core.CameraRestartCooldown;
import com.mentra.asg_client.settings.AsgSettings;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.webrtc.CapturerObserver;
import org.webrtc.EglBase;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoFrame;

/**
 * Opt-in physical framing probe using the real WHIP SurfaceTexture capturer. Run with
 * {@code -e cameraFramingProbe true}; keep the glasses fixed on a textured scene. Saves upright
 * frames for an independent edge/framing comparison. Restores the saved FOV in a finally block.
 */
@RunWith(AndroidJUnit4.class)
public class WhipCameraFramingInstrumentedTest {
    @Test public void captureCenterBottomAndRestoredCenter() throws Exception {
        assumeTrue("Physical camera test requires explicit opt-in",
                "true".equals(InstrumentationRegistry.getArguments().getString("cameraFramingProbe")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AsgSettings settings = new AsgSettings(context);
        int originalFov = settings.getCameraFov();
        int originalRoi = settings.getCameraRoiPosition();
        File output = new File(context.getExternalFilesDir(null), "whip-framing-" + System.currentTimeMillis());
        assertTrue(output.mkdirs());
        JSONObject summary = new JSONObject();
        JSONArray captures = new JSONArray();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wake = power.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "Mentra:WhipFramingProbe");
        wake.acquire(120000);
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions());
        try {
            summary.put("startedUtc", java.time.Instant.now().toString());
            applyFov(context, 118, DevApi.ROI_POSITION_CENTER);
            captures.put(capture(context, output, "center-540", 960, 540));
            applyFov(context, 118, DevApi.ROI_POSITION_BOTTOM);
            captures.put(capture(context, output, "bottom-540", 960, 540));
            captures.put(capture(context, output, "bottom-1080", 1920, 1080));
            applyFov(context, 118, DevApi.ROI_POSITION_CENTER);
            captures.put(capture(context, output, "restored-center-540", 960, 540));
            summary.put("completed", true);
        } finally {
            try {
                applyFov(context, originalFov, originalRoi);
            } finally {
                summary.put("captures", captures);
                summary.put("finishedUtc", java.time.Instant.now().toString());
                try (FileOutputStream stream = new FileOutputStream(new File(output, "summary.json"))) {
                    stream.write(summary.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                if (wake.isHeld()) wake.release();
                Log.i("WhipFramingProbe", "OUTPUT " + output + " " + summary);
            }
        }
    }

    private void applyFov(Context context, int fov, int roi) throws Exception {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                assertNotEquals(CameraFovPolicy.Result.BUSY,
                        CameraFovController.apply(context, fov, roi, () -> false)));
        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        long deadline = SystemClock.elapsedRealtime() + 20000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (!CameraRestartCooldown.isActive()) {
                try {
                    String id = WhipCameraFormatSelector.selectBackCamera(manager);
                    Rect active = manager.getCameraCharacteristics(id)
                            .get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
                    if (active != null && (fov != 118
                            || (active.width() == 4032 && active.height() == 3024))) return;
                } catch (Exception ignored) {
                    // The vendor restart may expose a stale camera ID before characteristics.
                }
            }
            Thread.sleep(100);
        }
        fail("Full-FOV camera did not become ready");
    }

    private JSONObject capture(Context context, File output, String name, int width, int height)
            throws Exception {
        EglBase egl = EglBase.create();
        SurfaceTextureHelper helper = SurfaceTextureHelper.create("WhipFramingTexture", egl.getEglBaseContext());
        WhipCameraCapturer capturer = new WhipCameraCapturer();
        IHardwareManager hardware = HardwareManagerFactory.getInstance(context);
        Object privacyLightOwner = new Object();
        CountDownLatch saved = new CountDownLatch(1);
        Throwable[] failure = {null};
        long[] firstTimestamp = {0}, frames = {0};
        JSONObject record = new JSONObject().put("name", name);
        capturer.initialize(helper, context, new CapturerObserver() {
            @Override public void onCapturerStarted(boolean success) {
                if (!success) {
                    failure[0] = new AssertionError("WHIP camera did not start");
                    saved.countDown();
                }
            }
            @Override public void onCapturerStopped() {}
            @Override public void onFrameCaptured(VideoFrame frame) {
                if (saved.getCount() == 0) return;
                try {
                    assertEquals(width, frame.getBuffer().getWidth());
                    assertEquals(height, frame.getBuffer().getHeight());
                    assertEquals(0, frame.getRotation());
                    if (firstTimestamp[0] == 0) firstTimestamp[0] = frame.getTimestampNs();
                    frames[0]++;
                    long span = frame.getTimestampNs() - firstTimestamp[0];
                    if (span >= 3_000_000_000L) {
                        saveFrame(frame, new File(output, name + ".jpg"));
                        record.put("width", width).put("height", height).put("rotation", frame.getRotation());
                        record.put("frames", frames[0]).put("spanNs", span);
                        record.put("fps", (frames[0] - 1) * 1_000_000_000.0 / span);
                        saved.countDown();
                    }
                } catch (Throwable e) {
                    failure[0] = e;
                    saved.countDown();
                }
            }
        });
        try {
            assertTrue("Privacy light did not turn on", hardware.acquireRecordingLed(privacyLightOwner));
            capturer.startCapture(width, height, 15);
            assertTrue("Timed out waiting for WHIP frames", saved.await(20, TimeUnit.SECONDS));
            if (failure[0] != null) throw new AssertionError("WHIP capture failed", failure[0]);
            assertTrue("Frame rate below 12 FPS", record.getDouble("fps") >= 12.0);
            Log.i("WhipFramingProbe", record.toString());
            return record;
        } finally {
            try {
                capturer.stopCapture();
            } finally {
                try {
                    capturer.dispose();
                    helper.dispose();
                    egl.release();
                } finally {
                    hardware.releaseRecordingLed(privacyLightOwner);
                }
            }
        }
    }

    private void saveFrame(VideoFrame frame, File file) throws Exception {
        VideoFrame.I420Buffer buffer = frame.getBuffer().toI420();
        try {
            int width = buffer.getWidth(), height = buffer.getHeight();
            byte[] nv21 = new byte[width * height * 3 / 2];
            ByteBuffer[] planes = {buffer.getDataY(), buffer.getDataU(), buffer.getDataV()};
            int[] strides = {buffer.getStrideY(), buffer.getStrideU(), buffer.getStrideV()};
            for (int plane = 0; plane < 3; plane++) {
                int w = plane == 0 ? width : width / 2, h = plane == 0 ? height : height / 2;
                int base = planes[plane].position();
                for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
                    int offset = plane == 0 ? y * width + x
                            : width * height + y * width + 2 * x + (plane == 1 ? 1 : 0);
                    nv21[offset] = planes[plane].get(base + y * strides[plane] + x);
                }
            }
            try (FileOutputStream stream = new FileOutputStream(file)) {
                assertTrue(new YuvImage(nv21, ImageFormat.NV21, width, height, null)
                        .compressToJpeg(new Rect(0, 0, width, height), 95, stream));
            }
        } finally {
            buffer.release();
        }
    }
}

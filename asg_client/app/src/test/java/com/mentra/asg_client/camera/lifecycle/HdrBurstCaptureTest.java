package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.CameraCaptureSession;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class HdrBurstCaptureTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void inactiveHandleFrame_returnsFalseAndDoesNotSave() throws IOException {
        HdrBurstCapture capture = new HdrBurstCapture();
        File base = newBaseFile();
        List<String> savedPaths = new ArrayList<>();

        boolean consumed = capture.handleFrame(new byte[]{1}, base.getAbsolutePath(),
                (bytes, path) -> {
                    savedPaths.add(path);
                    return true;
                },
                new NoopCallback());

        assertThat(consumed).isFalse();
        assertThat(savedPaths).isEmpty();
    }

    @Test
    public void activeHandleFrame_savesFramesWithEvSuffixedNames() throws IOException {
        HdrBurstCapture capture = activeCapture();
        File base = newBaseFile();
        List<String> savedNames = new ArrayList<>();

        capture.handleFrame(new byte[]{1}, base.getAbsolutePath(), saver(savedNames), new NoopCallback());
        capture.handleFrame(new byte[]{2}, base.getAbsolutePath(), saver(savedNames), new NoopCallback());

        assertThat(savedNames).containsExactly("ev-2.jpg", "ev0.jpg");
        assertThat(capture.framesReceived()).isEqualTo(2);
        assertThat(capture.isActive()).isTrue();
    }

    @Test
    public void thirdFrame_completesBurstAndCopiesEv0AsBase() throws IOException {
        HdrBurstCapture capture = activeCapture();
        File base = newBaseFile();
        RecordingCallback callback = new RecordingCallback();

        capture.handleFrame(new byte[]{1}, base.getAbsolutePath(), saver(new ArrayList<>()), callback);
        capture.handleFrame(new byte[]{2}, base.getAbsolutePath(), saver(new ArrayList<>()), callback);
        capture.handleFrame(new byte[]{3}, base.getAbsolutePath(), saver(new ArrayList<>()), callback);

        assertThat(capture.isActive()).isFalse();
        assertThat(callback.completedBasePath).isEqualTo(base.getAbsolutePath());
        assertThat(Files.readAllBytes(base.toPath())).containsExactly((byte) 2);
    }

    @Test
    public void cancel_clearsActiveFlagAndFrameCounter() throws IOException {
        HdrBurstCapture capture = activeCapture();
        File base = newBaseFile();
        capture.handleFrame(new byte[]{1}, base.getAbsolutePath(), saver(new ArrayList<>()), new NoopCallback());

        capture.cancel();

        assertThat(capture.isActive()).isFalse();
        assertThat(capture.framesReceived()).isZero();
    }

    private HdrBurstCapture activeCapture() {
        HdrBurstCapture capture = new HdrBurstCapture();
        // Directly mark active via start-equivalent state for frame-router tests.
        setActiveForTest(capture);
        return capture;
    }

    private static void setActiveForTest(HdrBurstCapture capture) {
        try {
            java.lang.reflect.Field active = HdrBurstCapture.class.getDeclaredField("active");
            active.setAccessible(true);
            active.setBoolean(capture, true);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    private HdrBurstCapture.FrameSaver saver(List<String> savedNames) {
        return (bytes, path) -> {
            File file = new File(path);
            savedNames.add(file.getName());
            try {
                Files.write(file.toPath(), bytes);
                return true;
            } catch (IOException e) {
                throw new AssertionError(e);
            }
        };
    }

    private File newBaseFile() throws IOException {
        File dir = temporaryFolder.newFolder("IMG_HDR");
        return new File(dir, "base.jpg");
    }

    private static class NoopCallback implements HdrBurstCapture.Callback {
        @Override public void onBurstComplete(String basePath) {}
        @Override public void onBurstFailed(String reason) {}
        @Override public void onAllCaptureRequestsCompleted(CameraCaptureSession session) {}
    }

    private static final class RecordingCallback extends NoopCallback {
        String completedBasePath;
        @Override public void onBurstComplete(String basePath) {
            completedBasePath = basePath;
        }
    }
}

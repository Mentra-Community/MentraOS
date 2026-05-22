package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;

import android.util.Size;

import com.mentra.asg_client.sensors.ImuRecorder;
import com.mentra.asg_client.settings.VideoSettings;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class VideoRecordingSessionTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private final VideoRecordingSession.Hooks hooks = new VideoRecordingSession.Hooks() {
        @Override public ImuRecorder ensureImuRecorder() { return null; }
        @Override public ImuRecorder currentImuRecorder() { return null; }
        @Override public int videoOrientation() { return 90; }
        @Override public void onSessionTerminated() {}
    };

    @Test
    public void prepareRequest_storesVideoIdPathAndSettings() {
        VideoRecordingSession session = newSession();
        VideoSettings settings = new VideoSettings(1280, 720, 24);

        assertThat(session.prepareRequest("video-1", "/tmp/video.mp4", settings)).isTrue();

        assertThat(session.currentVideoId()).isEqualTo("video-1");
        assertThat(session.currentVideoPath()).isEqualTo("/tmp/video.mp4");
        assertThat(session.pendingSettings()).isSameAs(settings);
    }

    @Test
    public void setVideoSize_storesSelectedSize() {
        VideoRecordingSession session = newSession();
        Size size = new Size(1920, 1080);

        session.setVideoSize(size);

        assertThat(session.videoSize()).isSameAs(size);
    }

    @Test
    public void deleteCorruptCapture_removesVidDirectoryAndContents() throws IOException {
        File captureDir = temporaryFolder.newFolder("VID_20260515_120000");
        File base = new File(captureDir, "base.mp4");
        File imu = new File(captureDir, "imu.csv");
        assertThat(base.createNewFile()).isTrue();
        assertThat(imu.createNewFile()).isTrue();

        VideoRecordingSession.deleteCorruptCapture(base.getAbsolutePath());

        assertThat(captureDir).doesNotExist();
    }

    @Test
    public void deleteCorruptCapture_leavesUnrecognizedDirectory() throws IOException {
        File captureDir = temporaryFolder.newFolder("NOT_A_CAPTURE");
        File base = new File(captureDir, "base.mp4");
        assertThat(base.createNewFile()).isTrue();

        VideoRecordingSession.deleteCorruptCapture(base.getAbsolutePath());

        assertThat(captureDir).exists();
        assertThat(base).exists();
    }

    @Test
    public void deleteCorruptCapture_nullPath_noops() {
        VideoRecordingSession.deleteCorruptCapture(null);
    }

    @Test
    public void notifyError_dispatchesCallbackOnExecutor() {
        VideoRecordingSession session = newSession();
        AtomicReference<String> callbackVideoId = new AtomicReference<>();
        AtomicReference<String> callbackError = new AtomicReference<>();
        session.setCallback(new VideoRecordingSession.Callback() {
            @Override public void onRecordingStarted(String videoId) {}
            @Override public void onRecordingProgress(String videoId, long durationMs) {}
            @Override public void onRecordingStopped(String videoId, String filePath) {}
            @Override public void onRecordingError(String videoId, String errorMessage) {
                callbackVideoId.set(videoId);
                callbackError.set(errorMessage);
            }
        });

        session.notifyError("video-1", "boom");

        assertThat(callbackVideoId).hasValue("video-1");
        assertThat(callbackError).hasValue("boom");
    }

    private VideoRecordingSession newSession() {
        Executor directExecutor = Runnable::run;
        return new VideoRecordingSession(null, null, directExecutor, hooks);
    }
}

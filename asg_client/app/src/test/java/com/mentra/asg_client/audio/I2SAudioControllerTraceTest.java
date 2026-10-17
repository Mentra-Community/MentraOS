package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.media.MediaPlayer;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.diag.AudioTraceBus;
import java.io.FileDescriptor;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedConstruction;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** The audio reproduction harness classifies bridge reuse from these trace events. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class I2SAudioControllerTraceTest {

    private static final class Trace {
        final String event;
        final Map<String, Object> fields;

        Trace(String event, Map<String, Object> fields) {
            this.event = event;
            this.fields = fields;
        }
    }

    private final List<Trace> traces = new ArrayList<>();
    private final AudioTraceBus.Sink sink = (event, ns, thread, fields) -> traces.add(new Trace(event, fields));
    private I2SAudioController controller;

    @Before
    public void setUp() throws Exception {
        I2sReadyGate.invalidateLink();
        I2SAudioController.setExternalAudioPlaying(false);
        Application app = ApplicationProvider.getApplicationContext();
        AssetManager assets = mock(AssetManager.class);
        AssetFileDescriptor descriptor = mock(AssetFileDescriptor.class);
        when(assets.openFd(anyString())).thenReturn(descriptor);
        when(descriptor.getFileDescriptor()).thenReturn(new FileDescriptor());
        Context context =
                new ContextWrapper(app) {
                    @Override
                    public Context getApplicationContext() {
                        return this;
                    }

                    @Override
                    public AssetManager getAssets() {
                        return assets;
                    }
                };
        controller = new I2SAudioController(context);
        AudioTraceBus.setSink(sink);
    }

    @After
    public void tearDown() {
        AudioTraceBus.clearSink(sink);
        controller.stopPlayback();
        shadowOf(Looper.getMainLooper()).idle();
    }

    private Trace first(String event) {
        for (Trace trace : traces) {
            if (trace.event.equals(event)) return trace;
        }
        return null;
    }

    private List<String> names() {
        List<String> names = new ArrayList<>();
        for (Trace trace : traces) names.add(trace.event);
        return names;
    }

    @Test
    public void reportsOpenThenReadyReuseWithTheSameRequestId() {
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long token = controller.playAssetTracked(AudioAssets.RECORDING_START, 0.1f);
            shadowOf(Looper.getMainLooper())
                    .idleFor(Duration.ofMillis(AsgConstants.I2S_LEGACY_SETTLE_MS));
            verify(players.constructed().get(0)).start();

            Trace open = first(AudioTraceBus.BRIDGE_OPEN_REQ);
            assertThat(open.fields.get("token")).isEqualTo(token);
            int requestId = (Integer) open.fields.get("request_id");
            assertThat(first(AudioTraceBus.I2S_READY).fields.get("ready")).isEqualTo(true);
            assertThat(first(AudioTraceBus.PLAYER_START).fields.get("token")).isEqualTo(token);

            long second = controller.playAssetTracked(AudioAssets.RECORDING_START, 0.1f);
            Trace reused = first(AudioTraceBus.BRIDGE_REUSED);
            assertThat(reused.fields.get("token")).isEqualTo(second);
            assertThat(reused.fields.get("reason")).isEqualTo(AudioTraceBus.REUSE_READY);
            assertThat(reused.fields.get("request_id")).isEqualTo(requestId);
            assertThat(names()).containsSubsequence(
                    AudioTraceBus.PLAYER_REQUEST, AudioTraceBus.PLAYER_END, AudioTraceBus.BRIDGE_REUSED);
            assertThat(first(AudioTraceBus.PLAYER_END).fields.get("reason")).isEqualTo("stopped");
        }
    }

    @Test
    public void reportsPendingReuseWhenReadinessHasNotAnswered() {
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            controller.playAssetTracked(AudioAssets.RECORDING_START, 0.1f);
            controller.playAssetTracked(AudioAssets.RECORDING_START, 0.1f);
            Trace reused = first(AudioTraceBus.BRIDGE_REUSED);
            assertThat(reused.fields.get("reason")).isEqualTo(AudioTraceBus.REUSE_PENDING);
        }
    }

    @Test
    public void reportsGraceAndCloseAfterCompletion() {
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long token = controller.playAssetTracked(AudioAssets.RECORDING_START, 0.1f);
            shadowOf(Looper.getMainLooper())
                    .idleFor(Duration.ofMillis(AsgConstants.I2S_LEGACY_SETTLE_MS));
            MediaPlayer player = players.constructed().get(0);
            ArgumentCaptor<MediaPlayer.OnCompletionListener> completion =
                    ArgumentCaptor.forClass(MediaPlayer.OnCompletionListener.class);
            verify(player).setOnCompletionListener(completion.capture());
            completion.getValue().onCompletion(player);
            shadowOf(Looper.getMainLooper())
                    .idleFor(Duration.ofMillis(AsgConstants.I2S_IDLE_CLOSE_MS));

            int requestId = (Integer) first(AudioTraceBus.BRIDGE_OPEN_REQ).fields.get("request_id");
            Trace end = first(AudioTraceBus.PLAYER_END);
            assertThat(end.fields.get("token")).isEqualTo(token);
            assertThat(end.fields.get("reason")).isEqualTo("complete");
            assertThat(first(AudioTraceBus.GRACE_BEGIN).fields.get("request_id")).isEqualTo(requestId);
            Trace close = first(AudioTraceBus.BRIDGE_CLOSE);
            assertThat(close.fields.get("request_id")).isEqualTo(requestId);
            assertThat(close.fields.get("stop_sent")).isEqualTo(true);
        }
    }

    @Test
    public void emitsNothingWithoutASink() {
        AudioTraceBus.clearSink(sink);
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            controller.playAssetTracked(AudioAssets.RECORDING_START, 0.1f);
        }
        assertThat(traces).isEmpty();
    }
}

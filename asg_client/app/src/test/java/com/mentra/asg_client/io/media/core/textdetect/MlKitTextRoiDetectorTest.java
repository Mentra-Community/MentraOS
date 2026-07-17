package com.mentra.asg_client.io.media.core.textdetect;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.graphics.Rect;

import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognizer;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.Collections;

@RunWith(RobolectricTestRunner.class)
public class MlKitTextRoiDetectorTest {

    @Test
    public void paddedUnionCombinesLinesAndKeepsContext() {
        Rect roi =
                MlKitTextRoiDetector.buildPaddedUnion(
                        Arrays.asList(new Rect(100, 200, 300, 240), new Rect(120, 260, 420, 300)),
                        1000,
                        800);

        // Union is [100,200]-[420,300]. Padding is max(32px, 12%/25% of union size).
        assertThat(roi).isEqualTo(new Rect(62, 168, 458, 332));
    }

    @Test
    public void paddedUnionClampsToSourceBounds() {
        Rect roi =
                MlKitTextRoiDetector.buildPaddedUnion(
                        Collections.singletonList(new Rect(5, 8, 95, 92)), 100, 100);

        assertThat(roi).isEqualTo(new Rect(0, 0, 100, 100));
    }

    @Test
    public void singleLineKeepsGenerousSurroundingContext() {
        Rect roi =
                MlKitTextRoiDetector.buildPaddedUnion(
                        Collections.singletonList(new Rect(400, 500, 700, 550)), 1200, 1000);

        // A 50px-high lone line gets 3x height horizontally, 4x above, and 11x below.
        assertThat(roi).isEqualTo(new Rect(250, 300, 850, 1000));
    }

    @Test
    public void paddedUnionRejectsMissingOrInvalidBoxes() {
        assertThat(MlKitTextRoiDetector.buildPaddedUnion(Collections.emptyList(), 100, 100))
                .isNull();
        assertThat(
                        MlKitTextRoiDetector.buildPaddedUnion(
                                Collections.singletonList(new Rect(20, 20, 20, 40)), 100, 100))
                .isNull();
    }

    @Test
    public void failedWarmupCompletionClearsOnlyCurrentTask() throws Exception {
        TextRecognizer recognizer = mock(TextRecognizer.class);
        MlKitTextRoiDetector detector = new MlKitTextRoiDetector(1280, recognizer);
        Task<Text> currentTask = mock(Task.class);
        Task<Text> staleTask = mock(Task.class);
        when(currentTask.isSuccessful()).thenReturn(false);
        when(staleTask.isSuccessful()).thenReturn(false);
        Field warmupTask = MlKitTextRoiDetector.class.getDeclaredField("warmupTask");
        warmupTask.setAccessible(true);
        Method handleCompletion =
                MlKitTextRoiDetector.class.getDeclaredMethod("handleWarmupCompletion", Task.class);
        handleCompletion.setAccessible(true);
        warmupTask.set(detector, currentTask);

        handleCompletion.invoke(detector, staleTask);
        assertThat(warmupTask.get(detector)).isSameAs(currentTask);

        handleCompletion.invoke(detector, currentTask);
        assertThat(warmupTask.get(detector)).isNull();
        detector.close();
    }
}

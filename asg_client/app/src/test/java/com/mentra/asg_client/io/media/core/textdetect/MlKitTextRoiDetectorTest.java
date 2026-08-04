package com.mentra.asg_client.io.media.core.textdetect;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.graphics.Bitmap;
import android.graphics.Rect;

import androidx.test.core.app.ApplicationProvider;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.TaskCompletionSource;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognizer;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(RobolectricTestRunner.class)
public class MlKitTextRoiDetectorTest {

    @Test
    public void constructionDoesNotRequireMlKitProviderInitialization() {
        MlKitTextRoiDetector detector =
                new MlKitTextRoiDetector(ApplicationProvider.getApplicationContext());

        detector.close();
    }

    @Test
    public void getOrCreateRecognizerPrefersGetClientWithoutMandatoryInitialize()
            throws Exception {
        // Regression for d2a270364 / 1b5cf6e3a: calling MlKit.initialize() before getClient()
        // could throw and permanently disable text crop. First use must attempt getClient()
        // the same way the pre-lazy-init path did.
        MlKitTextRoiDetector detector =
                new MlKitTextRoiDetector(ApplicationProvider.getApplicationContext());
        Method getOrCreate =
                MlKitTextRoiDetector.class.getDeclaredMethod("getOrCreateRecognizer");
        getOrCreate.setAccessible(true);

        TextRecognizer created = (TextRecognizer) getOrCreate.invoke(detector);

        assertThat(created).isNotNull();
        Field recognizerField = MlKitTextRoiDetector.class.getDeclaredField("recognizer");
        recognizerField.setAccessible(true);
        assertThat(recognizerField.get(detector)).isSameAs(created);
        detector.close();
    }

    @Test
    public void warmupFallsBackWhenInputImageCannotReadMlKitContext() {
        TextRecognizer recognizer = mock(TextRecognizer.class);
        MlKitTextRoiDetector detector = new MlKitTextRoiDetector(1280, recognizer);

        // The injected-recognizer constructor deliberately has no Context, so Robolectric's
        // InputImage cannot read MlKitContext. This reproduces the incident's synchronous failure
        // and verifies that warm-up degrades to a full-frame transfer instead of aborting capture.
        assertThatCode(detector::warmUp).doesNotThrowAnyException();

        verify(recognizer, never()).process(org.mockito.ArgumentMatchers.any(InputImage.class));
        detector.close();
    }

    @Test
    public void paddedUnionCombinesLinesAndKeepsContext() {
        Rect roi =
                MlKitTextRoiDetector.buildPaddedUnion(
                        Arrays.asList(new Rect(100, 200, 300, 240), new Rect(120, 260, 420, 300)),
                        1000,
                        800);

        // Union is [100,200]-[420,300]. Padding is max(32px, 12%/35% of union size).
        assertThat(roi).isEqualTo(new Rect(62, 165, 458, 335));
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
        @SuppressWarnings("unchecked")
        AtomicReference<Task<Text>> warmupTaskReference =
                (AtomicReference<Task<Text>>) warmupTask.get(detector);
        warmupTaskReference.set(currentTask);

        handleCompletion.invoke(detector, staleTask);
        assertThat(warmupTaskReference.get()).isSameAs(currentTask);

        handleCompletion.invoke(detector, currentTask);
        assertThat(warmupTaskReference.get()).isNull();
        detector.close();
    }

    @Test
    public void timedOutWarmupRemainsRegisteredWhileStillRunning() throws Exception {
        TextRecognizer recognizer = mock(TextRecognizer.class);
        MlKitTextRoiDetector detector = new MlKitTextRoiDetector(1280, recognizer);
        TaskCompletionSource<Text> pending = new TaskCompletionSource<>();
        Field warmupTask = MlKitTextRoiDetector.class.getDeclaredField("warmupTask");
        warmupTask.setAccessible(true);
        @SuppressWarnings("unchecked")
        AtomicReference<Task<Text>> warmupTaskReference =
                (AtomicReference<Task<Text>>) warmupTask.get(detector);
        warmupTaskReference.set(pending.getTask());

        detector.handleWarmupAwaitFailure(pending.getTask());

        assertThat(warmupTaskReference.get()).isSameAs(pending.getTask());
        detector.close();
    }

    @Test
    public void pendingDetectionTaskDefersBitmapRecycleUntilCompletion() {
        Bitmap decoded = Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888);
        Bitmap analysis = Bitmap.createBitmap(16, 12, Bitmap.Config.ARGB_8888);
        TaskCompletionSource<Text> pending = new TaskCompletionSource<>();

        MlKitTextRoiDetector.recycleBitmapsAfterTask(
                pending.getTask(), analysis, decoded);

        assertThat(analysis.isRecycled()).isFalse();
        assertThat(decoded.isRecycled()).isFalse();

        pending.setResult(mock(Text.class));

        assertThat(analysis.isRecycled()).isTrue();
        assertThat(decoded.isRecycled()).isTrue();
    }

    @Test
    public void completedDetectionTaskRecyclesBitmapsImmediately() {
        Bitmap decoded = Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888);
        TaskCompletionSource<Text> completed = new TaskCompletionSource<>();
        completed.setResult(mock(Text.class));

        MlKitTextRoiDetector.recycleBitmapsAfterTask(
                completed.getTask(), decoded, decoded);

        assertThat(decoded.isRecycled()).isTrue();
    }

    @Test
    public void warmupDoesNotWaitForDetectionMonitor() throws Exception {
        TextRecognizer recognizer = mock(TextRecognizer.class);
        MlKitTextRoiDetector detector = new MlKitTextRoiDetector(1280, recognizer);
        Field warmupTaskField = MlKitTextRoiDetector.class.getDeclaredField("warmupTask");
        warmupTaskField.setAccessible(true);
        @SuppressWarnings("unchecked")
        AtomicReference<Task<Text>> warmupTaskReference =
                (AtomicReference<Task<Text>>) warmupTaskField.get(detector);
        warmupTaskReference.set(mock(Task.class));
        CountDownLatch monitorHeld = new CountDownLatch(1);
        CountDownLatch releaseMonitor = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> holder =
                    executor.submit(
                            () -> {
                                synchronized (detector) {
                                    monitorHeld.countDown();
                                    releaseMonitor.await();
                                }
                                return null;
                            });
            assertThat(monitorHeld.await(1, TimeUnit.SECONDS)).isTrue();

            Future<?> warmup = executor.submit(detector::warmUp);
            warmup.get(1, TimeUnit.SECONDS);

            releaseMonitor.countDown();
            holder.get(1, TimeUnit.SECONDS);
        } finally {
            releaseMonitor.countDown();
            executor.shutdownNow();
            detector.close();
        }
    }
}

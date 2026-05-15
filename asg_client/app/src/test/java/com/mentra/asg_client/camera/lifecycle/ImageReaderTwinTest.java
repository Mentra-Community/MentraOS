package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.graphics.ImageFormat;
import android.media.ImageReader;
import android.os.Handler;
import android.util.Size;
import android.view.Surface;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 0 unit tests guarding the twin-reader architecture introduced to fix the dark-frame
 * manual-exposure bug. We mock {@link ImageReader#newInstance(int, int, int, int)} because the
 * native JPEG buffer queue is not available in JVM unit tests.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class ImageReaderTwinTest {

    private MockedStatic<ImageReader> imageReaderStatic;
    private ImageReader previewReaderMock;
    private ImageReader stillReaderMock;
    private Surface previewSurface;
    private Surface stillSurface;
    private Handler backgroundHandler;
    private ImageReader.OnImageAvailableListener stillListener;

    @Before
    public void setUp() {
        previewReaderMock = mock(ImageReader.class);
        stillReaderMock = mock(ImageReader.class);
        previewSurface = mock(Surface.class);
        stillSurface = mock(Surface.class);
        backgroundHandler = mock(Handler.class);
        stillListener = mock(ImageReader.OnImageAvailableListener.class);

        when(previewReaderMock.getSurface()).thenReturn(previewSurface);
        when(stillReaderMock.getSurface()).thenReturn(stillSurface);

        imageReaderStatic = org.mockito.Mockito.mockStatic(ImageReader.class);
        imageReaderStatic
                .when(() -> ImageReader.newInstance(
                        ImageReaderTwin.PREVIEW_WIDTH,
                        ImageReaderTwin.PREVIEW_HEIGHT,
                        ImageFormat.YUV_420_888,
                        ImageReaderTwin.BUFFER_COUNT))
                .thenReturn(previewReaderMock);
        imageReaderStatic
                .when(() -> ImageReader.newInstance(
                        eq(1920),
                        eq(1080),
                        eq(ImageFormat.JPEG),
                        eq(ImageReaderTwin.BUFFER_COUNT)))
                .thenReturn(stillReaderMock);
    }

    @After
    public void tearDown() {
        imageReaderStatic.close();
    }

    @Test
    public void createsBothReadersWithCorrectSizesAndFormats() {
        new ImageReaderTwin(new Size(1920, 1080), backgroundHandler, stillListener);

        imageReaderStatic.verify(() -> ImageReader.newInstance(
                ImageReaderTwin.PREVIEW_WIDTH,
                ImageReaderTwin.PREVIEW_HEIGHT,
                ImageFormat.YUV_420_888,
                ImageReaderTwin.BUFFER_COUNT));
        imageReaderStatic.verify(() -> ImageReader.newInstance(
                1920, 1080, ImageFormat.JPEG, ImageReaderTwin.BUFFER_COUNT));
    }

    @Test
    public void bufferSizeIsTwoForBothReaders() {
        // Regression guard against the historical buffer-12 ZSL hack. We use the same
        // 1920x1080 size that {@link #setUp()} stubs out so {@code ImageReader.newInstance}
        // returns the configured mock; the assertion itself only depends on the constant.
        new ImageReaderTwin(new Size(1920, 1080), backgroundHandler, stillListener);

        assertThat(ImageReaderTwin.BUFFER_COUNT).isEqualTo(2);
    }

    @Test
    public void stillReaderListenerIsTheCallerProvided() {
        new ImageReaderTwin(new Size(1920, 1080), backgroundHandler, stillListener);

        verify(stillReaderMock).setOnImageAvailableListener(eq(stillListener), eq(backgroundHandler));
    }

    @Test
    public void previewReaderHasDrainOnlyListener() {
        new ImageReaderTwin(new Size(1920, 1080), backgroundHandler, stillListener);

        ArgumentCaptor<ImageReader.OnImageAvailableListener> drainCaptor =
                ArgumentCaptor.forClass(ImageReader.OnImageAvailableListener.class);
        verify(previewReaderMock).setOnImageAvailableListener(drainCaptor.capture(), eq(backgroundHandler));

        ImageReader.OnImageAvailableListener drain = drainCaptor.getValue();
        assertThat(drain).isNotNull();
        // The drain listener should not crash and should not be the still listener.
        assertThat(drain).isNotSameAs(stillListener);

        ImageReader drainSource = mock(ImageReader.class);
        when(drainSource.acquireLatestImage()).thenReturn(null);
        drain.onImageAvailable(drainSource);
        verify(drainSource).acquireLatestImage();
    }

    @Test
    public void surfacesAreDistinct() {
        ImageReaderTwin twin = new ImageReaderTwin(
                new Size(1920, 1080), backgroundHandler, stillListener);

        assertThat(twin.getPreviewSurface()).isNotSameAs(twin.getStillSurface());
    }

    @Test
    public void closesBothReadersOnDispose() {
        ImageReaderTwin twin = new ImageReaderTwin(
                new Size(1920, 1080), backgroundHandler, stillListener);

        twin.close();

        verify(previewReaderMock).close();
        verify(stillReaderMock).close();
    }

    @Test
    public void surfacesReturnsBothInPredictableOrder() {
        ImageReaderTwin twin = new ImageReaderTwin(
                new Size(1920, 1080), backgroundHandler, stillListener);

        assertThat(twin.surfaces())
                .containsExactly(twin.getPreviewSurface(), twin.getStillSurface());
    }

    @Test
    public void previewDrainSurvivesAcquireLatestImageThrowing() {
        new ImageReaderTwin(new Size(1920, 1080), backgroundHandler, stillListener);

        ArgumentCaptor<ImageReader.OnImageAvailableListener> drainCaptor =
                ArgumentCaptor.forClass(ImageReader.OnImageAvailableListener.class);
        verify(previewReaderMock).setOnImageAvailableListener(drainCaptor.capture(), eq(backgroundHandler));
        ImageReader.OnImageAvailableListener drain = drainCaptor.getValue();

        ImageReader noisyReader = mock(ImageReader.class);
        when(noisyReader.acquireLatestImage()).thenThrow(new RuntimeException("native fault"));

        drain.onImageAvailable(noisyReader); // Must not propagate.
    }

    @Test
    public void stillListenerInvokedOnStillReaderOnly() {
        new ImageReaderTwin(new Size(1920, 1080), backgroundHandler, stillListener);

        verify(stillReaderMock, times(1)).setOnImageAvailableListener(eq(stillListener), any(Handler.class));
        verify(previewReaderMock, never()).setOnImageAvailableListener(eq(stillListener), any(Handler.class));
    }
}

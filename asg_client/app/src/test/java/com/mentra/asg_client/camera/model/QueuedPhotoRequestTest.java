package com.mentra.asg_client.camera.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.mentra.asg_client.camera.CameraNeoService;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Unit tests for {@link QueuedPhotoRequest} (FIFO queue entries before capture starts).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class QueuedPhotoRequestTest {

    @Test
    public void requestId_isUnique_acrossInstances_withSameMillisecondAndDifferentPath() {
        QueuedPhotoRequest a = new QueuedPhotoRequest("/tmp/a.jpg", "medium", false, true, null, null);
        QueuedPhotoRequest b = new QueuedPhotoRequest("/tmp/b.jpg", "medium", false, true, null, null);
        assertThat(a.requestId).isNotEqualTo(b.requestId);
    }

    @Test
    public void timestamp_capturedAtConstruction() {
        long before = System.currentTimeMillis();
        QueuedPhotoRequest pr = new QueuedPhotoRequest("/tmp/x.jpg", "small", false, true, null, null);
        long after = System.currentTimeMillis();
        assertThat(pr.enqueuedAtMs).isBetween(before, after);
    }

    @Test
    public void allFieldsExposed() {
        CameraNeoService.PhotoCaptureCallback cb = mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest pr = new QueuedPhotoRequest("/tmp/y.jpg", "large", true, false, 200_000_000L, cb);

        assertThat(pr.filePath).isEqualTo("/tmp/y.jpg");
        assertThat(pr.size).isEqualTo("large");
        assertThat(pr.enableLed).isTrue();
        assertThat(pr.isFromSdk).isFalse();
        assertThat(pr.exposureTimeNs).isEqualTo(200_000_000L);
        assertThat(pr.callback).isSameAs(cb);
    }

    @Test
    public void nullExposureTimeNs_isAllowedAsAutoExposureSentinel() {
        QueuedPhotoRequest pr = new QueuedPhotoRequest("/tmp/z.jpg", "small", false, true, null, null);
        assertThat(pr.exposureTimeNs).isNull();
    }
}

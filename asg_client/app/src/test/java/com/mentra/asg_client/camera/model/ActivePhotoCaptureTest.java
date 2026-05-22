package com.mentra.asg_client.camera.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.mentra.asg_client.camera.CameraNeoService;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Unit tests for {@link ActivePhotoCapture} and {@link ActivePhotoCapture#fromQueued}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class ActivePhotoCaptureTest {

    @Test
    public void fromQueued_copiesAllFields() {
        CameraNeoService.PhotoCaptureCallback cb = mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest pr = new QueuedPhotoRequest("/tmp/a.jpg", "medium", true, true, 100_000_000L, cb);

        ActivePhotoCapture cur = ActivePhotoCapture.fromQueued(pr);

        assertThat(cur.filePath).isEqualTo("/tmp/a.jpg");
        assertThat(cur.size).isEqualTo("medium");
        assertThat(cur.ledEnabled).isTrue();
        assertThat(cur.isFromSdk).isTrue();
        assertThat(cur.exposureTimeNs).isEqualTo(100_000_000L);
        assertThat(cur.startTimeMs).isEqualTo(pr.enqueuedAtMs);
        assertThat(cur.callback).isSameAs(cb);
    }

    @Test
    public void nullExposureTimeNs_meansAuto() {
        QueuedPhotoRequest pr = new QueuedPhotoRequest("/tmp/auto.jpg", "small", false, true, null, null);
        ActivePhotoCapture cur = ActivePhotoCapture.fromQueued(pr);
        assertThat(cur.exposureTimeNs).isNull();
    }

    @Test
    public void equals_isReflexive_andCompares_allFields() {
        long t = 42L;
        CameraNeoService.PhotoCaptureCallback cb = mock(CameraNeoService.PhotoCaptureCallback.class);
        ActivePhotoCapture a = new ActivePhotoCapture("/p", "s", true, 1L, false, t, cb);
        ActivePhotoCapture b = new ActivePhotoCapture("/p", "s", true, 1L, false, t, cb);
        assertThat(a).isEqualTo(b).hasSameHashCodeAs(b);
    }

    @Test
    public void equals_distinguishesEachFieldDifference() {
        long t = 42L;
        ActivePhotoCapture base = new ActivePhotoCapture("/p", "s", true, 1L, false, t, null);
        assertThat(base).isNotEqualTo(new ActivePhotoCapture("/q", "s", true, 1L, false, t, null));
        assertThat(base).isNotEqualTo(new ActivePhotoCapture("/p", "x", true, 1L, false, t, null));
        assertThat(base).isNotEqualTo(new ActivePhotoCapture("/p", "s", false, 1L, false, t, null));
        assertThat(base).isNotEqualTo(new ActivePhotoCapture("/p", "s", true, 2L, false, t, null));
        assertThat(base).isNotEqualTo(new ActivePhotoCapture("/p", "s", true, 1L, true, t, null));
        assertThat(base).isNotEqualTo(new ActivePhotoCapture("/p", "s", true, 1L, false, t + 1, null));
    }

    @Test
    public void allFieldsAreFinal() throws Exception {
        for (java.lang.reflect.Field f : ActivePhotoCapture.class.getDeclaredFields()) {
            if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) {
                continue;
            }
            assertThat(java.lang.reflect.Modifier.isFinal(f.getModifiers()))
                    .as("Field %s should be final", f.getName())
                    .isTrue();
        }
    }
}

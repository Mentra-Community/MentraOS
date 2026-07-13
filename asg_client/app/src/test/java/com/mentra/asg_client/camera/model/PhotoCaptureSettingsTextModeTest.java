package com.mentra.asg_client.camera.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public class PhotoCaptureSettingsTextModeTest {

    @Test
    public void applyTextModeExposureDividesMeteredShutterByThree() {
        PhotoCaptureSettings tuned =
                PhotoCaptureSettings.applyTextModeExposure(PhotoCaptureSettings.EMPTY);

        assertEquals(
                Integer.valueOf(PhotoCaptureSettings.TEXT_MODE_AE_EXPOSURE_DIVISOR),
                tuned.aeExposureDivisor);
        assertFalse(tuned.mfnrEnabled());
        assertEquals(Boolean.FALSE, tuned.zsl);
    }

    @Test
    public void applyTextModeExposurePreservesExplicitTuning() {
        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder()
                        .isoCap(800)
                        .mfnr(true)
                        .zsl(true)
                        .edgeEnhancement(false)
                        .build();

        PhotoCaptureSettings tuned = PhotoCaptureSettings.applyTextModeExposure(request);

        assertEquals(Integer.valueOf(800), tuned.isoCap);
        assertEquals(Boolean.TRUE, tuned.mfnr);
        assertEquals(Boolean.TRUE, tuned.zsl);
        assertEquals(Boolean.FALSE, tuned.edgeEnhancement);
    }
}

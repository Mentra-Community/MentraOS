package com.mentra.asg_client.camera.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.settings.AsgSettings;
import org.junit.Test;

public class PhotoCaptureSettingsTextModeTest {

    @Test
    public void applyTextModeExposureDividesMeteredShutterByThree() {
        PhotoCaptureSettings tuned =
                PhotoCaptureSettings.applyTextModeExposure(PhotoCaptureSettings.EMPTY);

        assertEquals(
                Integer.valueOf(AsgConstants.TEXT_MODE_AE_EXPOSURE_DIVISOR),
                tuned.aeExposureDivisor);
        assertFalse(tuned.zslEnabled());
        assertFalse(tuned.mfnrEnabled());
        assertEquals(Boolean.FALSE, tuned.mfnr);
        assertEquals(Boolean.FALSE, tuned.zsl);
    }

    @Test
    public void applyTextModeExposurePreservesExplicitTuningButForcesZslMfnrOff() {
        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder()
                        .isoCap(800)
                        .zsl(true)
                        .mfnr(true)
                        .edgeEnhancement(false)
                        .build();

        PhotoCaptureSettings tuned = PhotoCaptureSettings.applyTextModeExposure(request);

        assertEquals(Integer.valueOf(800), tuned.isoCap);
        assertEquals(Boolean.FALSE, tuned.mfnr);
        assertEquals(Boolean.FALSE, tuned.zsl);
        assertEquals(Boolean.FALSE, tuned.edgeEnhancement);
    }

    @Test
    public void textModeDefaultsOverrideStoredGlobalZslMfnr() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(true);
        when(stored.isMfnrEnabled()).thenReturn(true);

        PhotoCaptureSettings textDefaults =
                PhotoCaptureSettings.applyTextModeExposure(PhotoCaptureSettings.EMPTY);
        PhotoCaptureSettings merged =
                PhotoCaptureSettings.mergeForSdkRequest(textDefaults, stored);

        assertEquals(Boolean.FALSE, merged.mfnr);
        assertEquals(Boolean.FALSE, merged.zsl);
    }
}

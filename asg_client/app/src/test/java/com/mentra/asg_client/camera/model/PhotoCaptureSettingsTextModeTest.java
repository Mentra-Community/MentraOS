package com.mentra.asg_client.camera.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
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
        assertNull(tuned.zsl);
        assertNull(tuned.mfnr);
    }

    @Test
    public void applyTextModeExposurePreservesExplicitTuningIncludingZslMfnr() {
        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder()
                        .isoCap(800)
                        .zsl(true)
                        .mfnr(true)
                        .edgeEnhancement(false)
                        .build();

        PhotoCaptureSettings tuned = PhotoCaptureSettings.applyTextModeExposure(request);

        assertEquals(Integer.valueOf(800), tuned.isoCap);
        assertEquals(Boolean.TRUE, tuned.mfnr);
        assertEquals(Boolean.TRUE, tuned.zsl);
        assertEquals(Boolean.FALSE, tuned.edgeEnhancement);
    }

    @Test
    public void textModeAbsentZslMfnrInheritsStoredGlobals() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(true);
        when(stored.isMfnrEnabled()).thenReturn(true);

        PhotoCaptureSettings textDefaults =
                PhotoCaptureSettings.applyTextModeExposure(PhotoCaptureSettings.EMPTY);
        PhotoCaptureSettings merged =
                PhotoCaptureSettings.mergeForSdkRequest(textDefaults, stored);

        assertEquals(Boolean.TRUE, merged.mfnr);
        assertEquals(Boolean.TRUE, merged.zsl);
    }
}

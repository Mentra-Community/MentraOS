package com.mentra.asg_client.camera.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.settings.AsgSettings;
import org.junit.Test;

public class PhotoCaptureSettingsTextModeTest {

    @Test
    public void mergeForSdkRequest_doesNotInjectTextModeAeDivisor() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(true);
        when(stored.isMfnrEnabled()).thenReturn(true);

        PhotoCaptureSettings merged =
                PhotoCaptureSettings.mergeForSdkRequest(PhotoCaptureSettings.EMPTY, stored);

        assertNull(
                "text mode no longer injects aeExposureDivisor; EMPTY must stay unset",
                merged.aeExposureDivisor);
        assertEquals(Boolean.TRUE, merged.zsl);
        assertEquals(Boolean.TRUE, merged.mfnr);
    }

    @Test
    public void mergeForSdkRequest_preservesExplicitAeDivisorAndZslMfnr() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(true);
        when(stored.isMfnrEnabled()).thenReturn(true);

        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder()
                        .aeExposureDivisor(3)
                        .isoCap(800)
                        .zsl(true)
                        .mfnr(true)
                        .edgeEnhancement(false)
                        .build();

        PhotoCaptureSettings merged = PhotoCaptureSettings.mergeForSdkRequest(request, stored);

        assertEquals(Integer.valueOf(3), merged.aeExposureDivisor);
        assertEquals(Integer.valueOf(800), merged.isoCap);
        assertEquals(Boolean.TRUE, merged.mfnr);
        assertEquals(Boolean.TRUE, merged.zsl);
        assertEquals(Boolean.FALSE, merged.edgeEnhancement);
    }
}

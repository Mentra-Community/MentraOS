package com.mentra.asg_client.camera.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.settings.AsgSettings;
import org.json.JSONObject;
import org.junit.Test;

public class PhotoCaptureSettingsZslMfnrTest {

    @Test
    public void resolveZslMfnrUnifiedWinsOverLegacy() {
        assertEquals(Boolean.FALSE, PhotoCaptureSettings.resolveZslMfnr(false, true, true));
        assertEquals(Boolean.TRUE, PhotoCaptureSettings.resolveZslMfnr(true, false, false));
    }

    @Test
    public void resolveZslMfnrLegacyRequiresBothTrue() {
        assertEquals(Boolean.TRUE, PhotoCaptureSettings.resolveZslMfnr(null, true, true));
        assertEquals(Boolean.FALSE, PhotoCaptureSettings.resolveZslMfnr(null, true, false));
        assertEquals(Boolean.FALSE, PhotoCaptureSettings.resolveZslMfnr(null, false, true));
        assertEquals(Boolean.FALSE, PhotoCaptureSettings.resolveZslMfnr(null, false, false));
        assertEquals(Boolean.FALSE, PhotoCaptureSettings.resolveZslMfnr(null, true, null));
        assertEquals(Boolean.FALSE, PhotoCaptureSettings.resolveZslMfnr(null, null, true));
    }

    @Test
    public void resolveZslMfnrAbsentReturnsNull() {
        assertNull(PhotoCaptureSettings.resolveZslMfnr(null, null, null));
    }

    @Test
    public void fromTakePhotoJsonParsesUnifiedAndMirrorsLegacy() throws Exception {
        JSONObject data = new JSONObject();
        data.put("zslMfnr", true);

        PhotoCaptureSettings settings = PhotoCaptureSettings.fromTakePhotoJson(data);

        assertEquals(Boolean.TRUE, settings.zslMfnr);
        assertEquals(Boolean.TRUE, settings.mfnr);
        assertEquals(Boolean.TRUE, settings.zsl);
        assertTrue(settings.zslMfnrEnabled());
    }

    @Test
    public void fromTakePhotoJsonMapsLegacyPair() throws Exception {
        JSONObject both = new JSONObject().put("mfnr", true).put("zsl", true);
        assertEquals(Boolean.TRUE, PhotoCaptureSettings.fromTakePhotoJson(both).zslMfnr);

        JSONObject conflict = new JSONObject().put("mfnr", true).put("zsl", false);
        assertEquals(Boolean.FALSE, PhotoCaptureSettings.fromTakePhotoJson(conflict).zslMfnr);
    }

    @Test
    public void mergeForSdkRequestInheritsGlobalDefault() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslMfnrEnabled()).thenReturn(true);

        PhotoCaptureSettings absent =
                PhotoCaptureSettings.mergeForSdkRequest(PhotoCaptureSettings.EMPTY, stored);
        assertEquals(Boolean.TRUE, absent.zslMfnr);
    }

    @Test
    public void mergeForSdkRequestScanDivisorForcesOff() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslMfnrEnabled()).thenReturn(true);

        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder().aeExposureDivisor(3).build();
        PhotoCaptureSettings merged =
                PhotoCaptureSettings.mergeForSdkRequest(request, stored);

        assertEquals(Boolean.FALSE, merged.zslMfnr);
        assertFalse(merged.zslMfnrEnabled());
    }

    @Test
    public void mergeWithStoredDefaultsIgnoresButtonZslMfnrPreset() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslMfnrEnabled()).thenReturn(true);
        when(stored.getButtonPhotoZslMfnr()).thenReturn(false);
        when(stored.getButtonPhotoAeExposureDivisor()).thenReturn(null);
        when(stored.getButtonPhotoNoiseReduction()).thenReturn(null);
        when(stored.getButtonPhotoIspDigitalGain()).thenReturn(null);
        when(stored.getButtonPhotoIspAnalogGain()).thenReturn(null);

        PhotoCaptureSettings merged =
                PhotoCaptureSettings.mergeWithStoredDefaults(PhotoCaptureSettings.EMPTY, stored);

        assertEquals(Boolean.TRUE, merged.zslMfnr);
    }

    @Test
    public void applyTextModeExposureForcesZslMfnrOff() {
        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder().zslMfnr(true).isoCap(800).build();

        PhotoCaptureSettings tuned = PhotoCaptureSettings.applyTextModeExposure(request);

        assertEquals(Boolean.FALSE, tuned.zslMfnr);
        assertEquals(Boolean.FALSE, tuned.mfnr);
        assertEquals(Boolean.FALSE, tuned.zsl);
        assertFalse(tuned.zslMfnrEnabled());
        assertEquals(Integer.valueOf(800), tuned.isoCap);
    }

    @Test
    public void zslMfnrEnabledDefaultsFalseWhenUnset() {
        assertFalse(PhotoCaptureSettings.EMPTY.zslMfnrEnabled());
        assertFalse(new PhotoCaptureSettings.Builder().zslMfnr(false).build().zslMfnrEnabled());
    }
}

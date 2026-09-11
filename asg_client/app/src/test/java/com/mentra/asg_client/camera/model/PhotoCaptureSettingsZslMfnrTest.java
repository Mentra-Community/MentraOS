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
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class PhotoCaptureSettingsZslMfnrTest {

    @Test
    public void resolveMergedFlag_requestWinsOverGlobal() {
        assertTrue(PhotoCaptureSettings.resolveMergedFlag(true, null, false));
        assertFalse(PhotoCaptureSettings.resolveMergedFlag(false, null, true));
    }

    @Test
    public void resolveMergedFlag_inheritsStoredThenGlobal() {
        assertTrue(PhotoCaptureSettings.resolveMergedFlag(null, true, false));
        assertFalse(PhotoCaptureSettings.resolveMergedFlag(null, null, false));
        assertTrue(PhotoCaptureSettings.resolveMergedFlag(null, null, true));
    }

    @Test
    public void fromTakePhotoJson_parsesIndependentFlags() throws Exception {
        JSONObject data = new JSONObject();
        data.put("zsl", true);
        data.put("mfnr", false);
        PhotoCaptureSettings settings = PhotoCaptureSettings.fromTakePhotoJson(data);
        assertEquals(Boolean.TRUE, settings.zsl);
        assertEquals(Boolean.FALSE, settings.mfnr);
        assertTrue(settings.zslEnabled());
        assertFalse(settings.mfnrEnabled());
    }

    @Test
    public void fromTakePhotoJson_ignoresRemovedZslMfnrKey() throws Exception {
        JSONObject data = new JSONObject();
        data.put("zslMfnr", true);
        PhotoCaptureSettings settings = PhotoCaptureSettings.fromTakePhotoJson(data);
        assertNull(settings.zsl);
        assertNull(settings.mfnr);
    }

    @Test
    public void fromTakePhotoJson_allowsIndependentCombinations() throws Exception {
        JSONObject zslOnly = new JSONObject();
        zslOnly.put("zsl", true);
        assertEquals(Boolean.TRUE, PhotoCaptureSettings.fromTakePhotoJson(zslOnly).zsl);
        assertNull(PhotoCaptureSettings.fromTakePhotoJson(zslOnly).mfnr);

        JSONObject mfnrOnly = new JSONObject();
        mfnrOnly.put("mfnr", true);
        assertNull(PhotoCaptureSettings.fromTakePhotoJson(mfnrOnly).zsl);
        assertEquals(Boolean.TRUE, PhotoCaptureSettings.fromTakePhotoJson(mfnrOnly).mfnr);
    }

    @Test
    public void mergeForSdkRequest_inheritsGlobalWhenAbsent() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(true);
        when(stored.isMfnrEnabled()).thenReturn(false);

        PhotoCaptureSettings absent =
                PhotoCaptureSettings.mergeForSdkRequest(PhotoCaptureSettings.EMPTY, stored);
        assertEquals(Boolean.TRUE, absent.zsl);
        assertEquals(Boolean.FALSE, absent.mfnr);
    }

    @Test
    public void mergeForSdkRequest_scanDivisorPreservesRequestFlags() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(false);
        when(stored.isMfnrEnabled()).thenReturn(false);

        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder().aeExposureDivisor(3).zsl(true).mfnr(true).build();
        PhotoCaptureSettings merged = PhotoCaptureSettings.mergeForSdkRequest(request, stored);
        assertEquals(Boolean.TRUE, merged.zsl);
        assertEquals(Boolean.TRUE, merged.mfnr);
        assertTrue(merged.zslEnabled());
        assertTrue(merged.mfnrEnabled());
    }

    @Test
    public void mergeWithStoredDefaults_usesIndependentButtonPresets() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(true);
        when(stored.isMfnrEnabled()).thenReturn(true);
        when(stored.getButtonPhotoZsl()).thenReturn(false);
        when(stored.getButtonPhotoMfnr()).thenReturn(false);
        when(stored.getButtonPhotoAeExposureDivisor()).thenReturn(null);

        PhotoCaptureSettings merged =
                PhotoCaptureSettings.mergeWithStoredDefaults(PhotoCaptureSettings.EMPTY, stored);
        assertEquals("zsl should use the button preset", Boolean.FALSE, merged.zsl);
        assertEquals("mfnr should use the button preset", Boolean.FALSE, merged.mfnr);
    }

    @Test
    public void mergeWithStoredDefaults_inheritsGlobalsWhenButtonPresetsAbsent() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(false);
        when(stored.isMfnrEnabled()).thenReturn(true);
        when(stored.getButtonPhotoZsl()).thenReturn(null);
        when(stored.getButtonPhotoMfnr()).thenReturn(null);

        PhotoCaptureSettings merged =
                PhotoCaptureSettings.mergeWithStoredDefaults(PhotoCaptureSettings.EMPTY, stored);
        assertEquals(Boolean.FALSE, merged.zsl);
        assertEquals(Boolean.TRUE, merged.mfnr);
    }

    @Test
    public void mergeForSdkRequest_preservesRequestZslMfnr() {
        AsgSettings stored = mock(AsgSettings.class);
        when(stored.isZslEnabled()).thenReturn(false);
        when(stored.isMfnrEnabled()).thenReturn(false);

        PhotoCaptureSettings request =
                new PhotoCaptureSettings.Builder().zsl(true).mfnr(true).isoCap(800).build();
        PhotoCaptureSettings merged = PhotoCaptureSettings.mergeForSdkRequest(request, stored);
        assertEquals(Boolean.TRUE, merged.zsl);
        assertEquals(Boolean.TRUE, merged.mfnr);
        assertEquals(Integer.valueOf(800), merged.isoCap);
        assertTrue(merged.zslEnabled());
        assertTrue(merged.mfnrEnabled());
    }

    @Test
    public void enabledAccessorsDefaultFalseWhenUnset() {
        assertFalse(PhotoCaptureSettings.EMPTY.zslEnabled());
        assertFalse(PhotoCaptureSettings.EMPTY.mfnrEnabled());
        assertFalse(new PhotoCaptureSettings.Builder().zsl(false).build().zslEnabled());
        assertFalse(new PhotoCaptureSettings.Builder().mfnr(false).build().mfnrEnabled());
    }
}

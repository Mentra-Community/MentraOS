package com.mentra.asg_client.version;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Bundle;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AsgVersionTest {
    @Test
    public void readsManifestMetadata() {
        PackageInfo info = new PackageInfo();
        info.versionCode = 1_000_000_000;
        info.applicationInfo = new ApplicationInfo();
        info.applicationInfo.metaData = new Bundle();
        info.applicationInfo.metaData.putString(AsgVersion.MANIFEST_KEY, "asg-48332721");

        assertEquals(48_332_721L, AsgVersion.fromPackageInfo(info));
    }

    @Test
    public void legacyPackageFallsBackToAndroidVersionCode() {
        PackageInfo info = new PackageInfo();
        info.versionCode = 47_442_366;

        assertEquals(47_442_366L, AsgVersion.fromPackageInfo(info));
    }

    @Test
    public void fixedTransportCodeWithoutMetadataIsNotLogicalVersion() {
        PackageInfo info = new PackageInfo();
        info.versionCode = 1_000_000_000;

        assertEquals(-1L, AsgVersion.fromPackageInfo(info));
    }

    @Test
    public void targetFallsBackToLegacyVersionCode() throws Exception {
        JSONObject modern = new JSONObject().put("asgVersion", 48_332_721L).put("versionCode", 1_000_000_000);
        JSONObject legacy = new JSONObject().put("versionCode", 47_442_366L);

        assertEquals(48_332_721L, AsgVersion.fromManifestApp(modern));
        assertEquals(47_442_366L, AsgVersion.fromManifestApp(legacy));
    }

    @Test
    public void targetDoesNotTreatFixedTransportCodeAsLogicalVersion() throws Exception {
        JSONObject malformed = new JSONObject().put("versionCode", 1_000_000_000L);

        assertEquals(-1L, AsgVersion.fromManifestApp(malformed));
    }

    @Test
    public void exactMatchUpgradeAndDowngradeUseLogicalVersion() {
        assertFalse(AsgVersion.requiresInstall(200L, 200L));
        assertTrue(AsgVersion.requiresInstall(200L, 201L));
        assertTrue(AsgVersion.requiresInstall(200L, 199L));
        assertFalse(AsgVersion.isDowngrade(200L, 201L));
        assertTrue(AsgVersion.isDowngrade(200L, 199L));
    }
}

package com.mentra.recovery;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.recovery.service.HotspotOtaFailsafe;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class HotspotOtaFailsafeTest {
  private HotspotOtaFailsafe failsafe;

  @Before
  public void setUp() {
    Context context = ApplicationProvider.getApplicationContext();
    context.getSharedPreferences("hotspot_ota_failsafe", Context.MODE_PRIVATE).edit().clear().commit();
    failsafe = new HotspotOtaFailsafe(context);
  }

  @Test
  public void cleanupRequiresExplicitOwnedRestart() {
    assertFalse(failsafe.stopOrphanedVendorApIfOwned());

    failsafe.setOwnedRestart(true);
    assertTrue(failsafe.stopOrphanedVendorApIfOwned());
    assertFalse(failsafe.isOwnedRestart());
  }

  @Test
  public void successfulInstallClearsOwnership() {
    failsafe.setOwnedRestart(true);
    failsafe.clear();

    assertFalse(failsafe.stopOrphanedVendorApIfOwned());
  }
}

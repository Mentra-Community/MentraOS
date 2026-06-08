package com.mentra.recovery;

import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.content.Intent;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.mentra.recovery.service.RecoveryService;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RecoveryServiceSmokeTest {
  @Test
  public void canCreateRecoveryServiceIntent() {
    Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Intent intent = new Intent(appContext, RecoveryService.class);
    assertNotNull(intent.getComponent());
  }
}

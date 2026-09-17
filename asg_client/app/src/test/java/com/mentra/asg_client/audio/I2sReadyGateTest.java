package com.mentra.asg_client.audio;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;

import com.mentra.asg_client.AsgConstants;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.time.Duration;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class I2sReadyGateTest {
    private I2sReadyGate gate;
    private Runnable start;
    private Runnable fail;

    @Before
    public void setup() {
        I2sReadyGate.invalidateLink();
        I2sReadyGate.setSupported(true);
        gate = new I2sReadyGate(new Handler(Looper.getMainLooper()));
        start = mock(Runnable.class);
        fail = mock(Runnable.class);
    }

    @After
    public void cleanup() {
        gate.cancel();
        I2sReadyGate.invalidateLink();
        shadowOf(Looper.getMainLooper()).idle();
    }

    @Test
    public void waitsPastOldDelayUntilMatchingReady() {
        int id = gate.begin();
        gate.whenReady(start, fail);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(120));
        I2sReadyGate.onResponse(id + 1, true);
        shadowOf(Looper.getMainLooper()).idle();
        verifyNoInteractions(start, fail);
        I2sReadyGate.onResponse(id, true);
        I2sReadyGate.onResponse(id, true);
        shadowOf(Looper.getMainLooper()).idle();
        verify(start).run();
        verifyNoInteractions(fail);
    }

    @Test
    public void replyBeforePlayerPreparationIsRemembered() {
        int id = gate.begin();
        I2sReadyGate.onResponse(id, true);
        gate.whenReady(start, fail);
        shadowOf(Looper.getMainLooper()).idle();
        verify(start).run();
    }

    @Test
    public void timeoutOnCapableFirmwareDoesNotPlay() {
        gate.begin();
        gate.whenReady(start, fail);
        shadowOf(Looper.getMainLooper())
                .idleFor(Duration.ofMillis(AsgConstants.I2S_READY_TIMEOUT_MS));
        verify(fail).run();
        verifyNoInteractions(start);
    }

    @Test
    public void cancelledAndStaleReadyCannotStartReplacement() {
        int old = gate.begin();
        gate.whenReady(start, fail);
        gate.cancel();
        int next = gate.begin();
        Runnable replacement = mock(Runnable.class);
        gate.whenReady(replacement, mock(Runnable.class));
        I2sReadyGate.onResponse(old, true);
        shadowOf(Looper.getMainLooper()).idle();
        verifyNoInteractions(start, replacement);
        I2sReadyGate.onResponse(next, true);
        shadowOf(Looper.getMainLooper()).idle();
        verify(replacement).run();
    }

    @Test
    public void resetAfterAckBeforeCallbackCannotPlay() {
        int id = gate.begin();
        gate.whenReady(start, fail);
        I2sReadyGate.onResponse(id, true);
        I2sReadyGate.invalidateLink();
        shadowOf(Looper.getMainLooper()).idle();
        verifyNoInteractions(start);
        verify(fail).run();
    }

    @Test
    public void failedOpenDoesNotPlay() {
        int id = gate.begin();
        gate.whenReady(start, fail);
        I2sReadyGate.onResponse(id, false);
        shadowOf(Looper.getMainLooper()).idle();
        verify(fail).run();
        verifyNoInteractions(start);
    }

    @Test
    public void anotherOwnerStoppingBridgeInvalidatesCachedReady() {
        int id = gate.begin();
        I2sReadyGate.onResponse(id, true);
        I2sReadyGate.onBridgeStopped();
        gate.whenReady(start, fail);
        shadowOf(Looper.getMainLooper()).idle();
        verifyNoInteractions(start);
        verify(fail).run();
    }

    @Test
    public void legacyFirmwareUsesBoundedCompatibilityDelay() {
        I2sReadyGate.setSupported(false);
        gate.begin();
        gate.whenReady(start, fail);
        shadowOf(Looper.getMainLooper())
                .idleFor(Duration.ofMillis(AsgConstants.I2S_LEGACY_SETTLE_MS - 1));
        verifyNoInteractions(start);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));
        verify(start).run();
        verifyNoInteractions(fail);
    }
}

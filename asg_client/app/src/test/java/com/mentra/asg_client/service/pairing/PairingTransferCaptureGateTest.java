package com.mentra.asg_client.service.pairing;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PairingTransferCaptureGateTest {
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        PairingTransferCaptureGate.clear(context);
    }

    @After
    public void tearDown() {
        PairingTransferCaptureGate.clear(context);
    }

    @Test
    public void clear_requiresMatchingNonEmptyTransferId() {
        PairingTransferCaptureGate.arm(context, "active-transfer");

        assertThat(PairingTransferCaptureGate.clear(context, "")).isFalse();
        assertThat(PairingTransferCaptureGate.clear(context, "wrong-transfer")).isFalse();
        assertThat(PairingTransferCaptureGate.isActive(context)).isTrue();

        assertThat(PairingTransferCaptureGate.clear(context, "active-transfer")).isTrue();
        assertThat(PairingTransferCaptureGate.isActive(context)).isFalse();
    }
}

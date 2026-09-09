package com.mentra.asg_client.hardware;

import static org.junit.Assert.assertSame;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900LedControllerTest {
    @Test
    public void hardwareManagerReset_reusesSameControllerAndCommandQueue() {
        K900LedController first = K900LedController.getInstance();
        first.shutdown();
        // Pending OFF and subsequent ON stay on one FIFO, never on competing workers.
        assertSame(first, K900LedController.getInstance());
        first.shutdown();
        assertSame(first, K900LedController.getInstance());
    }
}

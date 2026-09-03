package com.mentra.asg_client.io.hardware.core;

import static org.junit.Assert.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.content.Context;

import org.junit.Before;
import org.junit.Test;

public class BaseHardwareManagerRecordingLedTest {
    private TestHardwareManager hardwareManager;

    @Before
    public void setUp() {
        Context context = mock(Context.class);
        when(context.getApplicationContext()).thenReturn(context);
        hardwareManager = new TestHardwareManager(context);
    }

    @Test
    public void overlappingOwners_keepLedOnUntilLastRelease() {
        Object photoOwner = new Object();
        Object uvcOwner = new Object();

        hardwareManager.acquireRecordingLed(photoOwner);
        hardwareManager.acquireRecordingLed(uvcOwner);

        assertEquals(1, hardwareManager.onCalls);
        assertEquals(0, hardwareManager.offCalls);

        hardwareManager.releaseRecordingLed(photoOwner);
        assertEquals(0, hardwareManager.offCalls);

        hardwareManager.releaseRecordingLed(uvcOwner);
        assertEquals(1, hardwareManager.offCalls);
    }

    @Test
    public void duplicateAcquireAndRelease_areIdempotent() {
        Object owner = new Object();

        hardwareManager.acquireRecordingLed(owner);
        hardwareManager.acquireRecordingLed(owner);
        hardwareManager.releaseRecordingLed(owner);
        hardwareManager.releaseRecordingLed(owner);

        assertEquals(1, hardwareManager.onCalls);
        assertEquals(1, hardwareManager.offCalls);
    }

    private static final class TestHardwareManager extends BaseHardwareManager {
        private int onCalls;
        private int offCalls;

        private TestHardwareManager(Context context) {
            super(context);
        }

        @Override
        public boolean supportsRecordingLed() {
            return true;
        }

        @Override
        public void setRecordingLedOn() {
            onCalls++;
        }

        @Override
        public void setRecordingLedOff() {
            offCalls++;
        }
    }
}

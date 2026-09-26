package com.mentra.asg_client.camera.policy;

import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class CameraFovPolicyTest {
    @Test public void bottomAlignmentFollowsAppliedLeaseAndRestoration() {
        CameraFovPolicy policy = new CameraFovPolicy();
        assertFalse(policy.isFullFovBottomAligned());
        policy.apply(118, 0, () -> false, () -> {});
        assertFalse(policy.isFullFovBottomAligned());
        policy.apply(118, 1, () -> false, () -> {});
        assertTrue(policy.isFullFovBottomAligned());
        assertEquals(CameraFovPolicy.Result.BUSY,
                policy.apply(118, 0, () -> true, () -> fail("busy restoration must wait")));
        assertTrue(policy.isFullFovBottomAligned());
        policy.apply(118, 0, () -> false, () -> {});
        assertFalse(policy.isFullFovBottomAligned());
        policy.apply(92, 1, () -> false, () -> {});
        assertFalse(policy.isFullFovBottomAligned());
        policy.apply(118, 2, () -> false, () -> {});
        assertFalse(policy.isFullFovBottomAligned());
    }

    @Test public void failedWriteCannotEnableBottomAlignment() {
        CameraFovPolicy policy = new CameraFovPolicy();
        policy.apply(118, 1, () -> false, () -> {});
        assertThrows(IllegalStateException.class,
                () -> policy.apply(92, 0, () -> false, () -> { throw new IllegalStateException(); }));
        assertFalse(policy.isFullFovBottomAligned());
    }

    @Test public void repeatedSettingsNeverRestartAnActiveCapture() {
        CameraFovPolicy policy = new CameraFovPolicy();
        AtomicInteger writes = new AtomicInteger();
        assertEquals(CameraFovPolicy.Result.CHANGED,
                policy.apply(118, 0, () -> false, writes::incrementAndGet));
        assertEquals(CameraFovPolicy.Result.UNCHANGED,
                policy.apply(118, 0, () -> true, writes::incrementAndGet));
        assertEquals(1, writes.get());
    }

    @Test public void changesAndLeaseRestorationWaitForCaptureToStop() {
        CameraFovPolicy policy = new CameraFovPolicy();
        AtomicInteger writes = new AtomicInteger();
        policy.apply(90, 1, () -> false, writes::incrementAndGet);
        assertEquals(CameraFovPolicy.Result.BUSY,
                policy.apply(118, 0, () -> true, writes::incrementAndGet));
        assertEquals(1, writes.get());
        assertEquals(CameraFovPolicy.Result.CHANGED,
                policy.apply(118, 0, () -> false, writes::incrementAndGet));
        assertEquals(2, writes.get());
    }

    @Test public void failedHardwareWriteInvalidatesAppliedState() {
        CameraFovPolicy policy = new CameraFovPolicy();
        policy.apply(118, 0, () -> false, () -> {});
        assertThrows(IllegalStateException.class,
                () -> policy.apply(90, 1, () -> false, () -> { throw new IllegalStateException(); }));
        assertEquals(CameraFovPolicy.Result.BUSY,
                policy.apply(118, 0, () -> true, () -> fail("must not touch active camera")));
        assertEquals(CameraFovPolicy.Result.CHANGED,
                policy.apply(118, 0, () -> false, () -> {}));
    }
}

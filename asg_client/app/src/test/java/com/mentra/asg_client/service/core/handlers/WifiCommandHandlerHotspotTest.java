package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class WifiCommandHandlerHotspotTest {

    @Test
    public void appliesMatchingRequestWhileHotspotIsTransitioning() {
        assertThat(WifiCommandHandler.shouldApplyHotspotState(true, true, true)).isTrue();
        assertThat(WifiCommandHandler.shouldApplyHotspotState(false, false, true)).isTrue();
    }

    @Test
    public void immediatelyReportsOnlyStableMatchingState() {
        assertThat(WifiCommandHandler.shouldApplyHotspotState(true, true, false)).isFalse();
        assertThat(WifiCommandHandler.shouldApplyHotspotState(false, false, false)).isFalse();
    }

    @Test
    public void appliesDifferentRequestedState() {
        assertThat(WifiCommandHandler.shouldApplyHotspotState(true, false, false)).isTrue();
        assertThat(WifiCommandHandler.shouldApplyHotspotState(false, true, false)).isTrue();
    }

    @Test
    public void reportsDisabledWhenCancellingAnInProgressStart() {
        assertThat(WifiCommandHandler.shouldReportCancelledHotspotStart(false, false, true))
                .isTrue();
        assertThat(WifiCommandHandler.shouldReportCancelledHotspotStart(true, false, true))
                .isFalse();
        assertThat(WifiCommandHandler.shouldReportCancelledHotspotStart(false, false, false))
                .isFalse();
    }
}

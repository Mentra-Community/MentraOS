package com.mentra.asg_client.camera.diagnostics;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraDiagnosticsLogTest {

    @Before
    public void clearLogs() {
        ShadowLog.clear();
    }

    @Test
    public void manualExposureDecision_preservesJsonShape() {
        CameraDiagnosticsLog.manualExposureDecision(true, "manual path engaged", 5_000_000L, true);
        assertThat(ShadowLog.getLogsForTag("MentraDbg")).isNotEmpty();
        String msg = ShadowLog.getLogsForTag("MentraDbg").get(0).msg;
        assertThat(msg).contains("\"sessionId\":\"d2b1f4\"");
        assertThat(msg).contains("\"hypothesisId\":\"H0\"");
        assertThat(msg).contains("CameraNeo:shouldUseManualExposure");
        assertThat(msg).contains("\"decision\":true");
    }

    @Test
    public void stillRequestKeysBeforeCapture_preservesHypothesisIds() {
        CameraDiagnosticsLog.stillRequestKeysBeforeCapture(
                false, 1L, 400, 2L, 1, 2, 3, 4, false, false, 0, null);
        String msg = ShadowLog.getLogsForTag("MentraDbg").get(0).msg;
        assertThat(msg).contains("H1+H2+H3+H4");
        assertThat(msg).contains("CameraNeo:capturePhoto:beforeCapture");
    }
}

package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class OtaUpdatePlannerTest {
    @Test
    public void asgIsAlwaysFinalAfterMtkAndBes() {
        assertEquals(
                Arrays.asList("mtk", "bes", "apk"),
                OtaUpdatePlanner.plan(true, true, true));
        assertEquals(Arrays.asList("mtk", "apk"), OtaUpdatePlanner.plan(true, false, true));
        assertEquals(Arrays.asList("bes", "apk"), OtaUpdatePlanner.plan(false, true, true));
        assertEquals(Collections.singletonList("apk"), OtaUpdatePlanner.plan(false, false, true));
    }

    @Test
    public void advancesAnActiveApkStepThatAlreadyMatchesExactly() {
        assertTrue(OtaUpdatePlanner.shouldAdvanceSatisfiedApkStep("apk", true, false));
        assertFalse(OtaUpdatePlanner.shouldAdvanceSatisfiedApkStep("apk", false, false));
        assertFalse(OtaUpdatePlanner.shouldAdvanceSatisfiedApkStep("apk", true, true));
        assertFalse(OtaUpdatePlanner.shouldAdvanceSatisfiedApkStep("mtk", true, false));
    }
}

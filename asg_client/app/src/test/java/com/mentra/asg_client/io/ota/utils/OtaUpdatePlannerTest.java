package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertEquals;

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
}

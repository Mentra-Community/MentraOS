package com.mentra.asg_client.io.ota.utils;

import java.util.ArrayList;
import java.util.List;

/** Builds the durable OTA step order, keeping package replacement last. */
public final class OtaUpdatePlanner {
    private OtaUpdatePlanner() {}

    public static List<String> plan(boolean mtkNeeded, boolean besNeeded, boolean asgNeeded) {
        List<String> steps = new ArrayList<>();
        if (mtkNeeded) steps.add("mtk");
        if (besNeeded) steps.add("bes");
        if (asgNeeded) steps.add("apk");
        return steps;
    }

    /** True when recovery already converged the active final APK step to its exact target. */
    public static boolean shouldAdvanceSatisfiedApkStep(
            String activeStep, boolean targetMatched, boolean installDispatched) {
        return "apk".equals(activeStep) && targetMatched && !installDispatched;
    }
}

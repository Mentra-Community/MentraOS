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
}

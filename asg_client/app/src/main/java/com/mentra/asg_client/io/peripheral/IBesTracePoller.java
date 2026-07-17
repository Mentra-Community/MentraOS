package com.mentra.asg_client.io.peripheral;

import android.content.Context;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;

/** Controls the periodic BES trace-ring-buffer poll loop. */
public interface IBesTracePoller {
    void start(
            IMcuCommander mcuCommander,
            Context context,
            IConfigurationManager configManager,
            long intervalMs);

    void stop();
}

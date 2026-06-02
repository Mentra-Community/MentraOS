package com.mentra.asg_client.service.system.core;

import android.content.Context;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import com.mentra.asg_client.service.system.managers.MentraLiveSystemController;
import com.mentra.asg_client.service.system.managers.NoOpSystemController;
import com.mentra.asg_client.service.utils.DeviceProfile;

public final class SystemControllerFactory {

    private static final NoOpSystemController NO_OP = new NoOpSystemController();

    // Reuse a single privileged controller instead of re-allocating one per call; this factory is
    // hit on hot paths such as video start/stop. Device type is fixed for the process lifetime.
    private static volatile MentraLiveSystemController mentraLive;

    private SystemControllerFactory() {}

    public static ISystemController get(Context context) {
        if (!DeviceProfile.detect(context).isK900()) {
            return NO_OP;
        }
        MentraLiveSystemController local = mentraLive;
        if (local == null) {
            synchronized (SystemControllerFactory.class) {
                local = mentraLive;
                if (local == null) {
                    local = new MentraLiveSystemController(context.getApplicationContext());
                    mentraLive = local;
                }
            }
        }
        return local;
    }
}

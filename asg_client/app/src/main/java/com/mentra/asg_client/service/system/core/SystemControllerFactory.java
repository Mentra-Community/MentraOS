package com.mentra.asg_client.service.system.core;

import android.content.Context;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import com.mentra.asg_client.service.system.managers.MentraLiveSystemController;
import com.mentra.asg_client.service.system.managers.NoOpSystemController;
import com.mentra.asg_client.service.utils.DeviceProfile;

public final class SystemControllerFactory {

    private static final NoOpSystemController NO_OP = new NoOpSystemController();

    private SystemControllerFactory() {}

    public static ISystemController get(Context context) {
        if (DeviceProfile.detect(context).isK900()) {
            return new MentraLiveSystemController(context.getApplicationContext());
        }
        return NO_OP;
    }
}

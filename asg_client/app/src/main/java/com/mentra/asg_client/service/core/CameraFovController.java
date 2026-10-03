package com.mentra.asg_client.service.core;

import android.content.Context;
import com.dev.api.DevApi;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.camera.UvcStreamingState;
import com.mentra.asg_client.camera.policy.CameraFovPolicy;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import java.util.function.BooleanSupplier;

/** Process-wide applied crop shared by startup, user settings, and temporary leases. */
public final class CameraFovController {
    private static final CameraFovPolicy sPolicy = new CameraFovPolicy();
    private CameraFovController() {}

    /** Call on the main lifecycle thread, serialized with capture start commands. */
    public static CameraFovPolicy.Result apply(
            Context context, int fov, int roi, BooleanSupplier streamBusy) {
        return CameraNeoService.applyFovWhenIdle(sPolicy, fov, roi,
                () -> streamBusy.getAsBoolean()
                        || RtmpStreamingService.isStreaming() || RtmpStreamingService.isStarting()
                        || RtmpStreamingService.isReconnecting()
                        || SrtStreamingService.isStreaming() || SrtStreamingService.isStarting()
                        || SrtStreamingService.isReconnecting()
                        || WhipStreamingService.isStreaming() || WhipStreamingService.isStarting()
                        || WhipStreamingService.isReconnecting()
                        || UvcStreamingState.isStreaming(),
                () -> {
                    DevApi.setCameraFov(fov, roi);
                    SystemControllerFactory.get(context).restartCameraHal();
                    CameraRestartCooldown.setCooldown();
                });
    }
}

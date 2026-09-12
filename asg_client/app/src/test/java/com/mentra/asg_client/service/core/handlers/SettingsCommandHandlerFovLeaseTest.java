package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.never;

import android.content.Context;
import com.dev.api.DevApi;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import com.mentra.asg_client.settings.AsgSettings;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Regression coverage for camera FOV lease teardown when ASG services are unavailable. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class SettingsCommandHandlerFovLeaseTest {

    private AsgClientServiceManager serviceManager;
    private ICommunicationManager communicationManager;
    private SettingsCommandHandler handler;
    private final List<JSONObject> responses = new ArrayList<>();

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        communicationManager = mock(ICommunicationManager.class);
        when(communicationManager.sendBluetoothResponse(org.mockito.ArgumentMatchers.any()))
                .thenAnswer(
                        invocation -> {
                            responses.add(invocation.getArgument(0));
                            return true;
                        });
        handler =
                new SettingsCommandHandler(
                        serviceManager, communicationManager, mock(IResponseBuilder.class));
    }

    @Test
    public void reconnectSyncIsIdempotentAndBusyChangesPreservePreferencesAndLease() throws Exception {
        Context context = mock(Context.class);
        ISystemController systemController = mock(ISystemController.class);
        AsgSettings settings = mock(AsgSettings.class);
        when(serviceManager.getContext()).thenReturn(context);
        when(serviceManager.getAsgSettings()).thenReturn(settings);
        when(settings.getCameraFov()).thenReturn(118);
        when(settings.getCameraRoiPosition()).thenReturn(0);
        AtomicBoolean busy = new AtomicBoolean(false);
        handler = new SettingsCommandHandler(serviceManager, communicationManager,
                mock(IResponseBuilder.class), busy::get);
        JSONObject sync = new JSONObject().put("request_id", "sync")
                .put("params", new JSONObject().put("fov", 118).put("roi_position", 0));
        try (MockedStatic<DevApi> hardware = mockStatic(DevApi.class);
                MockedStatic<SystemControllerFactory> controllers = mockStatic(SystemControllerFactory.class)) {
            controllers.when(() -> SystemControllerFactory.get(context)).thenReturn(systemController);
            assertThat(handler.handleCommand("camera_fov_setting", sync)).isTrue();
            busy.set(true);
            assertThat(handler.handleCommand("camera_fov_setting", sync)).isTrue();
            verify(systemController, times(1)).restartCameraHal();
            hardware.verify(() -> DevApi.setCameraFov(118, 0), times(1));

            JSONObject changed = new JSONObject().put("request_id", "changed")
                    .put("params", new JSONObject().put("fov", 90).put("roi_position", 1));
            assertThat(handler.handleCommand("camera_fov_setting", changed)).isFalse();
            verify(settings, never()).setCameraFov(90, 1);
            assertThat(responses.get(responses.size() - 1).getString("error_code")).isEqualTo("camera_busy");
            assertThat(handler.handleCommand("camera_fov_override", overrideRequest("lease-1"))).isFalse();

            busy.set(false);
            assertThat(handler.handleCommand("camera_fov_override", overrideRequest("lease-1"))).isTrue();
            busy.set(true);
            assertThat(handler.handleCommand("camera_fov_override_release", releaseRequest("lease-1"))).isFalse();
            verify(systemController, times(2)).restartCameraHal();
            busy.set(false);
            assertThat(handler.handleCommand("camera_fov_override_release", releaseRequest("lease-1"))).isTrue();
            verify(systemController, times(3)).restartCameraHal();
        }
    }

    @Test
    public void releaseRetainsLeaseWhenContextIsUnavailable() throws Exception {
        Context context = mock(Context.class);
        ISystemController systemController = mock(ISystemController.class);
        AsgSettings settings = mock(AsgSettings.class);
        when(serviceManager.getContext()).thenReturn(context);
        when(serviceManager.getAsgSettings()).thenReturn(settings);
        when(settings.getCameraFov()).thenReturn(102);
        when(settings.getCameraRoiPosition()).thenReturn(1);

        try (MockedStatic<DevApi> ignored = mockStatic(DevApi.class);
                MockedStatic<SystemControllerFactory> systemControllers =
                        mockStatic(SystemControllerFactory.class)) {
            systemControllers
                    .when(() -> SystemControllerFactory.get(context))
                    .thenReturn(systemController);

            assertThat(handler.handleCommand("camera_fov_override", overrideRequest("lease-1")))
                    .isTrue();

            when(serviceManager.getContext()).thenReturn(null);
            assertThat(
                            handler.handleCommand(
                                    "camera_fov_override_release", releaseRequest("lease-1")))
                    .isFalse();
            assertThat(
                            handler.handleCommand(
                                    "camera_fov_override_release", releaseRequest("lease-1")))
                    .isFalse();
        }

        JSONObject lastResponse = responses.get(responses.size() - 1);
        assertThat(lastResponse.getString("status")).isEqualTo("error");
        assertThat(lastResponse.getString("error_code")).isEqualTo("camera_unavailable");
        assertThat(lastResponse.optBoolean("stale", false)).isFalse();
    }

    private static JSONObject overrideRequest(String leaseId) throws Exception {
        return new JSONObject()
                .put("request_id", "set-1")
                .put(
                        "params",
                        new JSONObject()
                                .put("lease_id", leaseId)
                                .put("fov", 82)
                                .put("roi_position", 1)
                                .put("ttl_ms", 300_000));
    }

    private static JSONObject releaseRequest(String leaseId) throws Exception {
        return new JSONObject()
                .put("request_id", "release-1")
                .put("params", new JSONObject().put("lease_id", leaseId));
    }
}

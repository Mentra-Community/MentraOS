package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.utils.ServiceConstants;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;
import org.robolectric.shadows.ShadowLog;

/** Verifies set_system_time routing through ISystemController on Mentra Live. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class PowerCommandHandlerTest {

    @Test
    public void disableUnwornPowerOff_rejectsInvalidIdsWithoutAccessingTransport()
            throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        AsgClientServiceManager manager = mock(AsgClientServiceManager.class);
        PowerCommandHandler handler = new PowerCommandHandler(app, manager);
        for (Object id : List.of("short", "has space-1234", "quote'1234", 12345678)) {
            assertThat(
                            handler.handleCommand(
                                    AsgConstants.COMMAND_DISABLE_UNWORN_AUTO_POWER_OFF,
                                    new JSONObject().put("request_id", id)))
                    .isFalse();
        }
        verify(manager, org.mockito.Mockito.never()).getBluetoothManager();
    }

    @Test
    public void disableUnwornPowerOff_nonK900TransportReportsCorrelatedFailure() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        AsgClientServiceManager manager = mock(AsgClientServiceManager.class);
        when(manager.getBluetoothManager()).thenReturn(mock(ICompanionTransport.class));
        PowerCommandHandler handler = new PowerCommandHandler(app, manager);
        ShadowLog.clear();
        assertThat(
                        handler.handleCommand(
                                AsgConstants.COMMAND_DISABLE_UNWORN_AUTO_POWER_OFF,
                                new JSONObject().put("request_id", "setup-power-1234")))
                .isTrue();
        String message =
                ShadowLog.getLogsForTag("PowerCommandHandler").stream()
                        .map(row -> row.msg)
                        .filter(row -> row.startsWith("UNWORN_AUTO_POWER_OFF_RESULT "))
                        .findFirst()
                        .orElseThrow();
        JSONObject result =
                new JSONObject(message.substring("UNWORN_AUTO_POWER_OFF_RESULT ".length()));
        assertThat(result.getString("request_id")).isEqualTo("setup-power-1234");
        assertThat(result.getString("type")).isEqualTo("unworn_auto_power_off_result");
        assertThat(result.getBoolean("success")).isFalse();
        assertThat(result.getString("status")).isEqualTo("transport_unavailable");
        assertThat(result.getInt("result_code")).isEqualTo(-1);
        assertThat(result.getString("process_sid")).isNotEmpty();
        assertThat(result.getLong("elapsed_realtime_ms")).isNotNegative();
    }

    @Test
    public void disableUnwornPowerOff_routesOnlyTheFixedCommand() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        AsgClientServiceManager manager = mock(AsgClientServiceManager.class);
        K900BluetoothManager transport = mock(K900BluetoothManager.class);
        when(manager.getBluetoothManager()).thenReturn(transport);
        PowerCommandHandler handler = new PowerCommandHandler(app, manager);
        ShadowLog.clear();
        assertThat(
                        handler.handleCommand(
                                AsgConstants.COMMAND_DISABLE_UNWORN_AUTO_POWER_OFF,
                                new JSONObject().put("request_id", "setup-power-1234")))
                .isTrue();
        verify(transport).disableUnwornAutoPowerOff(any());
        assertThat(ShadowLog.getLogsForTag("PowerCommandHandler"))
                .noneMatch(row -> row.msg.startsWith("UNWORN_AUTO_POWER_OFF_RESULT "));
    }

    @Test
    public void besRebootForMtkFlash_queuesExactUartCommand() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        ICompanionTransport transport = mock(ICompanionTransport.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        when(transport.sendMessage(any(byte[].class), any())).thenReturn(true);
        PowerCommandHandler handler = new PowerCommandHandler(app, serviceManager);

        boolean handled =
                handler.handleCommand(
                        AsgConstants.COMMAND_REBOOT_BES_FOR_MTK_FLASH,
                        new JSONObject().put(AsgConstants.MTK_FLASH_REQUEST_ID_FIELD, "abc12345"));

        assertThat(handled).isTrue();
        verify(transport)
                .sendMessage(
                        eq(besCommand().toString().getBytes(StandardCharsets.UTF_8)), any());
    }

    @Test
    public void besRebootForMtkFlash_rejectsMissingRequestId() {
        Application app = ApplicationProvider.getApplicationContext();
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        PowerCommandHandler handler = new PowerCommandHandler(app, serviceManager);

        boolean handled =
                handler.handleCommand(
                        AsgConstants.COMMAND_REBOOT_BES_FOR_MTK_FLASH, new JSONObject());

        assertThat(handled).isFalse();
        verify(serviceManager, org.mockito.Mockito.never()).getBluetoothManager();
    }

    @Test
    public void setSystemTime_validTimestamp_routesToSystemController() throws Exception {
        ShadowBuild.setModel("MentraLive");
        Application app = ApplicationProvider.getApplicationContext();
        PowerCommandHandler handler = new PowerCommandHandler(app, null);

        JSONObject data = new JSONObject().put("timestamp_ms", 1_700_000_000_000L);
        boolean handled = handler.handleCommand(ServiceConstants.COMMAND_SET_SYSTEM_TIME, data);

        assertThat(handled).isTrue();
        List<Intent> intents = shadowOf(app).getBroadcastIntents();
        assertThat(intents).isNotEmpty();
        Intent last = intents.get(intents.size() - 1);
        assertThat(last.getStringExtra("cmd")).isEqualTo("settime");
        assertThat(last.getLongExtra("timemills", -1L)).isEqualTo(1_700_000_000_000L);
    }

    @Test
    public void setSystemTime_missingTimestamp_returnsFalse() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        PowerCommandHandler handler = new PowerCommandHandler(app, null);

        boolean handled =
                handler.handleCommand(ServiceConstants.COMMAND_SET_SYSTEM_TIME, new JSONObject());

        assertThat(handled).isFalse();
    }

    @Test
    public void setSystemTime_nullData_returnsFalse() {
        Application app = ApplicationProvider.getApplicationContext();
        PowerCommandHandler handler = new PowerCommandHandler(app, null);

        assertThat(handler.handleCommand(ServiceConstants.COMMAND_SET_SYSTEM_TIME, null)).isFalse();
    }

    private static JSONObject besCommand() throws JSONException {
        return new JSONObject().put("C", "cs_rebt").put("V", 1).put("B", "");
    }
}

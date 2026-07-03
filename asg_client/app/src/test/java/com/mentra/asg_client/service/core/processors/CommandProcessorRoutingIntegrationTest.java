package com.mentra.asg_client.service.core.processors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900ProtocolStrategy;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.core.handlers.OtaCommandHandler;
import com.mentra.asg_client.service.core.handlers.RgbLedCommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * End-to-end JVM integration test for the protocol-strategy injection seam: raw bytes through a
 * REAL {@link CommandProcessor}, {@code CommandParser}, {@link CommandProtocolDetector} (with the
 * vendor strategy injected at runtime), {@code K900CommandHandler}, {@code McuEventParser} and out
 * to the peripheral bus / transport interface. This is the path the A6 module split will cut
 * across modules.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CommandProcessorRoutingIntegrationTest {

    private AsgClientServiceManager serviceManager;
    private ICompanionTransport transport;
    private IPeripheralBus peripheralBus;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        peripheralBus = mock(IPeripheralBus.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
    }

    private CommandProcessor newProcessor(
            Set<CommandProtocolDetector.ProtocolDetectionStrategy> strategies) {
        Context context = ApplicationProvider.getApplicationContext();
        return new CommandProcessor(
                context,
                mock(ICommunicationManager.class),
                mock(IStateManager.class),
                mock(IMediaManager.class),
                mock(IResponseBuilder.class),
                mock(IConfigurationManager.class),
                serviceManager,
                mock(FileManager.class),
                mock(RgbLedCommandHandler.class),
                mock(OtaCommandHandler.class),
                peripheralBus,
                strategies);
    }

    private static byte[] bytes(JSONObject json) {
        return json.toString().getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void mcuFrame_withInjectedK900Strategy_publishesTypedEventOnBus() throws Exception {
        CommandProcessor processor = newProcessor(Set.of(new K900ProtocolStrategy()));
        JSONObject mcuFrame =
                new JSONObject()
                        .put("C", "cs_flts")
                        .put("B", new JSONObject().put("state", 1).put("index", 7));

        processor.processCommand(bytes(mcuFrame));

        ArgumentCaptor<McuEvent> captor = ArgumentCaptor.forClass(McuEvent.class);
        verify(peripheralBus).publish(captor.capture());
        assertThat(captor.getValue()).isInstanceOf(FileTransferAckEvent.class);
        FileTransferAckEvent ack = (FileTransferAckEvent) captor.getValue();
        assertThat(ack.getState()).isEqualTo(1);
        assertThat(ack.getIndex()).isEqualTo(7);
    }

    @Test
    public void mcuFrame_withoutVendorStrategies_isDroppedWithoutException() throws Exception {
        CommandProcessor processor = newProcessor(Collections.emptySet());
        JSONObject mcuFrame =
                new JSONObject()
                        .put("C", "cs_flts")
                        .put("B", new JSONObject().put("state", 1).put("index", 7));

        assertThatCode(() -> processor.processCommand(bytes(mcuFrame)))
                .doesNotThrowAnyException();

        verify(peripheralBus, never()).publish(any());
    }

    @Test
    public void setBleMtu_jsonCommand_reachesTransportThroughInterface() throws Exception {
        CommandProcessor processor = newProcessor(Set.of(new K900ProtocolStrategy()));
        JSONObject command = new JSONObject().put("type", "set_ble_mtu").put("mtu", 251);

        processor.processCommand(bytes(command));

        // Bytes -> parser -> detector -> registry -> BleConfigCommandHandler -> transport hook.
        verify(transport).onMtuNegotiated(251);
    }

    @Test
    public void setBleMtu_stillRoutes_whenNoVendorStrategiesRegistered() throws Exception {
        CommandProcessor processor = newProcessor(Collections.emptySet());
        JSONObject command = new JSONObject().put("type", "set_ble_mtu").put("mtu", 185);

        processor.processCommand(bytes(command));

        verify(transport).onMtuNegotiated(185);
    }

    @Test
    public void transferComplete_jsonCommand_reachesTransportWithoutVendorCast() throws Exception {
        // The transport is a plain ICompanionTransport mock — the old code would have thrown
        // ClassCastException casting it to K900BluetoothManager.
        CommandProcessor processor = newProcessor(Set.of(new K900ProtocolStrategy()));
        JSONObject command =
                new JSONObject()
                        .put("type", "transfer_complete")
                        .put("fileName", "photo.jpg")
                        .put("success", true);

        processor.processCommand(bytes(command));

        verify(transport).onFileTransferConfirmation("photo.jpg", true);
    }
}

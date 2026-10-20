package com.mentra.asg_client.service.core.processors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900ProtocolStrategy;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.core.handlers.OtaCommandHandler;
import com.mentra.asg_client.service.core.handlers.RgbLedCommandHandler;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Proves the exported, unprotected {@code IntentCommandReceiver} path ({@link
 * CommandProcessor#processJsonCommand}) cannot be used to push raw {@code mh_*} JSON to BES.
 * Only {@code BesButtonInjectReceiver} (guarded by {@code android.permission.DUMP}) may send
 * {@code mh_dbgkey}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class NoRawBesForwardingTest {

    private static final String MARKER = "RAW_FORWARD_MARKER";

    private ICompanionTransport transport;
    private CommandProcessor processor;

    @Before
    public void setUp() {
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        when(transport.isConnected()).thenReturn(true);
        when(transport.sendMessage(any(byte[].class))).thenReturn(true);
        Context context = ApplicationProvider.getApplicationContext();
        processor =
                new CommandProcessor(
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
                        mock(IPeripheralBus.class),
                        Set.of(new K900ProtocolStrategy()));
    }

    private List<String> sentToTransport() {
        ArgumentCaptor<byte[]> captor = ArgumentCaptor.forClass(byte[].class);
        try {
            verify(transport, atLeast(0)).sendMessage(captor.capture());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        List<String> out = new ArrayList<>();
        for (byte[] bytes : captor.getAllValues()) {
            out.add(new String(bytes, StandardCharsets.UTF_8));
        }
        return out;
    }

    private void assertNothingForwarded() {
        for (String sent : sentToTransport()) {
            assertThat(sent).doesNotContain(MARKER).doesNotContain("mh_dbgkey");
        }
    }

    @Test
    public void noRegisteredJsonCommandTypeIsAnMhCommand() throws Exception {
        Field registryField = CommandProcessor.class.getDeclaredField("commandHandlerRegistry");
        registryField.setAccessible(true);
        CommandHandlerRegistry registry = (CommandHandlerRegistry) registryField.get(processor);
        Field handlersField = CommandHandlerRegistry.class.getDeclaredField("handlers");
        handlersField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, ICommandHandler> handlers =
                (Map<String, ICommandHandler>) handlersField.get(registry);

        assertThat(handlers).isNotEmpty();
        for (String type : handlers.keySet()) {
            assertThat(type.toLowerCase()).as("command type %s", type).doesNotStartWith("mh_");
        }
    }

    @Test
    public void k900StyleMhJson_isNotForwardedToBes() throws Exception {
        for (String command : new String[] {"mh_dbgkey", "mh_ota", "mh_batv", "mh_logs"}) {
            JSONObject json =
                    new JSONObject()
                            .put("C", command)
                            .put("V", 1)
                            .put(
                                    "B",
                                    new JSONObject()
                                            .put("key", "pwr")
                                            .put("gesture", "triple")
                                            .put("marker", MARKER));
            processor.processJsonCommand(json);
            processor.processCommand(json.toString().getBytes(StandardCharsets.UTF_8));
        }
        assertNothingForwarded();
    }

    @Test
    public void typedJsonWithMhNames_isNotForwardedToBes() throws Exception {
        for (String type :
                new String[] {
                    "mh_dbgkey", "send_to_bes", "bes_passthrough", "uart_send", "raw_uart", "k900"
                }) {
            JSONObject json =
                    new JSONObject()
                            .put("type", type)
                            .put("C", "mh_dbgkey")
                            .put("B", new JSONObject().put("key", "pwr").put("marker", MARKER))
                            .put("json", "{\"C\":\"mh_dbgkey\",\"marker\":\"" + MARKER + "\"}")
                            .put("data", MARKER);
            processor.processJsonCommand(json);
        }
        assertNothingForwarded();
    }
}

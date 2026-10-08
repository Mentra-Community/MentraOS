package com.mentra.asg_client.io.bluetooth.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialSession;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.UnwornAutoPowerOffRequest;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/** Validates production JSON framing and receipt parsing without serial hardware. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class K900UnwornAutoPowerOffTest {
    @Test
    public void fixedCommandUsesLegacyStringBodyWithNoWakeOrArbitraryFields() throws Exception {
        Method command = K900BluetoothManager.class.getDeclaredMethod("unwornAutoPowerOffCommand");
        command.setAccessible(true);
        JSONObject json =
                new JSONObject(new String((byte[]) command.invoke(null), StandardCharsets.UTF_8));
        assertThat(json.length()).isEqualTo(3);
        assertThat(json.getString("C")).isEqualTo("cs_swit");
        assertThat(json.getInt("V")).isEqualTo(1);
        assertThat(json.get("B")).isInstanceOf(String.class);
        JSONObject body = new JSONObject(json.getString("B"));
        assertThat(body.length()).isEqualTo(2);
        assertThat(body.getInt("type")).isEqualTo(11);
        assertThat(body.getInt("switch")).isZero();
    }

    @Test
    public void receiptRequiresExplicitIntegralFields_andRunsOnlyForCurrentSession()
            throws Exception {
        K900BluetoothManager manager = mock(K900BluetoothManager.class, CALLS_REAL_METHODS);
        BesUartTransportCoordinator coordinator = mock(BesUartTransportCoordinator.class);
        UnwornAutoPowerOffRequest request = mock(UnwornAutoPowerOffRequest.class);
        field(manager, "transportCoordinator", coordinator);
        field(manager, "mUnwornAutoPowerOffRequest", request);
        SerialSession current = mock(SerialSession.class);
        SerialSession retired = mock(SerialSession.class);
        when(coordinator.runForCurrentSerialSession(eq(current), any()))
                .thenAnswer(
                        call -> {
                            ((Runnable) call.getArgument(1)).run();
                            return true;
                        });
        Method receipt =
                K900BluetoothManager.class.getDeclaredMethod(
                        "handleUnwornAutoPowerOffReply", byte[].class, SerialSession.class);
        receipt.setAccessible(true);
        for (String invalid :
                new String[] {
                    "{\"C\":\"sr_swit\",\"B\":{\"type\":11,\"switch\":0}}",
                    "{\"C\":\"sr_swit\",\"S\":\"0\",\"B\":{\"type\":11,\"switch\":0}}",
                    "{\"C\":\"sr_swit\",\"S\":0.5,\"B\":{\"type\":11,\"switch\":0}}",
                    "{\"C\":\"sr_swit\",\"S\":0,\"B\":{\"type\":11}}",
                    "{\"C\":\"sr_swit\",\"S\":0,\"B\":{\"type\":11.5,\"switch\":0}}"
                }) {
            assertThat(receipt.invoke(manager, invalid.getBytes(StandardCharsets.UTF_8), current))
                    .isEqualTo(false);
        }
        String valid = "{\"C\":\"sr_swit\",\"S\":0,\"B\":{\"type\":11,\"switch\":0}}";
        receipt.invoke(manager, valid.getBytes(StandardCharsets.UTF_8), retired);
        org.mockito.Mockito.verifyNoInteractions(request);
        receipt.invoke(manager, valid.getBytes(StandardCharsets.UTF_8), current);
        verify(request).reply(current, 0, 11, 0);
    }

    private static void field(Object target, String name, Object value) throws Exception {
        Field field = K900BluetoothManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}

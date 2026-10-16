package com.mentra.asg_client.receiver;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Gesture whitelist and UART payload for {@link BesButtonInjectReceiver}. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesButtonInjectReceiverTest {

    private final List<String> sent = new ArrayList<>();

    private boolean handle(String action, String gesture) {
        return BesButtonInjectReceiver.handle(
                action,
                gesture,
                json -> {
                    sent.add(json);
                    return true;
                });
    }

    @Test
    public void actionAndExtraNamesAreFrozen() {
        assertThat(BesButtonInjectReceiver.ACTION_BES_BUTTON).isEqualTo("com.mentra.BES_BUTTON");
        assertThat(BesButtonInjectReceiver.EXTRA_GESTURE).isEqualTo("gesture");
    }

    @Test
    public void validGestures_forwardMhDbgkeyPwrPayload() throws Exception {
        for (String gesture : new String[] {"single", "double", "triple", "long"}) {
            sent.clear();

            assertThat(handle("com.mentra.BES_BUTTON", gesture)).as(gesture).isTrue();

            assertThat(sent).hasSize(1);
            JSONObject payload = new JSONObject(sent.get(0));
            assertThat(payload.getString("C")).isEqualTo("mh_dbgkey");
            JSONObject body = new JSONObject(payload.getString("B"));
            assertThat(body.getString("key")).isEqualTo("pwr");
            assertThat(body.getString("gesture")).isEqualTo(gesture);
            assertThat(body.length()).isEqualTo(2);
        }
    }

    @Test
    public void gestureIsNormalisedToLowerCase() throws Exception {
        assertThat(handle("com.mentra.BES_BUTTON", "Triple")).isTrue();
        assertThat(new JSONObject(new JSONObject(sent.get(0)).getString("B")).getString("gesture"))
                .isEqualTo("triple");
    }

    @Test
    public void unknownOrMissingGesture_isRejectedAndNothingIsSent() {
        for (String gesture :
                new String[] {
                    null, "", "  ", " triple", "quad", "triple,long", "triple\n", "pwr", "D.U.D.U", "fn2"
                }) {
            assertThat(handle("com.mentra.BES_BUTTON", gesture)).as("gesture=%s", gesture).isFalse();
        }
        assertThat(sent).isEmpty();
    }

    @Test
    public void wrongAction_isRejectedAndNothingIsSent() {
        assertThat(handle("com.mentra.DEBUG_BES_KEY", "triple")).isFalse();
        assertThat(handle(null, "triple")).isFalse();
        assertThat(sent).isEmpty();
    }

    @Test
    public void senderFailure_isReportedAsNotSent() {
        assertThat(
                        BesButtonInjectReceiver.handle(
                                "com.mentra.BES_BUTTON", "single", json -> false))
                .isFalse();
        assertThat(BesButtonInjectReceiver.handle("com.mentra.BES_BUTTON", "single", null))
                .isFalse();
    }

    @Test
    public void buildPayload_isExactJson() throws Exception {
        JSONObject expected =
                new JSONObject()
                        .put("C", "mh_dbgkey")
                        .put("V", 1)
                        .put("B", new JSONObject().put("key", "pwr").put("gesture", "long").toString());
        assertThat(new JSONObject(BesButtonInjectReceiver.buildPayload("long")).toString())
                .isEqualTo(expected.toString());
        assertThat(BesButtonInjectReceiver.buildPayload("nope")).isNull();
    }
}

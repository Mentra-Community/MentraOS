package com.mentra.asg_client.io.peripheral;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.peripheral.events.BatteryEvent;
import com.mentra.asg_client.io.peripheral.events.BesOtaAuthEvent;
import com.mentra.asg_client.io.peripheral.events.BesVersionEvent;
import com.mentra.asg_client.io.peripheral.events.BtMacEvent;
import com.mentra.asg_client.io.peripheral.events.ButtonEvent;
import com.mentra.asg_client.io.peripheral.events.FactoryResetEvent;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.io.peripheral.events.HotspotTriggerEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.io.peripheral.events.SpeakPairingCodeEvent;
import com.mentra.asg_client.io.peripheral.events.SwipeVolumeEvent;
import com.mentra.asg_client.io.peripheral.events.SwitchEvent;
import com.mentra.asg_client.io.peripheral.events.TouchEvent;
import com.mentra.asg_client.io.peripheral.events.VoiceActivityEvent;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies every BES command string maps to the correct typed {@link McuEvent}. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class McuEventParserTest {

    private static JSONObject cmd(String command) throws JSONException {
        return new JSONObject().put("C", command);
    }

    private static JSONObject cmd(String command, JSONObject body) throws JSONException {
        return new JSONObject().put("C", command).put("B", body);
    }

    @Test
    public void csPho_mapsToCameraShortPress() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("cs_pho"));
        assertThat(event).isInstanceOf(ButtonEvent.class);
        assertThat(((ButtonEvent) event).getType())
                .isEqualTo(ButtonEvent.Type.CAMERA_SHORT_PRESS);
    }

    @Test
    public void csVdo_mapsToCameraLongPress() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("cs_vdo"));
        assertThat(event).isInstanceOf(ButtonEvent.class);
        assertThat(((ButtonEvent) event).getType()).isEqualTo(ButtonEvent.Type.CAMERA_LONG_PRESS);
    }

    @Test
    public void hsNtfy_buttonClick_mapsToCameraShortPress() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("hs_ntfy", new JSONObject().put("msg", "button click")));
        assertThat(event).isInstanceOf(ButtonEvent.class);
        assertThat(((ButtonEvent) event).getType())
                .isEqualTo(ButtonEvent.Type.CAMERA_SHORT_PRESS);
    }

    @Test
    public void hsNtfy_buttonLongClick_mapsToCameraLongPress() throws Exception {
        McuEvent event =
                McuEventParser.parse(
                        cmd("hs_ntfy", new JSONObject().put("msg", "button long click")));
        assertThat(event).isInstanceOf(ButtonEvent.class);
        assertThat(((ButtonEvent) event).getType()).isEqualTo(ButtonEvent.Type.CAMERA_LONG_PRESS);
    }

    @Test
    public void hsNtfy_unknownMessage_returnsNull() throws Exception {
        assertThat(McuEventParser.parse(cmd("hs_ntfy", new JSONObject().put("msg", "whatever"))))
                .isNull();
    }

    @Test
    public void csShut_mapsToShutdownEvent() throws Exception {
        assertThat(McuEventParser.parse(cmd("cs_shut"))).isInstanceOf(ShutdownEvent.class);
    }

    @Test
    public void csFcrst_mapsToFactoryResetEvent() throws Exception {
        assertThat(McuEventParser.parse(cmd("cs_fcrst"))).isInstanceOf(FactoryResetEvent.class);
    }

    @Test
    public void hmBatv_mapsToBatteryEvent() throws Exception {
        McuEvent event =
                McuEventParser.parse(cmd("hm_batv", new JSONObject().put("pt", 85).put("vt", 3900)));
        assertThat(event).isInstanceOf(BatteryEvent.class);
        BatteryEvent battery = (BatteryEvent) event;
        assertThat(battery.getPercentage()).isEqualTo(85);
        assertThat(battery.getVoltageMillivolts()).isEqualTo(3900);
    }

    @Test
    public void hmBatv_missingFields_defaultsToMinusOne() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("hm_batv", new JSONObject()));
        assertThat(event).isInstanceOf(BatteryEvent.class);
        BatteryEvent battery = (BatteryEvent) event;
        assertThat(battery.getPercentage()).isEqualTo(-1);
        assertThat(battery.getVoltageMillivolts()).isEqualTo(-1);
    }

    @Test
    public void hmSpkcode_mapsToSpeakPairingCodeEvent() throws Exception {
        McuEvent event =
                McuEventParser.parse(cmd("hm_spkcode", new JSONObject().put("code", "A1B2")));
        assertThat(event).isInstanceOf(SpeakPairingCodeEvent.class);
        assertThat(((SpeakPairingCodeEvent) event).getCode()).isEqualTo("A1B2");
    }

    @Test
    public void hmSpkcode_a12b_mapsEachCharToAPairingAsset() throws Exception {
        McuEvent event =
                McuEventParser.parse(cmd("hm_spkcode", new JSONObject().put("code", "A12B")));
        String code = ((SpeakPairingCodeEvent) event).getCode();
        assertThat(code).isEqualTo("A12B");
        assertThat(AudioAssets.getPairingCharAsset(code.charAt(0)))
                .isEqualTo("pairing/letter_a.wav");
        assertThat(AudioAssets.getPairingCharAsset(code.charAt(1)))
                .isEqualTo("pairing/digit_1.wav");
        assertThat(AudioAssets.getPairingCharAsset(code.charAt(2)))
                .isEqualTo("pairing/digit_2.wav");
        assertThat(AudioAssets.getPairingCharAsset(code.charAt(3)))
                .isEqualTo("pairing/letter_b.wav");
    }

    @Test
    public void hmSpkcode_preservesLowercaseForTheStitcher() throws Exception {
        McuEvent event =
                McuEventParser.parse(cmd("hm_spkcode", new JSONObject().put("code", "a12b")));
        assertThat(((SpeakPairingCodeEvent) event).getCode()).isEqualTo("a12b");
        assertThat(AudioAssets.getPairingCharAsset('a')).isEqualTo("pairing/letter_a.wav");
    }

    @Test
    public void hmSpkcode_emptyCode_returnsNull() throws Exception {
        assertThat(McuEventParser.parse(cmd("hm_spkcode", new JSONObject().put("code", "  "))))
                .isNull();
    }

    @Test
    public void srSwst_mapsToSwitchEvent() throws Exception {
        McuEvent event =
                McuEventParser.parse(cmd("sr_swst", new JSONObject().put("type", 2).put("switch", 1)));
        assertThat(event).isInstanceOf(SwitchEvent.class);
        SwitchEvent sw = (SwitchEvent) event;
        assertThat(sw.getType()).isEqualTo(2);
        assertThat(sw.getSwitchValue()).isEqualTo(1);
    }

    @Test
    public void srTpevt_mapsToTouchEvent() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("sr_tpevt", new JSONObject().put("type", 4)));
        assertThat(event).isInstanceOf(TouchEvent.class);
        assertThat(((TouchEvent) event).getGestureType()).isEqualTo(4);
    }

    @Test
    public void srFbvol_switchOne_mapsToEnabled() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("sr_fbvol", new JSONObject().put("switch", 1)));
        assertThat(event).isInstanceOf(SwipeVolumeEvent.class);
        assertThat(((SwipeVolumeEvent) event).isEnabled()).isTrue();
    }

    @Test
    public void srFbvol_switchZero_mapsToDisabled() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("sr_fbvol", new JSONObject().put("switch", 0)));
        assertThat(event).isInstanceOf(SwipeVolumeEvent.class);
        assertThat(((SwipeVolumeEvent) event).isEnabled()).isFalse();
    }

    @Test
    public void srKeyevt_powerShortPress_mapsToPowerShortPress() throws Exception {
        McuEvent event =
                McuEventParser.parse(
                        cmd("sr_keyevt", new JSONObject().put("button", 0).put("type", 0)));
        assertThat(event).isInstanceOf(ButtonEvent.class);
        assertThat(((ButtonEvent) event).getType()).isEqualTo(ButtonEvent.Type.POWER_SHORT_PRESS);
    }

    @Test
    public void srKeyevt_otherCombo_returnsNull() throws Exception {
        assertThat(
                        McuEventParser.parse(
                                cmd("sr_keyevt", new JSONObject().put("button", 1).put("type", 0))))
                .isNull();
    }

    @Test
    public void srBtaddr_withAddress_mapsToBtMacEvent() throws Exception {
        McuEvent event =
                McuEventParser.parse(
                        cmd("sr_btaddr", new JSONObject().put("btaddr", "AA:BB:CC:DD:EE:FF")));
        assertThat(event).isInstanceOf(BtMacEvent.class);
        assertThat(((BtMacEvent) event).getMacAddress()).isEqualTo("AA:BB:CC:DD:EE:FF");
    }

    @Test
    public void srBtaddr_emptyAddress_returnsNull() throws Exception {
        assertThat(McuEventParser.parse(cmd("sr_btaddr", new JSONObject().put("btaddr", ""))))
                .isNull();
    }

    @Test
    public void hsSyvr_mapsToVersionEvent() throws Exception {
        JSONObject body =
                new JSONObject()
                        .put("version", "17.26.1.14")
                        .put("ble", "MyBle")
                        .put("bt", "MyBt")
                        .put("btaddr", "AA:BB")
                        .put("bleaddr", "CC:DD");
        McuEvent event = McuEventParser.parse(cmd("hs_syvr", body));
        assertThat(event).isInstanceOf(BesVersionEvent.class);
        BesVersionEvent version = (BesVersionEvent) event;
        assertThat(version.getFirmwareVersion()).isEqualTo("17.26.1.14");
        assertThat(version.getBleName()).isEqualTo("MyBle");
        assertThat(version.getBtName()).isEqualTo("MyBt");
        assertThat(version.getBtAddress()).isEqualTo("AA:BB");
        assertThat(version.getBleAddress()).isEqualTo("CC:DD");
    }

    @Test
    public void hmOta_resultOne_mapsToAuthorized() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("hm_ota", new JSONObject().put("result", 1)));
        assertThat(event).isInstanceOf(BesOtaAuthEvent.class);
        assertThat(((BesOtaAuthEvent) event).isAuthorized()).isTrue();
    }

    @Test
    public void hmOta_resultZero_mapsToDenied() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("hm_ota", new JSONObject().put("result", 0)));
        assertThat(event).isInstanceOf(BesOtaAuthEvent.class);
        assertThat(((BesOtaAuthEvent) event).isAuthorized()).isFalse();
    }

    @Test
    public void hmHtsp_mapsToHotspotTrigger() throws Exception {
        assertThat(McuEventParser.parse(cmd("hm_htsp"))).isInstanceOf(HotspotTriggerEvent.class);
    }

    @Test
    public void mhHtsp_mapsToHotspotTrigger() throws Exception {
        assertThat(McuEventParser.parse(cmd("mh_htsp"))).isInstanceOf(HotspotTriggerEvent.class);
    }

    @Test
    public void csFlts_withStateAndIndex_mapsToFileTransferAck() throws Exception {
        McuEvent event =
                McuEventParser.parse(
                        cmd("cs_flts", new JSONObject().put("state", 1).put("index", 7)));
        assertThat(event).isInstanceOf(FileTransferAckEvent.class);
        FileTransferAckEvent ack = (FileTransferAckEvent) event;
        assertThat(ack.getState()).isEqualTo(1);
        assertThat(ack.getIndex()).isEqualTo(7);
    }

    @Test
    public void csFlts_missingFields_returnsNull() throws Exception {
        assertThat(McuEventParser.parse(cmd("cs_flts", new JSONObject().put("state", 1)))).isNull();
    }

    @Test
    public void srVad_onOne_mapsToActive() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("sr_vad", new JSONObject().put("on", 1)));
        assertThat(event).isInstanceOf(VoiceActivityEvent.class);
        assertThat(((VoiceActivityEvent) event).isActive()).isTrue();
    }

    @Test
    public void srVad_onZero_mapsToInactive() throws Exception {
        McuEvent event = McuEventParser.parse(cmd("sr_vad", new JSONObject().put("on", 0)));
        assertThat(event).isInstanceOf(VoiceActivityEvent.class);
        assertThat(((VoiceActivityEvent) event).isActive()).isFalse();
    }

    @Test
    public void mirroredCommands_returnNull() throws Exception {
        assertThat(McuEventParser.parse(cmd("android_control_led"))).isNull();
        assertThat(McuEventParser.parse(cmd("cs_swit"))).isNull();
        assertThat(McuEventParser.parse(cmd("cs_fbvol"))).isNull();
        assertThat(McuEventParser.parse(cmd("cs_batv"))).isNull();
        assertThat(McuEventParser.parse(cmd("sr_ledon"))).isNull();
    }

    @Test
    public void srLog_returnsNull_handledInline() throws Exception {
        // sr_log is consumed directly by K900CommandHandler, not through the parser/bus.
        assertThat(McuEventParser.parse(cmd("sr_log"))).isNull();
    }

    @Test
    public void unknownCommand_returnsNull() throws Exception {
        assertThat(McuEventParser.parse(cmd("totally_unknown"))).isNull();
    }

    @Test
    public void nullInput_returnsNull() {
        assertThat(McuEventParser.parse(null)).isNull();
    }

    @Test
    public void missingBBody_returnsNull_forBodyRequiredCommands() throws Exception {
        // Match legacy K900CommandHandler: handlers only ran when bData was non-null.
        assertThat(McuEventParser.parse(cmd("hm_batv"))).isNull();
        assertThat(McuEventParser.parse(cmd("hm_spkcode"))).isNull();
        assertThat(McuEventParser.parse(cmd("sr_swst"))).isNull();
        assertThat(McuEventParser.parse(cmd("sr_tpevt"))).isNull();
        assertThat(McuEventParser.parse(cmd("sr_fbvol"))).isNull();
        assertThat(McuEventParser.parse(cmd("hs_syvr"))).isNull();
    }
}

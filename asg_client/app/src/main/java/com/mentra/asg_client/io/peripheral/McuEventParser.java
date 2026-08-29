package com.mentra.asg_client.io.peripheral;

import com.mentra.asg_client.io.peripheral.events.BatteryEvent;
import com.mentra.asg_client.io.peripheral.events.BesOtaAuthEvent;
import com.mentra.asg_client.io.peripheral.events.BesVersionEvent;
import com.mentra.asg_client.io.peripheral.events.BtMacEvent;
import com.mentra.asg_client.io.peripheral.events.ButtonEvent;
import com.mentra.asg_client.io.peripheral.events.FactoryResetEvent;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.io.peripheral.events.HotspotTriggerEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.PairingModeExitEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.io.peripheral.events.SpeakPairingCodeEvent;
import com.mentra.asg_client.io.peripheral.events.SwipeVolumeEvent;
import com.mentra.asg_client.io.peripheral.events.SwitchEvent;
import com.mentra.asg_client.io.peripheral.events.TouchEvent;
import com.mentra.asg_client.io.peripheral.events.VoiceActivityEvent;
import org.json.JSONObject;

/**
 * Translates raw BES-originated JSON commands into typed {@link McuEvent}s. JSON format is {@code
 * {"C": "<command>", "B": { ... }}}.
 *
 * <p>Note: {@code sr_log} is intentionally not handled here. It is consumed directly by {@code
 * K900CommandHandler}, which owns the BES log session created by the outgoing {@code mh_logs}
 * request flow.
 */
public final class McuEventParser {

    private McuEventParser() {}

    /**
     * Parse a BES command into a typed event.
     *
     * @param json the raw K900-format command
     * @return the typed event, or {@code null} for unknown or intentionally ignored commands
     */
    public static McuEvent parse(JSONObject json) {
        if (json == null) {
            return null;
        }
        String command = json.optString("C", "");
        JSONObject b = json.optJSONObject("B");

        switch (command) {
            case "cs_pho":
                return new ButtonEvent(ButtonEvent.Type.CAMERA_SHORT_PRESS);

            case "cs_vdo":
                return new ButtonEvent(ButtonEvent.Type.CAMERA_LONG_PRESS);

            case "hs_ntfy":
                return parseHardwareNotification(b);

            case "cs_shut":
                return new ShutdownEvent();

            case "cs_fcrst":
                return new FactoryResetEvent();

            case "hm_batv":
                if (b == null) {
                    return null;
                }
                return new BatteryEvent(b.optInt("pt", -1), b.optInt("vt", -1));

            case "hm_spkcode":
                if (b == null) {
                    return null;
                }
                String code = b.optString("code", "").trim();
                return code.isEmpty() ? null : new SpeakPairingCodeEvent(code);

            case "hm_pairexit":
                return new PairingModeExitEvent(b == null ? "unknown" : b.optString("reason", "unknown"));

            case "sr_swst":
                if (b == null) {
                    return null;
                }
                return new SwitchEvent(b.optInt("type", -1), b.optInt("switch", -1));

            case "sr_tpevt":
                if (b == null) {
                    return null;
                }
                return new TouchEvent(b.optInt("type", -1));

            case "sr_fbvol":
                if (b == null) {
                    return null;
                }
                return new SwipeVolumeEvent(b.optInt("switch", 0) == 1);

            case "sr_keyevt":
                {
                    int button = b != null ? b.optInt("button", -1) : -1;
                    int type = b != null ? b.optInt("type", -1) : -1;
                    if (button == 0 && type == 0) {
                        return new ButtonEvent(ButtonEvent.Type.POWER_SHORT_PRESS);
                    }
                    return null; // Other key combos are not handled.
                }

            case "sr_btaddr":
                {
                    String mac = b != null ? b.optString("btaddr", "") : "";
                    return mac.isEmpty() ? null : new BtMacEvent(mac);
                }

            case "hs_syvr":
                return parseVersionReport(b);

            case "hm_ota":
                {
                    boolean authorized = b != null && b.optInt("result", 0) == 1;
                    return new BesOtaAuthEvent(authorized);
                }

            case "hm_htsp":
            case "mh_htsp":
                return new HotspotTriggerEvent();

            case "cs_flts":
                {
                    if (b == null) {
                        return null;
                    }
                    int state = b.optInt("state", -1);
                    int index = b.optInt("index", -1);
                    return (state != -1 && index != -1)
                            ? new FileTransferAckEvent(state, index)
                            : null;
                }

            case "sr_vad":
                {
                    boolean active = b != null && b.optInt("on", 0) == 1;
                    return new VoiceActivityEvent(active);
                }

                // Intentionally ignored mirrored commands.
            case "android_control_led":
            case "cs_swit":
            case "cs_fbvol":
            case "cs_batv":
            case "sr_ledon":
                return null;

            default:
                return null;
        }
    }

    private static McuEvent parseHardwareNotification(JSONObject b) {
        if (b == null) {
            return null;
        }
        String msg = b.optString("msg", "");
        if ("button click".equals(msg)) {
            return new ButtonEvent(ButtonEvent.Type.CAMERA_SHORT_PRESS);
        } else if ("button long click".equals(msg)) {
            return new ButtonEvent(ButtonEvent.Type.CAMERA_LONG_PRESS);
        }
        return null;
    }

    private static McuEvent parseVersionReport(JSONObject b) {
        if (b == null) {
            return null;
        }
        return new BesVersionEvent(
                b.optString("version", "unknown"),
                b.optString("ble", "unknown"),
                b.optString("bt", "unknown"),
                b.optString("btaddr", "unknown"),
                b.optString("bleaddr", "unknown"));
    }
}

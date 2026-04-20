/*
 * Copyright (c) 2024 Mentra
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * MentraOS BLE Protobuf Message Handler
 *
 * SUPPORTED MESSAGE TYPES:
 *
 * === PhoneToGlasses (Incoming) Messages ===
 * Tag 10: DisconnectRequest        - Connection termination request (No response)
 * Tag 11: BatteryStateRequest      - Request current battery level → Response: BatteryStatus (Tag 10)
 * Tag 12: GlassesInfoRequest       - Request device information → Response: DeviceInfo (TODO)
 * Tag 16: PingRequest              - Connectivity test request → Response: PongResponse (TODO)
 * Tag 30: DisplayText              - Display static text message (No response)
 * Tag 35: DisplayScrollingText     - Display animated scrolling text (No response)
 * Tag 37: BrightnessConfig         - Set display brightness level (Projector, No response)
 * Tag 38: AutoBrightnessConfig     - Configure automatic brightness adjustment (No response)
 * Tag 39: AutoBrightnessMultiplier - Adjust AUTO brightness sensitivity (No response)
 * Tag 46: ClearDisplay             - Clear display content (No response)
 *
 * === GlassesToPhone (Outgoing) Messages ===
 * Tag 10: BatteryStatus            - Battery level notification (85% default, 0-100% range)
 *                                    ⚠️  MOBILE APP TEAM: Please verify charging field parsing
 *                                    Firmware sends: { level: 0-100, charging: true/false }
 *                                    Current observation: Mobile app shows charging logo in all states
 *                                    Action: Confirm mobile app handles BatteryStatus.charging field correctly
 * Tag ??: DeviceInfo               - Device information response (TODO - not implemented)
 * Tag ??: PongResponse             - Ping response (TODO - not implemented)
 *
 * === Message Directions & Responses ===
 * Phone → Glasses: Control commands, requests, configuration
 * Glasses → Phone: Status notifications, responses, acknowledgments
 *
 * === Protocol Details ===
 * - Wire Format: 0x02 header + protobuf payload
 * - Encoding: nanopb library (Protocol Buffers for embedded systems)
 * - Version: MentraOS BLE Protobuf v3
 * - Transport: BLE GATT characteristic notifications
 */

#include "protobuf_handler.h"

#include <errno.h>
#include <pb_decode.h>
#include <pb_encode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "../../custom_driver_module/drivers/display/lcd/a6n.h"
#include "main.h"
#include "mos_ble_service.h"
#include "mos_brightness.h"
#include "mos_components/mos_lvgl_display/include/mos_lvgl_display.h"  // **NEW: For protobuf text display**
#include "mos_gx8002.h"  // GX8002 VAD path enabled
#include "mos_i2s_slave.h"  // GX8002 I2S slave
// #include "pdm_audio_stream.h"  // PDM path disabled - using GX8002 VAD
#include "proto/mentraos_ble.pb.h"
#include "vad_interrupt_handler.h"  // GX8002 VAD interrupt handler

LOG_MODULE_REGISTER(protobuf_handler, LOG_LEVEL_DBG);

// Global battery level state (0-100%)
static uint32_t current_battery_level = 85;

// Global battery charging state
static bool current_charging_state = false;

// Audio streaming error counter
static uint32_t streaming_errors = 0;
static bool mic_state_applied_valid = false;
static bool mic_state_applied_enabled = false;

// **NEW: Ping/Pong connectivity monitoring**
// (Glasses send periodic pings to phone, phone responds with pongs)
static struct k_timer ping_timer;
static struct k_timer ping_timeout_timer;
static uint32_t ping_sequence_number = 0;
static uint32_t ping_retry_count = 0;
static bool ping_waiting_for_pong = false;
static bool phone_connected = true;
bool ping_logging_enabled = true;  // Global flag to control ping logging

#define PING_INTERVAL_MS 10000  // Send ping every 10 seconds
#define PING_TIMEOUT_MS 3000  // Wait 3 seconds for pong response
#define PING_MAX_RETRIES 3  // Retry 3 times before declaring disconnect

// Forward declarations for ping/pong functions
static void ping_timer_handler(struct k_timer *timer);
static void ping_timeout_handler(struct k_timer *timer);
static void protobuf_send_ping_request(void);
static void protobuf_process_pong_response(const mentraos_ble_PingRequest *pong);
static void protobuf_handle_ping_failure(void);
static void protobuf_handle_ping_success(void);

static const char *protobuf_message_name(uint32_t which_payload)
{
    switch (which_payload)
    {
        case 10:
            return "DisconnectRequest";
        case 11:
            return "BatteryStateRequest";
        case 12:
            return "GlassesInfoRequest";
        case 16:
            return "PingRequest";
        case 20:
            return "MicStateConfig";
        case 30:
            return "DisplayText";
        case 35:
            return "DisplayScrollingText";
        case 37:
            return "BrightnessConfig";
        case 38:
            return "AutoBrightnessConfig";
        case 39:
            return "AutoBrightnessMultiplier";
        case 45:
            return "DisplayHeightConfig";
        case 44:
            return "DisplayDistanceConfig";
        case 46:
            return "ClearDisplay";
        default:
            return "Unknown";
    }
}

static const char *protobuf_wire_type_name(uint8_t wire_type)
{
    switch (wire_type)
    {
        case 0:
            return "VARINT";
        case 1:
            return "FIXED64";
        case 2:
            return "LENGTH_DELIMITED";
        case 3:
            return "START_GROUP";
        case 4:
            return "END_GROUP";
        case 5:
            return "FIXED32";
        default:
            return "UNKNOWN";
    }
}

static bool protobuf_read_varint32(const uint8_t *data, uint16_t len, uint16_t *offset, uint32_t *value_out)
{
    uint32_t result = 0;
    uint8_t shift = 0;
    uint16_t pos = *offset;

    while (pos < len && shift <= 28)
    {
        uint8_t byte = data[pos++];
        result |= ((uint32_t)(byte & 0x7F)) << shift;

        if ((byte & 0x80) == 0)
        {
            *offset = pos;
            *value_out = result;
            return true;
        }

        shift += 7;
    }

    return false;
}

static void protobuf_dump_wire_fields(const uint8_t *data, uint16_t len)
{
    uint16_t offset = 0;
    uint16_t parsed_fields = 0;
    uint16_t length_delimited_count = 0;

    LOG_INF("Wire-aware protobuf field walk:");

    while (offset < len && parsed_fields < 32)
    {
        uint16_t key_offset = offset;
        uint32_t key = 0;

        if (!protobuf_read_varint32(data, len, &offset, &key))
        {
            LOG_WRN("  Truncated/invalid field key at offset %u", key_offset);
            break;
        }

        uint32_t tag = key >> 3;
        uint8_t wire_type = (uint8_t)(key & 0x07);

        if (tag == 0)
        {
            LOG_WRN("  Invalid field key at offset %u: tag=0, wire=%u (%s)", key_offset, wire_type,
                    protobuf_wire_type_name(wire_type));
            break;
        }

        LOG_INF("  field[%02u] key@%u -> tag=%u wire=%u (%s)", parsed_fields, key_offset, tag, wire_type,
                protobuf_wire_type_name(wire_type));

        switch (wire_type)
        {
            case 0:
            {
                uint32_t value = 0;
                if (!protobuf_read_varint32(data, len, &offset, &value))
                {
                    LOG_WRN("    Invalid VARINT payload for tag=%u", tag);
                    return;
                }
                break;
            }

            case 1:
                if ((uint16_t)(len - offset) < 8U)
                {
                    LOG_WRN("    Truncated FIXED64 payload for tag=%u", tag);
                    return;
                }
                offset += 8;
                break;

            case 2:
            {
                uint32_t payload_len = 0;
                if (!protobuf_read_varint32(data, len, &offset, &payload_len))
                {
                    LOG_WRN("    Invalid LENGTH_DELIMITED size varint for tag=%u", tag);
                    return;
                }

                if (payload_len > (uint32_t)(len - offset))
                {
                    LOG_WRN("    Truncated LENGTH_DELIMITED payload for tag=%u (need %u, have %u)", tag, payload_len,
                            (uint32_t)(len - offset));
                    return;
                }

                LOG_INF("    LENGTH_DELIMITED payload: len=%u data_offset=%u", payload_len, offset);
                length_delimited_count++;
                offset += (uint16_t)payload_len;
                break;
            }

            case 5:
                if ((uint16_t)(len - offset) < 4U)
                {
                    LOG_WRN("    Truncated FIXED32 payload for tag=%u", tag);
                    return;
                }
                offset += 4;
                break;

            case 3:
            case 4:
                LOG_WRN("    GROUP wire type encountered (tag=%u). Not expected for proto3 payloads.", tag);
                return;

            default:
                LOG_WRN("    Unsupported wire type=%u for tag=%u", wire_type, tag);
                return;
        }

        parsed_fields++;
    }

    if (parsed_fields == 0)
    {
        LOG_WRN("  No valid protobuf fields parsed");
    }
    else
    {
        LOG_INF("Wire walk summary: parsed_fields=%u, length_delimited_fields=%u, bytes_consumed=%u/%u", parsed_fields,
                length_delimited_count, offset, len);
    }
}

void protobuf_analyze_message(const uint8_t *data, uint16_t len)
{
    if (len == 0)
    {
        LOG_WRN("Received empty data - ignoring");
        return;
    }
    // LOG_INF("=== BLE DATA RECEIVED ===");
    LOG_INF("Received BLE data (%u bytes):", len);

    // Print hex dump (use Zephyr hexdump helper so logging backend and
    // runtime filtering are respected)
    LOG_HEXDUMP_INF(data, len, "BLE_RX");

    // Check if this looks like a protobuf message (starts with control header)
    uint8_t firstByte = data[0];
    switch (firstByte)
    {
        case 0x02:
            /* LOG_INF("[PROTOBUF] Control header detected: 0x02 (Protobuf message)"); */
            protobuf_parse_control_message(data + 1, len - 1);
            break;
        case 0xA0:
            /* LOG_INF("[AUDIO] Control header detected: 0xA0 (Audio data)"); */
            protobuf_parse_audio_chunk(data, len);
            break;
        case 0xB0:
            /* LOG_INF("[IMAGE] Control header detected: 0xB0 (Image data)"); */
            protobuf_parse_image_chunk(data, len);
            break;
        default:
            LOG_WRN("[UNKNOWN] Unknown control header: 0x%02X", firstByte);
            // Detect common non-protobuf payloads (e.g. JSON text)
            // Example observed payload: 04 01 00 7B ... where 0x7B is '{'
            bool looks_like_json = false;
            if (len > 0 && data[0] == '{')
            {
                looks_like_json = true;
            }
            else if (len > 3 && data[3] == '{')
            {
                looks_like_json = true;
            }

            if (looks_like_json)
            {
                /* LOG_INF("[NON_PROTOBUF] JSON-like payload detected; skipping protobuf decode fallback"); */
                break;
            }

            // Fallback parse only when payload does not look like known text/JSON framing
            if (len > 1)
            {
                LOG_WRN("[PROTOBUF] Missing 0x02 header, trying fallback decode");
                protobuf_parse_control_message(data, len);
            }
            break;
    }
    /* LOG_INF("=== END BLE DATA ==="); */
}

void protobuf_parse_control_message(const uint8_t *protobuf_data, uint16_t len)
{
    LOG_INF("[PROTOBUF] Decoding protobuf message (%u bytes)\n", len);
    if (len == 0)
    {
        LOG_WRN("Empty protobuf message");
        return;
    }

    // Try to decode as PhoneToGlasses message
    mentraos_ble_PhoneToGlasses phone_msg = mentraos_ble_PhoneToGlasses_init_default;

    /* LOG_INF("Attempting to decode PhoneToGlasses message..."); */
    bool decode_result = decode_phone_to_glasses_message(protobuf_data, len, &phone_msg);

    if (decode_result)
    {
        const char *message_name = protobuf_message_name(phone_msg.which_payload);
        LOG_INF("[PROTOBUF] RX %s tag=%u len=%u", message_name, phone_msg.which_payload, len);

        // Process the decoded message based on payload type
        switch (phone_msg.which_payload)
        {
            case 11:  // battery_state_tag
                LOG_INF("Processing Battery State Request");
                LOG_INF("Current battery level: %u%%", current_battery_level);
                protobuf_send_battery_notification();
                break;

            case 12:  // glasses_info_tag
                LOG_INF("Processing Glasses Info Request");
                LOG_WRN("TODO: Implement device info response (DeviceInfo message)");
                break;

            case 10:  // disconnect_tag
                LOG_INF("Processing Disconnect Request");
                LOG_WRN("TODO: Implement graceful disconnection");
                break;

            case 30:  // display_text_tag
                LOG_INF("Processing Display Text Message...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_display_text_tag)
                {
                    protobuf_process_display_text(&phone_msg.payload.display_text);
                }
                break;

            case 35:  // display_scrolling_text_tag
                LOG_INF("Processing Display Scrolling Text Message...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_display_scrolling_text_tag)
                {
                    protobuf_process_display_scrolling_text(&phone_msg.payload.display_scrolling_text);
                }
                break;

            case 16:  // ping_tag (Phone responds to our pong-as-ping with ping-as-pong)
                LOG_INF("Processing Ping Response from Phone (ping acting as pong response)...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_ping_tag)
                {
                    LOG_INF("[PING] Received pong response from phone");
                    protobuf_process_pong_response(&phone_msg.payload.ping);
                }
                break;

            case 20:  // mic_state_tag
                LOG_INF("Processing Microphone State Configuration...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_mic_state_tag)
                {
                    protobuf_process_mic_state_config(&phone_msg.payload.mic_state);
                }
                break;

            case 37:  // brightness_tag
                LOG_INF("Processing Brightness Configuration...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_brightness_tag)
                {
                    protobuf_process_brightness_config(&phone_msg.payload.brightness);
                }
                break;

            case 38:  // auto_brightness_tag
                LOG_INF("Processing Auto Brightness Configuration...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_auto_brightness_tag)
                {
                    protobuf_process_auto_brightness_config(&phone_msg.payload.auto_brightness);
                }
                break;

            case 39:  // auto_brightness_mult_tag
                LOG_INF("Processing Auto Brightness Multiplier...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_auto_brightness_mult_tag)
                {
                    protobuf_process_auto_brightness_multiplier(&phone_msg.payload.auto_brightness_mult);
                }
                break;

            case 45:  // display_height_tag
                LOG_INF("Processing Display Height Configuration...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_display_height_tag)
                {
                    protobuf_process_display_height_config(&phone_msg.payload.display_height);
                }
                break;
            case 44:  // display_distance_tag
                LOG_INF("Processing Display Distance Configuration...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_display_distance_tag)
                {
                    protobuf_process_display_distance_config(&phone_msg.payload.display_distance);
                }
                break;

            case 46:  // clear_display_tag (temporary - TODO: update when protobuf definition is updated)
                LOG_INF("Processing Clear Display Command...");
                LOG_WRN("Using temporary tag 46 for ClearDisplay - update when protobuf definition is ready");
                protobuf_process_clear_display();
                break;

            default:
                LOG_WRN("Unknown message type: tag=%u len=%u", phone_msg.which_payload, len);
                break;
        }
    }
    else
    {
        LOG_ERR("Failed to decode protobuf message (%u bytes)", len);

        protobuf_dump_wire_fields(protobuf_data, len);
    }
}

bool decode_phone_to_glasses_message(const uint8_t *data, uint16_t len, mentraos_ble_PhoneToGlasses *msg)
{
    if (!data || !msg || len == 0)
    {
        LOG_ERR("Invalid parameters for protobuf decode");
        return false;
    }

    LOG_DBG("Decoding %u bytes of protobuf data", len);

    // Create input stream
    pb_istream_t stream = pb_istream_from_buffer(data, len);

    // Decode the message
    bool status = pb_decode(&stream, mentraos_ble_PhoneToGlasses_fields, msg);

    if (!status)
    {
        LOG_ERR("Protobuf decode error: %s", PB_GET_ERROR(&stream));
        LOG_ERR("Stream bytes left: %zu", stream.bytes_left);
        LOG_ERR("Stream state: %p", stream.state);

        // Try basic field analysis for debugging
        LOG_INF("Raw protobuf analysis:");
        for (int i = 0; i < len && i < 20; i++)
        {
            uint8_t field_tag = data[i] >> 3;
            uint8_t wire_type = data[i] & 0x07;
            LOG_DBG("   Byte %d: tag=%u, wire_type=%u, raw=0x%02X", i, field_tag, wire_type, data[i]);
        }
    }
    else
    {
        LOG_INF("Protobuf decode successful, %zu bytes consumed", len - stream.bytes_left);
    }

    return status;
}

bool encode_glasses_to_phone_message(const mentraos_ble_GlassesToPhone *msg, uint8_t *buffer, size_t buffer_size,
                                     size_t *bytes_written)
{
    if (!msg || !buffer || !bytes_written)
    {
        return false;
    }

    // Create output stream
    pb_ostream_t stream = pb_ostream_from_buffer(buffer, buffer_size);

    // Encode the message
    bool status = pb_encode(&stream, mentraos_ble_GlassesToPhone_fields, msg);

    if (status)
    {
        *bytes_written = stream.bytes_written;
        LOG_DBG("Encoded %zu bytes", *bytes_written);
    }
    else
    {
        LOG_ERR("Protobuf encode error: %s", PB_GET_ERROR(&stream));
        *bytes_written = 0;
    }

    return status;
}

void protobuf_parse_audio_chunk(const uint8_t *data, uint16_t len)
{
    if (len < 2)
    {
        LOG_WRN("Audio chunk too short");
        return;
    }

    uint8_t stream_id = data[1];
    uint16_t audio_data_len = len - 2;

    LOG_INF("Audio chunk: stream_id=0x%02X, data_len=%u", stream_id, audio_data_len);
}

void protobuf_parse_image_chunk(const uint8_t *data, uint16_t len)
{
    if (len < 4)
    {
        LOG_WRN("Image chunk too short");
        return;
    }

    uint16_t stream_id = (data[1] << 8) | data[2];
    uint8_t chunk_index = data[3];
    uint16_t image_data_len = len - 4;

    LOG_INF("Image chunk: stream_id=0x%04X, chunk_index=%u, data_len=%u", stream_id, chunk_index, image_data_len);
}

uint32_t protobuf_get_battery_level(void)
{
    return current_battery_level;
}

bool protobuf_get_charging_state(void)
{
    return current_charging_state;
}

void protobuf_set_charging_state(bool charging)
{
    bool old_state = current_charging_state;
    current_charging_state = charging;
    LOG_INF("Charging state set to %s", current_charging_state ? "CHARGING" : "NOT_CHARGING");

    // Send proactive notification if charging state changed
    if (old_state != current_charging_state)
    {
        protobuf_send_battery_notification();
    }
}

void protobuf_toggle_charging_state(void)
{
    protobuf_set_charging_state(!current_charging_state);
}

void protobuf_set_battery_level(uint32_t level)
{
    // Clamp battery level to valid range (0-100%)
    if (level > 100)
    {
        level = 100;
    }

    uint32_t old_level = current_battery_level;
    current_battery_level = level;
    LOG_INF("Battery level set to %u%%", current_battery_level);

    // Send proactive notification if level changed
    if (old_level != current_battery_level)
    {
        protobuf_send_battery_notification();
    }
}

void protobuf_increase_battery_level(void)
{
    uint32_t new_level = current_battery_level + 5;
    if (new_level > 100)
    {
        new_level = 100;
    }
    protobuf_set_battery_level(new_level);
}

void protobuf_decrease_battery_level(void)
{
    uint32_t new_level;
    if (current_battery_level >= 5)
    {
        new_level = current_battery_level - 5;
    }
    else
    {
        new_level = 0;
    }
    protobuf_set_battery_level(new_level);
}

// ⚠️  MOBILE APP TEAM INQUIRY - BATTERY CHARGING STATUS PARSING
//
// ISSUE: Mobile app appears to show charging logo in all battery states
// FIRMWARE: Correctly sends both level and charging fields in BatteryStatus message
//
// MESSAGE FORMAT:
//   BatteryStatus {
//     uint32 level = 1;     // Battery percentage (0-100%)
//     bool charging = 2;    // Charging state (true/false)
//   }
//
// TEST SCENARIO:
//   1. Press Button 1/2 to change battery level
//   2. Press Button 3 to toggle charging status
//   3. Observe mobile app battery indicator behavior
//
// EXPECTED: Mobile app should show/hide charging icon based on charging field
// OBSERVED: Mobile app shows charging icon regardless of charging field value
//
// ACTION REQUIRED:
//   - Verify mobile app parses BatteryStatus.charging field correctly
//   - Confirm UI updates charging indicator based on charging boolean
//   - Test with Button 3 toggle (charging: false ↔ true)
//
void protobuf_send_battery_notification(void)
{
    /* LOG_INF("=== BLE DATA TRANSMISSION ==="); */

    // Create a battery status notification message
    mentraos_ble_GlassesToPhone notification = mentraos_ble_GlassesToPhone_init_default;

    // Set which_payload to battery_status (tag 10)
    notification.which_payload = 10;

    // Fill battery status with current level
    notification.payload.battery_status.level = current_battery_level;
    notification.payload.battery_status.charging = current_charging_state;

    /* LOG_INF("[PROTOBUF][TX] BatteryStatus level=%u charging=%s",
             notification.payload.battery_status.level,
             notification.payload.battery_status.charging ? "true" : "false"); */

    // Encode the notification
    uint8_t buffer[64];  // Small buffer for battery notification
    size_t bytes_written;

    /* LOG_INF("Encoding BatteryStatus with buffer=%zu bytes", sizeof(buffer) - 1); */

    if (encode_glasses_to_phone_message(&notification, buffer + 1, sizeof(buffer) - 1, &bytes_written))
    {
        // Add the 0x02 header for protobuf messages
        buffer[0] = 0x02;

        LOG_HEXDUMP_INF(buffer, bytes_written + 1, "OUTGOING_PKT");

        // Send via BLE (to all connected clients that have enabled TX notifications)
        if (!get_ble_connected_status())
        {
            LOG_DBG("[PROTOBUF][TX] Skip BatteryStatus: no BLE connection");
        }
        else
        {
            int ret = custom_nus_send(NULL, buffer, bytes_written + 1);
            if (ret == 0)
            {
                LOG_INF("[PROTOBUF][TX] BatteryStatus sent level=%u charging=%s bytes=%zu",
                        notification.payload.battery_status.level,
                        notification.payload.battery_status.charging ? "Y" : "N", bytes_written + 1);
            }
            else
            {
                /* -128 etc.: no peer has enabled CCC for TX, or link down; avoid ERR spam */
                LOG_WRN("  - Status: NOT_SENT (err=%d) - app may not have enabled TX notifications (CCC) or link down",
                        ret);
            }
        }
    }
    else
    {
        LOG_ERR("Failed to encode battery notification (buf=%zu)", sizeof(buffer) - 1);
    }
}

int protobuf_generate_echo_response(const uint8_t *input_data, uint16_t input_len, uint8_t *output_data,
                                    uint16_t max_output_len)
{
    // NOTE: This is a fallback echo response using BatteryStatus message
    // TODO: Implement proper echo response message type when protobuf definition is updated
    /* LOG_INF("Generating echo response: input=%u output_buf=%u", input_len, max_output_len); */

    // Create a simple response message
    mentraos_ble_GlassesToPhone response = mentraos_ble_GlassesToPhone_init_default;

    // Set which_payload to battery_status (tag 10) - simpler than device_info
    response.which_payload = 10;

    // Create a battery status response using current battery level
    response.payload.battery_status.level = current_battery_level;
    response.payload.battery_status.charging = current_charging_state;

    /* LOG_INF("Encoding echo response as BatteryStatus level=%u charging=%s",
             response.payload.battery_status.level, response.payload.battery_status.charging ? "true" : "false"); */

    // Encode the response
    size_t bytes_written;
    if (encode_glasses_to_phone_message(&response, output_data + 1, max_output_len - 1, &bytes_written))
    {
        // Add the 0x02 header for protobuf messages
        output_data[0] = 0x02;

        LOG_HEXDUMP_INF(output_data, bytes_written + 1, "ECHO_PKT");
        LOG_INF("[PROTOBUF][TX] Echo response ready bytes=%zu", bytes_written + 1);
        return bytes_written + 1;
    }
    else
    {
        LOG_ERR("Failed to encode echo response (buf=%u)", max_output_len - 1);
        return -ENOMEM;
    }
}

void protobuf_process_brightness_config(const mentraos_ble_BrightnessConfig *brightness_config)
{
    if (!brightness_config)
    {
        LOG_ERR("[PROTOBUF] Invalid BrightnessConfig pointer");
        return;
    }

    uint32_t level = brightness_config->value;
    if (level > 100U)
    {
        LOG_WRN("[PROTOBUF] BrightnessConfig %u out of range, clamped to 100", level);
        level = 100U;
    }

    LOG_INF("[PROTOBUF] BrightnessConfig -> %u%%", level);
    mos_brightness_request_manual(level);
}

void protobuf_process_display_text(const mentraos_ble_DisplayText *display_text)
{
    if (!display_text)
    {
        LOG_ERR("Invalid display text pointer");
        return;
    }

    size_t text_length = strlen(display_text->text);

    /* Ignore an empty first DisplayText while still on the welcome screen.
     * Once we've already switched into the text scene, keep honoring BLE payloads as-is. */
    if (text_length == 0U && display_is_welcome_screen_active())
    {
        LOG_INF("[PROTOBUF] Ignore empty DisplayText while welcome screen is active");
        return;
    }

    uint32_t color_rgb888 = display_text->color;
    uint16_t color_rgb565 = (uint16_t)color_rgb888;
    LOG_INF("[PROTOBUF] DisplayText len=%zu pos=(%u,%u) color=0x%04X font=%u size=%u", text_length, display_text->x,
            display_text->y, color_rgb565, display_text->font_code, display_text->size);

    // *** LVGL INTEGRATION: Display text based on current pattern ***
    // **NEW: Check current pattern to determine display mode**
    int current_pattern = display_get_current_pattern();

    if (current_pattern == 5)
    {
        // Pattern 5: XY Text Positioning - use coordinates and font size from protobuf
        // BLE text offset: move down 100px from phone-sent position
        uint32_t y_offset = (uint32_t)display_text->y + 80U;
        uint16_t y_clamped = (y_offset > 65535U) ? 65535 : (uint16_t)y_offset;
        uint16_t font_size = (display_text->size > 0) ? display_text->size : 12;  // Default to 12pt
        display_update_xy_text(display_text->x, y_clamped, display_text->text, font_size, color_rgb565);
        /* LOG_INF("LVGL XY positioned text at (%u,%u) font=%u", display_text->x, y_clamped, font_size); */
    }
    else
    {
        // Pattern 4 or others: Auto-scroll container (backward compatibility)
        display_update_protobuf_text(display_text->text);
        /* LOG_INF("LVGL protobuf text updated in auto-scroll container (Pattern %d)", current_pattern); */
    }
}

void protobuf_process_display_scrolling_text(const mentraos_ble_DisplayScrollingText *scrolling_text)
{
    if (!scrolling_text)
    {
        LOG_ERR("Invalid scrolling text pointer");
        return;
    }

    size_t text_length = strlen(scrolling_text->text);

    const char *alignment_name;
    switch (scrolling_text->align)
    {
        case 0:
            alignment_name = "LEFT";
            break;
        case 1:
            alignment_name = "CENTER";
            break;
        case 2:
            alignment_name = "RIGHT";
            break;
        default:
            alignment_name = "UNKNOWN";
            break;
    }

    LOG_INF("[PROTOBUF] DisplayScrollingText len=%zu area=%ux%u pos=(%u,%u) speed=%u align=%s loop=%s", text_length,
            scrolling_text->width, scrolling_text->height, scrolling_text->x, scrolling_text->y, scrolling_text->speed,
            alignment_name, scrolling_text->loop ? "Y" : "N");

    // *** LVGL INTEGRATION: Display scrolling text in protobuf container ***
    // **NEW: Both DisplayText and DisplayScrollingText update the same auto-scroll container**
    display_update_protobuf_text(scrolling_text->text);
    /* LOG_INF("LVGL protobuf scrolling text updated in auto-scroll container"); */
}

void protobuf_parse_text_brightness(const char *text)
{
    if (!text)
    {
        return;
    }

    /* LOG_INF("TEXT BRIGHTNESS parser input: %s", text); */

    // Look for patterns like "brightness to 61%" or "61%"
    const char *brightness_keyword = "brightness to ";
    const char *percent_sign = "%";

    char *brightness_pos = strstr(text, brightness_keyword);
    if (brightness_pos)
    {
        // Found "brightness to" pattern
        brightness_pos += strlen(brightness_keyword);

        // Extract the number before the % sign
        int brightness_value = 0;
        char *percent_pos = strstr(brightness_pos, percent_sign);

        if (percent_pos)
        {
            // Create a temporary string to extract the number
            int num_chars = percent_pos - brightness_pos;
            if (num_chars > 0 && num_chars < 10)
            {
                char num_str[10];
                strncpy(num_str, brightness_pos, num_chars);
                num_str[num_chars] = '\0';

                brightness_value = atoi(num_str);

                LOG_INF("TEXT BRIGHTNESS: Extracted value %d%%", brightness_value);

                if (brightness_value >= 0 && brightness_value <= 100)
                {
                    mos_brightness_request_manual((uint32_t)brightness_value);
                    LOG_INF("[UART BRIGHTNESS] Text brightness set to %d%%", brightness_value);
                }
                else
                {
                    LOG_WRN("TEXT BRIGHTNESS: Invalid value %d (must be 0-100)", brightness_value);
                }
            }
        }
    }
    else
    {
        LOG_DBG("TEXT BRIGHTNESS: No brightness pattern found in text");
    }
}

void protobuf_process_display_height_config(const mentraos_ble_DisplayHeightConfig *config)
{
    LOG_INF("[PROTOBUF] DisplayHeightConfig height=%d", config->height);

    display_update_height(config->height);
}

void protobuf_process_display_distance_config(const mentraos_ble_DisplayDistanceConfig *config)
{
    if (!config)
    {
        LOG_ERR("Invalid DisplayDistanceConfig pointer");
        return;
    }

    const uint32_t v = (uint32_t)config->distance_cm;
    uint32_t distance_cm = v;
    bool legacy_tier = false;

    if (v == 1U)
    {
        distance_cm = 200U;
        legacy_tier = true;
    }
    else if (v == 2U)
    {
        distance_cm = 250U;
        legacy_tier = true;
    }
    else if (v == 3U)
    {
        distance_cm = 500U;
        legacy_tier = true;
    }

    int8_t offset = 0;
    uint32_t clamped_cm = 0U;
    int ret = a6n_depth_distance_cm_to_offset(distance_cm, &offset, &clamped_cm);
    if (ret != 0)
    {
        LOG_ERR("Failed to calculate DisplayDistance: request=%u cm ret=%d", (unsigned int)distance_cm, ret);
        return;
    }

    LOG_INF("[PROTOBUF] DisplayDistanceConfig %srequest=%u -> distance=%u cm clamp=%u cm offset=%d px",
            legacy_tier ? "legacy-tier " : "", (unsigned int)v, (unsigned int)distance_cm, (unsigned int)clamped_cm,
            (int)offset);

    ret = a6n_set_software_depth_offset(offset);
    if (ret != 0)
    {
        LOG_ERR("Failed to apply DisplayDistance: offset=%d ret=%d", (int)offset, ret);
        return;
    }

    /* Trigger visible redraw only (lighter than full redraw) */
    display_request_visible_redraw();
}

void protobuf_process_clear_display(void)
{
    LOG_WRN("TEMPORARY IMPLEMENTATION: Using tag 46 for ClearDisplay");
    LOG_INF("[PROTOBUF] ClearDisplay requested");

    display_clear_screen();
}

void protobuf_process_auto_brightness_config(const mentraos_ble_AutoBrightnessConfig *auto_brightness_config)
{
    if (!auto_brightness_config)
    {
        LOG_ERR("[PROTOBUF] Invalid AutoBrightnessConfig pointer");
        return;
    }
    LOG_INF("[PROTOBUF] AutoBrightnessConfig -> %s", auto_brightness_config->enabled ? "ON" : "OFF");
    mos_brightness_request_auto_enabled(auto_brightness_config->enabled);
}

void protobuf_process_auto_brightness_multiplier(
    const mentraos_ble_AutoBrightnessMultiplier *auto_brightness_multiplier_msg)
{
    if (!auto_brightness_multiplier_msg)
    {
        LOG_ERR("[PROTOBUF] Invalid AutoBrightnessMultiplier pointer");
        return;
    }
    LOG_INF("[PROTOBUF] AutoBrightnessMultiplier -> %.2f", (double)auto_brightness_multiplier_msg->multiplier);
    mos_brightness_request_multiplier(auto_brightness_multiplier_msg->multiplier);
}

void protobuf_process_mic_state_config(const mentraos_ble_MicStateConfig *mic_state)
{
    if (!mic_state)
    {
        LOG_ERR("Invalid mic state config pointer");
        return;
    }

    bool enabled = mic_state->enabled;

    if (mic_state_applied_valid && mic_state_applied_enabled == enabled)
    {
        return;
    }

    bool was_enabled = vad_interrupt_handler_is_enabled();
    bool was_streaming = vad_interrupt_handler_is_i2s_active();
    LOG_INF("[PROTOBUF] MicStateConfig %s->%s i2s=%s", was_enabled ? "ON" : "OFF", enabled ? "ON" : "OFF",
            was_streaming ? "ACTIVE" : "INACTIVE");

    int ret = 0;
    vad_interrupt_handler_set_enabled(enabled);
    if (enabled)
    {
        ret = mos_gx8002_vad_int_re_enable();
    }
    else
    {
        int vad_disable_ret = mos_gx8002_vad_int_disable();
        int stop_ret = gx8002_i2s_stop();
        if (stop_ret == 0 || stop_ret == -EALREADY)
        {
            vad_interrupt_handler_notify_i2s_stopped();
        }
        (void)mos_gx8002_disable_i2s();
        if (vad_disable_ret != 0)
        {
            ret = vad_disable_ret;
        }
        else if (stop_ret != 0)
        {
            ret = stop_ret;
        }
        /* Do not treat GX8002 I2C disable failure as fatal: local pipeline is already stopped */
    }

    if (ret == 0 || ret == -EALREADY)
    {
        mic_state_applied_valid = true;
        mic_state_applied_enabled = enabled;
    }
    else
    {
        LOG_ERR("[MIC_CTRL] Apply FAIL req=%s err=%d", enabled ? "ON" : "OFF", ret);
        streaming_errors++;
    }
}

// =============================================================================
// PING/PONG CONNECTIVITY MONITORING IMPLEMENTATION
// =============================================================================
// Glasses send periodic pings (tag 15) to phone
// Phone responds with pongs (tag 16)
// After 3 failed ping attempts, glasses go to sleep/disconnect mode

// Timer handler: Send ping every 10 seconds
static void ping_timer_handler(struct k_timer *timer)
{
    if (!ping_waiting_for_pong)
    {
        protobuf_send_ping_request();
    }
    else
    {
        if (ping_logging_enabled)
        {
            LOG_WRN("[PING] Still waiting for pong response, skipping this ping");
        }
    }
}

// Timeout handler: Handle ping timeout (no pong received)
static void ping_timeout_handler(struct k_timer *timer)
{
    if (ping_logging_enabled)
    {
        LOG_WRN("[PING] Timeout - no pong response within %d ms", PING_TIMEOUT_MS);
    }
    ping_retry_count++;
    ping_waiting_for_pong = false;

    if (ping_retry_count >= PING_MAX_RETRIES)
    {
        if (ping_logging_enabled)
        {
            LOG_ERR("[PING] Max retries (%d) reached - phone disconnected!", PING_MAX_RETRIES);
        }
        protobuf_handle_ping_failure();
    }
    else
    {
        if (ping_logging_enabled)
        {
            LOG_WRN("[PING] Retry %d/%d - attempt failed", ping_retry_count, PING_MAX_RETRIES);
        }
        // The next ping will be sent by the regular ping timer
    }
}

// Send ping request to phone (tag 15: GlassesToPhone.pong - using pong as ping for connectivity check)
static void protobuf_send_ping_request(void)
{
    ping_sequence_number++;
    ping_waiting_for_pong = true;

    mentraos_ble_GlassesToPhone message = mentraos_ble_GlassesToPhone_init_zero;
    message.which_payload = mentraos_ble_GlassesToPhone_pong_tag;

    // Note: Current protobuf only has dummy_field, no timestamp/sequence
    // For now we'll track sequence numbers in our local variables
    message.payload.pong.dummy_field = 1;  // Just to set something

    // Encode the message
    uint8_t buffer[256];
    pb_ostream_t stream = pb_ostream_from_buffer(buffer, sizeof(buffer));

    if (pb_encode(&stream, mentraos_ble_GlassesToPhone_fields, &message))
    {
        size_t message_length = stream.bytes_written;

        if (ping_logging_enabled)
        {
            LOG_DBG("[PING] Sending ping #%u (%zu bytes)", ping_sequence_number, message_length);
        }
        /* Start timeout timer only after successful send */
        k_timer_start(&ping_timeout_timer, K_MSEC(PING_TIMEOUT_MS), K_NO_WAIT);

        if (ping_logging_enabled)
        {
            LOG_INF("[PING] Waiting for pong response (timeout: %d ms)", PING_TIMEOUT_MS);
        }
    }
    else
    {
        if (ping_logging_enabled)
        {
            LOG_ERR("[PING] Failed to encode ping request");
        }
        ping_waiting_for_pong = false;
    }
}

// Process pong response from phone (tag 16: PhoneToGlasses.ping - reusing ping for pong)
static void protobuf_process_pong_response(const mentraos_ble_PingRequest *pong)
{
    if (!ping_waiting_for_pong)
    {
        LOG_WRN("[PING] Received unexpected pong (not waiting)");
        return;
    }

    // Stop timeout timer
    k_timer_stop(&ping_timeout_timer);
    ping_waiting_for_pong = false;

    LOG_INF("[GLASSES<-PHONE PONG] Received pong response (dummy_field: %c)\n", pong->dummy_field);

    // Since current protobuf doesn't have sequence numbers, we'll assume success
    LOG_INF("[PING] Phone responded - connection alive!");
    protobuf_handle_ping_success();
}

// Handle successful ping/pong exchange
static void protobuf_handle_ping_success(void)
{
    ping_retry_count = 0;  // Reset retry counter

    if (!phone_connected)
    {
        phone_connected = true;
        LOG_INF("[GLASSES CONNECTION] Phone reconnected!\n");
        // TODO: Wake up from sleep mode, restore normal operation
    }

    LOG_INF("[GLASSES CONNECTION] Phone connectivity confirmed (retry count reset)\n");
}

// Handle ping failure (no pong response after max retries)
static void protobuf_handle_ping_failure(void)
{
    phone_connected = false;
    ping_retry_count = 0;
    ping_waiting_for_pong = false;

    if (ping_logging_enabled)
    {
        LOG_ERR("[PING] Phone connection lost - entering sleep mode");
    }

    // TODO: Implement sleep/disconnect logic:
    // 1. Stop all non-essential operations
    // 2. Reduce display brightness or turn off display
    // 3. Stop audio streaming
    // 4. Enter low-power mode
    // 5. Wake up periodically to check for reconnection

    if (ping_logging_enabled)
    {
        LOG_WRN("[PING] TODO: Implement sleep mode (display off, low power)");
        LOG_WRN("[PING] TODO: Wake up periodically to check for phone reconnection");
    }
}

// Initialize ping/pong monitoring system
void protobuf_init_ping_monitoring(void)
{
    // Initialize timers
    k_timer_init(&ping_timer, ping_timer_handler, NULL);
    k_timer_init(&ping_timeout_timer, ping_timeout_handler, NULL);

    // Start periodic ping timer (10 seconds interval)
    k_timer_start(&ping_timer, K_MSEC(PING_INTERVAL_MS), K_MSEC(PING_INTERVAL_MS));

    LOG_INF("[PING] Ping monitoring started (interval: %d ms, timeout: %d ms, max retries: %d)", PING_INTERVAL_MS,
            PING_TIMEOUT_MS, PING_MAX_RETRIES);
}

// =============================================================================
// LEGACY PONG RESPONSE (DEPRECATED - keeping for compatibility)
// =============================================================================
// This was the old implementation where glasses responded to phone pings
// Now glasses send pings and phone responds with pongs

void protobuf_send_pong_response(mentraos_ble_PingRequest *ping_request)
{
    LOG_INF("[DEPRECATED] protobuf_send_pong_response called - glasses now send pings instead\n");
    // This function is no longer used in the new ping/pong direction
}

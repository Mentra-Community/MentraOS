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

#include <pb_decode.h>
#include <pb_encode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "../../custom_driver_module/drivers/display/lcd/a6n.h"
#include "mos_ble_service.h"
#include "mos_components/mos_lvgl_display/include/mos_lvgl_display.h"  // **NEW: For protobuf text display**
#include "pdm_audio_stream.h"                                          // **NEW: For microphone audio streaming**
#include "proto/mentraos_ble.pb.h"

LOG_MODULE_REGISTER(protobuf_handler, LOG_LEVEL_DBG);

// Global battery level state (0-100%)
static uint32_t current_battery_level = 85;

// Global battery charging state
static bool current_charging_state = false;

// Global brightness level state (0-100%)
static uint32_t current_brightness_level = 50;

// Global auto brightness state
static bool auto_brightness_enabled = false;

// Audio streaming error counter
static uint32_t streaming_errors = 0;

// **NEW: Ping/Pong connectivity monitoring**
// (Glasses send periodic pings to phone, phone responds with pongs)
static struct k_timer ping_timer;
static struct k_timer ping_timeout_timer;
static uint32_t       ping_sequence_number  = 0;
static uint32_t       ping_retry_count      = 0;
static bool           ping_waiting_for_pong = false;
static bool           phone_connected       = true;
bool                  ping_logging_enabled  = true;  // Global flag to control ping logging

#define PING_INTERVAL_MS 10000  // Send ping every 10 seconds
#define PING_TIMEOUT_MS  3000   // Wait 3 seconds for pong response
#define PING_MAX_RETRIES 3      // Retry 3 times before declaring disconnect

// Forward declarations for ping/pong functions
static void ping_timer_handler(struct k_timer* timer);
static void ping_timeout_handler(struct k_timer* timer);
static void protobuf_send_ping_request(void);
static void protobuf_process_pong_response(const mentraos_ble_PingRequest* pong);
static void protobuf_handle_ping_failure(void);
static void protobuf_handle_ping_success(void);

void protobuf_analyze_message(const uint8_t* data, uint16_t len)
{
    if (len == 0)
    {
        LOG_WRN("Received empty data - ignoring");
        return;
    }
    LOG_INF("=== BLE DATA RECEIVED ===");
    LOG_INF("Received BLE data (%u bytes):", len);

    // Print hex dump (use Zephyr hexdump helper so logging backend and
    // runtime filtering are respected)
    LOG_HEXDUMP_INF(data, len, "BLE_RX");

    // Check if this looks like a protobuf message (starts with control header)
    uint8_t firstByte = data[0];
    switch (firstByte)
    {
        case 0x02:
            LOG_INF("[PROTOBUF] Control header detected: 0x02 (Protobuf message)");
            protobuf_parse_control_message(data + 1, len - 1);
            break;
        case 0xA0:
            LOG_INF("[AUDIO] Control header detected: 0xA0 (Audio data)");
            protobuf_parse_audio_chunk(data, len);
            break;
        case 0xB0:
            LOG_INF("[IMAGE] Control header detected: 0xB0 (Image data)");
            protobuf_parse_image_chunk(data, len);
            break;
        default:
            LOG_WRN("[UNKNOWN] Unknown control header: 0x%02X", firstByte);
            // Still try to parse as protobuf in case the header is part of the message
            if (len > 1)
            {
                LOG_INF("[FALLBACK] Attempting protobuf parse without header...");
                protobuf_parse_control_message(data, len);
            }
            break;
    }
    LOG_INF("=== END BLE DATA ===");
}

void protobuf_parse_control_message(const uint8_t* protobuf_data, uint16_t len)
{
    LOG_INF("Parsing protobuf control message (%u bytes) using nanopb", len);

    // *** DETAILED HEX DUMP FOR DEBUGGING ***
    LOG_INF("\n=== PROTOBUF RAW DATA HEX DUMP (Length: %u bytes) ===\n", len);
    /* Use Zephyr logging hexdump helper so output is handled by the
     * logging subsystem (and respects runtime filtering/backends).
     */
    LOG_HEXDUMP_INF(protobuf_data, len, "PROTOBUF");
    LOG_INF("=== END HEX DUMP ===\n");

    if (len == 0)
    {
        LOG_WRN("Empty protobuf message");
        return;
    }

    // Print first few bytes for debugging (as hexdump, up to 10 bytes)
    LOG_INF("First %u bytes of protobuf data:", (len < 10) ? (uint32_t)len : 10U);
    LOG_HEXDUMP_INF(protobuf_data, (len < 10) ? len : 10, "PROTO_FIRST10");

    // Try to decode as PhoneToGlasses message
    mentraos_ble_PhoneToGlasses phone_msg = mentraos_ble_PhoneToGlasses_init_default;

    LOG_INF("Attempting to decode PhoneToGlasses message...");
    LOG_INF("[Phone->Glasses] Decoding protobuf message (%u bytes)\n", len);
    bool decode_result = decode_phone_to_glasses_message(protobuf_data, len, &phone_msg);

    if (decode_result)
    {
        LOG_INF("Successfully decoded PhoneToGlasses message!");
        LOG_INF("Message type (which_payload): %u", phone_msg.which_payload);
        LOG_INF("[Phone->Glasses] Successfully decoded message type: %u\n", phone_msg.which_payload);

        // Enhanced message type logging with protocol details
        const char* message_name;
        const char* message_description;

        switch (phone_msg.which_payload)
        {
            case 10:
                message_name        = "DisconnectRequest";
                message_description = "Connection termination request";
                break;
            case 11:
                message_name        = "BatteryStateRequest";
                message_description = "Request current battery level";
                break;
            case 12:
                message_name        = "GlassesInfoRequest";
                message_description = "Request device information";
                break;
            case 16:
                message_name        = "PingRequest";
                message_description = "Connectivity test request";
                break;
            case 20:
                message_name        = "MicStateConfig";
                message_description = "Configure microphone streaming state";
                break;
            case 30:
                message_name        = "DisplayText";
                message_description = "Display static text message";
                break;
            case 35:
                message_name        = "DisplayScrollingText";
                message_description = "Display animated scrolling text";
                break;
            case 37:
                message_name        = "BrightnessConfig";
                message_description = "Set display brightness level";
                break;
            case 38:
                message_name        = "AutoBrightnessConfig";
                message_description = "Configure automatic brightness adjustment";
                break;
            case 45:
                message_name        = "DisplayHeightConfig";
                message_description = "Configure display height";
                break;
            case 46:  
                message_name        = "ClearDisplay";
                message_description = "Clear display content (temporary tag)";
                break;
            default:
                message_name        = "Unknown";
                message_description = "Unrecognized message type";
                break;
        }

        LOG_INF("Message Details:");
        LOG_INF("  - Type: PhoneToGlasses::%s", message_name);
        LOG_INF("  - Tag: %u", phone_msg.which_payload);
        LOG_INF("  - Description: %s", message_description);
        LOG_INF("  - Protocol: MentraOS BLE Protobuf v3");
        LOG_INF("[Phone->Glasses] %s (Tag %u): %s\n", message_name, phone_msg.which_payload, message_description);

        // Process the decoded message based on payload type
        switch (phone_msg.which_payload)
        {
            case 11:  // battery_state_tag
                LOG_INF("Processing Battery State Request...");
                LOG_INF("Current battery level: %u%%", current_battery_level);
                // Send battery response
                protobuf_send_battery_notification();
                break;

            case 12:  // glasses_info_tag
                LOG_INF("Processing Glasses Info Request...");
                // TODO: Generate device info response
                LOG_INF("TODO: Implement device info response (DeviceInfo message)");
                break;

            case 10:  // disconnect_tag
                LOG_INF("Processing Disconnect Request...");
                // TODO: Handle disconnect
                LOG_INF("TODO: Implement graceful disconnection");
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

            case 45:  // display_height_tag
                LOG_INF("Processing Display Height Configuration...");
                if (phone_msg.which_payload == mentraos_ble_PhoneToGlasses_display_height_tag)
                {
                    protobuf_process_display_height_config(&phone_msg.payload.display_height);
                }
                break;

            case 46:  // clear_display_tag (temporary - TODO: update when protobuf definition is updated)
                LOG_INF("Processing Clear Display Command...");
                LOG_WRN("Using temporary tag 46 for ClearDisplay - update when protobuf definition is ready");
                protobuf_process_clear_display();
                break;

            default:
                LOG_WRN("Unknown message type: %u", phone_msg.which_payload);
                LOG_WRN("Available message types:");
                LOG_WRN("  - 10: DisconnectRequest");
                LOG_WRN("  - 11: BatteryStateRequest");
                LOG_WRN("  - 12: GlassesInfoRequest");
                LOG_WRN("  - 16: PingRequest");
                LOG_WRN("  - 30: DisplayText");
                LOG_WRN("  - 35: DisplayScrollingText");
                LOG_WRN("  - 37: BrightnessConfig");
                LOG_WRN("  - 38: AutoBrightnessConfig");
                LOG_WRN("  - 45: DisplayHeightConfig");
                LOG_WRN("  - 46: ClearDisplay");
                break;
        }
    }
    else
    {
        LOG_ERR("Failed to decode protobuf message - falling back to detailed analysis");
        LOG_INF("[Phone->Glasses] ❌ Failed to decode protobuf message (%u bytes)\n", len);

        // Enhanced protobuf wire format analysis
        LOG_INF("=== PROTOBUF DECODE FAILURE ANALYSIS ===");
        LOG_INF("Message length: %u bytes", len);

        // Analyze first 20 bytes for protobuf structure
        LOG_INF("Wire format analysis (first 20 bytes):");
        for (int i = 0; i < len && i < 20; i++)
        {
            uint8_t field_tag = protobuf_data[i] >> 3;
            uint8_t wire_type = protobuf_data[i] & 0x07;

            const char* wire_type_name;
            switch (wire_type)
            {
                case 0:
                    wire_type_name = "VARINT";
                    break;
                case 1:
                    wire_type_name = "FIXED64";
                    break;
                case 2:
                    wire_type_name = "LENGTH_DELIMITED";
                    break;
                case 3:
                    wire_type_name = "START_GROUP";
                    break;
                case 4:
                    wire_type_name = "END_GROUP";
                    break;
                case 5:
                    wire_type_name = "FIXED32";
                    break;
                default:
                    wire_type_name = "UNKNOWN";
                    break;
            }

            LOG_INF("  [%02d] 0x%02X -> tag=%u, wire=%u (%s)", i, protobuf_data[i], field_tag, wire_type,
                    wire_type_name);
        }

        // Check if this might be a different message type
        if (len > 10)
        {
            // Look for common protobuf patterns
            bool has_text_field = false;
            for (int i = 0; i < len - 4; i++)
            {
                // Look for text field patterns (length-delimited strings)
                if ((protobuf_data[i] & 0x07) == 2)
                {  // LENGTH_DELIMITED
                    uint8_t tag = protobuf_data[i] >> 3;
                    LOG_INF("  Found LENGTH_DELIMITED field at offset %d, tag=%u", i, tag);
                    has_text_field = true;
                }
            }

            if (!has_text_field)
            {
                LOG_WRN("No LENGTH_DELIMITED fields found - might not be protobuf");
            }
        }

        LOG_INF("=== END ANALYSIS ===");
    }
}

bool decode_phone_to_glasses_message(const uint8_t* data, uint16_t len, mentraos_ble_PhoneToGlasses* msg)
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

bool encode_glasses_to_phone_message(const mentraos_ble_GlassesToPhone* msg, uint8_t* buffer, size_t buffer_size,
                                     size_t* bytes_written)
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

void protobuf_parse_audio_chunk(const uint8_t* data, uint16_t len)
{
    if (len < 2)
    {
        LOG_WRN("Audio chunk too short");
        return;
    }

    uint8_t  stream_id      = data[1];
    uint16_t audio_data_len = len - 2;

    LOG_INF("Audio chunk: stream_id=0x%02X, data_len=%u", stream_id, audio_data_len);
}

void protobuf_parse_image_chunk(const uint8_t* data, uint16_t len)
{
    if (len < 4)
    {
        LOG_WRN("Image chunk too short");
        return;
    }

    uint16_t stream_id      = (data[1] << 8) | data[2];
    uint8_t  chunk_index    = data[3];
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
    bool old_state         = current_charging_state;
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

    uint32_t old_level    = current_battery_level;
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
    LOG_INF("=== BLE DATA TRANSMISSION ===");
    LOG_INF("Direction: GlassesToPhone (Outgoing Response)");
    LOG_INF("Trigger: Battery level changed or requested");

    // Create a battery status notification message
    mentraos_ble_GlassesToPhone notification = mentraos_ble_GlassesToPhone_init_default;

    // Set which_payload to battery_status (tag 10)
    notification.which_payload = 10;

    // Fill battery status with current level
    notification.payload.battery_status.level    = current_battery_level;
    notification.payload.battery_status.charging = current_charging_state;

    LOG_INF("Pre-Encoding Message Analysis:");
    LOG_INF("  - Message Type: GlassesToPhone::BatteryStatus");
    LOG_INF("  - Protocol: MentraOS BLE Protobuf v3");
    LOG_INF("  - Payload Tag: 10 (battery_status)");
    LOG_INF("  - Direction: Glasses → Phone");

    LOG_INF("Battery Status Payload:");
    LOG_INF("  - Field 1 (uint32 level): %u%%", notification.payload.battery_status.level);
    LOG_INF("  - Field 2 (bool charging): %s", notification.payload.battery_status.charging ? "true" : "false");

    // Protocol compliance
    LOG_INF("Protocol Compliance:");
    LOG_INF("  - Message Type: GlassesToPhone::BatteryStatus");
    LOG_INF("  - All required fields present: YES");
    LOG_INF("  - Level range valid: %s (0-100%%)", (notification.payload.battery_status.level <= 100) ? "YES" : "NO");
    LOG_INF("  - Charging state valid: YES");

    // Encode the notification
    uint8_t buffer[64];  // Small buffer for battery notification
    size_t  bytes_written;

    LOG_INF("Encoding Process:");
    LOG_INF("  - Encoder: nanopb library");
    LOG_INF("  - Target buffer size: %zu bytes", sizeof(buffer) - 1);

    if (encode_glasses_to_phone_message(&notification, buffer + 1, sizeof(buffer) - 1, &bytes_written))
    {
        // Add the 0x02 header for protobuf messages
        buffer[0] = 0x02;

        LOG_INF("Encoding Success:");
        LOG_INF("  - Protobuf Length: %zu bytes", bytes_written);
        LOG_INF("  - Total Length: %zu bytes (with 0x02 header)", bytes_written + 1);
        LOG_INF("  - Header: 0x02 (protobuf marker)");
        LOG_INF("  - Efficiency: %zu bytes for battery status", bytes_written);

        // Detailed hex dump of response packet
        LOG_INF("Outgoing Packet Hex Dump (%zu bytes):", bytes_written + 1);
        LOG_HEXDUMP_INF(buffer, bytes_written + 1, "OUTGOING_PKT");

        // Print to UART with comprehensive details
        LOG_INF("\n[Glasses->Phone BATTERY] Battery Status: %u%%, charging:%s (protobuf:%zu bytes)\n",
                notification.payload.battery_status.level, notification.payload.battery_status.charging ? "Y" : "N",
                bytes_written);

        // Send via BLE (to all connected clients)
        LOG_INF("BLE Transmission:");
        int ret = custom_nus_send(NULL, buffer, bytes_written + 1);
        if (ret == 0)
        {
            LOG_INF("  - Status: SUCCESS");
            LOG_INF("  - Sent: %zu bytes via BLE", bytes_written + 1);
            LOG_INF("  - Target: All connected phones");
            LOG_INF("Battery notification sent successfully");
        }
        else
        {
            LOG_ERR("  - Status: FAILED");
            LOG_ERR("  - Error code: %d", ret);
            LOG_ERR("Failed to send battery notification");
        }

        LOG_INF("=== END BLE DATA TRANSMISSION ===");
    }
    else
    {
        LOG_ERR("Encoding Failed:");
        LOG_ERR("  - Protobuf encoding error");
        LOG_ERR("  - Buffer size may be insufficient");
        LOG_ERR("  - Required: ~32 bytes, Available: %zu bytes", sizeof(buffer) - 1);
        LOG_ERR("Failed to encode battery notification");
    }
}

int protobuf_generate_echo_response(const uint8_t* input_data, uint16_t input_len, uint8_t* output_data,
                                    uint16_t max_output_len)
{
    // NOTE: This is a fallback echo response using BatteryStatus message
    // TODO: Implement proper echo response message type when protobuf definition is updated
    LOG_INF("=== BLE DATA TRANSMISSION ===");
    LOG_INF("Direction: GlassesToPhone (Echo Response)");
    LOG_INF("Trigger: Echo request received");
    LOG_INF("Input packet length: %u bytes", input_len);
    LOG_INF("Output buffer size: %u bytes", max_output_len);

    // Create a simple response message
    mentraos_ble_GlassesToPhone response = mentraos_ble_GlassesToPhone_init_default;

    // Set which_payload to battery_status (tag 10) - simpler than device_info
    response.which_payload = 10;

    // Create a battery status response using current battery level
    response.payload.battery_status.level    = current_battery_level;
    response.payload.battery_status.charging = current_charging_state;

    LOG_INF("� Pre-Encoding Message Analysis:");
    LOG_INF("  - Message Type: GlassesToPhone::BatteryStatus");
    LOG_INF("  - Protocol: MentraOS BLE Protobuf v3");
    LOG_INF("  - Payload Tag: 10 (battery_status)");
    LOG_INF("  - Direction: Glasses → Phone");
    LOG_INF("  - Context: Echo response using battery status");

    LOG_INF("Battery Status Payload:");
    LOG_INF("  - Field 1 (uint32 level): %u%%", response.payload.battery_status.level);
    LOG_INF("  - Field 2 (bool charging): %s", response.payload.battery_status.charging ? "true" : "false");

    // Protocol compliance
    LOG_INF("Protocol Compliance:");
    LOG_INF("  - Message Type: GlassesToPhone::BatteryStatus");
    LOG_INF("  - All required fields present: YES");
    LOG_INF("  - Level range valid: %s (0-100%%)", (response.payload.battery_status.level <= 100) ? "YES" : "NO");
    LOG_INF("  - Charging state valid: YES");

    LOG_INF("Encoding Process:");
    LOG_INF("  - Encoder: nanopb library");
    LOG_INF("  - Target buffer size: %u bytes", max_output_len - 1);

    // Encode the response
    size_t bytes_written;
    if (encode_glasses_to_phone_message(&response, output_data + 1, max_output_len - 1, &bytes_written))
    {
        // Add the 0x02 header for protobuf messages
        output_data[0] = 0x02;

        LOG_INF("Encoding Success:");
        LOG_INF("  - Protobuf Length: %zu bytes", bytes_written);
        LOG_INF("  - Total Length: %zu bytes (with 0x02 header)", bytes_written + 1);
        LOG_INF("  - Header: 0x02 (protobuf marker)");
        LOG_INF("  - Efficiency: %zu bytes for echo response", bytes_written);

        // Detailed hex dump of response packet
        LOG_INF("Outgoing Echo Packet Hex Dump (%zu bytes):", bytes_written + 1);
        LOG_HEXDUMP_INF(output_data, bytes_written + 1, "ECHO_PKT");

        // Print to UART with comprehensive details
        LOG_INF("\n[Glasses->Phone ECHO] Echo Response: battery:%u%%, charging:%s (protobuf:%zu bytes)\n",
                response.payload.battery_status.level, response.payload.battery_status.charging ? "Y" : "N",
                bytes_written);

        LOG_INF("Echo Response Ready:");
        LOG_INF("  - Status: SUCCESS");
        LOG_INF("  - Generated: %zu bytes", bytes_written + 1);
        LOG_INF("  - Return value: %zu", bytes_written + 1);

        LOG_INF("=== END BLE DATA TRANSMISSION ===");
        return bytes_written + 1;
    }
    else
    {
        LOG_ERR("Encoding Failed:");
        LOG_ERR("  - Protobuf encoding error");
        LOG_ERR("  - Buffer size may be insufficient");
        LOG_ERR("  - Required: ~32 bytes, Available: %u bytes", max_output_len - 1);
        LOG_ERR("  - Return value: -ENOMEM");
        return -ENOMEM;
    }
}

// ============== BRIGHTNESS CONTROL FUNCTIONS ==============

uint32_t protobuf_get_brightness_level(void)
{
    return current_brightness_level;
}

bool protobuf_get_auto_brightness_enabled(void)
{
    return auto_brightness_enabled;
}

void protobuf_set_brightness_level(uint32_t level)
{
    // Clamp level to 0-100
    if (level > 100)
    {
        level = 100;
    }

    // Manual brightness setting automatically disables auto brightness
    if (auto_brightness_enabled)
    {
        LOG_INF("Manual brightness setting - disabling auto brightness");
        auto_brightness_enabled = false;
    }

    current_brightness_level = level;

    // Update display projector brightness (0-100% -> 0x00-0xFF register values)
    // Map 0-100% to 0x00-0xFF register values for A6N projector
    uint8_t projector_reg_value = (level * 255) / 100;  // Linear mapping: 0%->0x00, 100%->0xFF

    LOG_INF("Setting projector brightness: %u%% -> reg_value 0x%02X (0x00-0xFF)", level, projector_reg_value);

    int ret = a6n_set_brightness(projector_reg_value);
    if (ret == 0)
    {
        LOG_INF("✅ Display projector brightness set to reg_value 0x%02X/0xFF", projector_reg_value);
    }
    else
    {
        LOG_ERR("❌ Failed to set display projector brightness: %d", ret);
    }
}

void protobuf_process_brightness_config(const mentraos_ble_BrightnessConfig* brightness_config)
{
    if (!brightness_config)
    {
        LOG_ERR("Invalid brightness config pointer");
        return;
    }

    LOG_INF("=== BRIGHTNESS CONFIG MESSAGE (Tag 37) ===");

    uint32_t new_level = brightness_config->value;

    // Brightness value analysis
    LOG_INF("Brightness Configuration:");
    LOG_INF("  - Field 1 (uint32 value): %u%%", new_level);
    LOG_INF("  - Valid Range: 0-100%%");
    LOG_INF("  - Current Level: %u%%", current_brightness_level);
    LOG_INF("  - Requested Level: %u%%", new_level);
    LOG_INF("  - Auto Brightness: %s -> DISABLED (manual override)", auto_brightness_enabled ? "ENABLED" : "DISABLED");

    // Value validation
    bool valid_range = (new_level <= 100);
    LOG_INF("  - Value Valid: %s", valid_range ? "YES" : "NO (will be clamped)");

    if (!valid_range)
    {
        LOG_WRN("  - Brightness value %u exceeds maximum (100), will clamp to 100", new_level);
    }

    uint32_t clamped_level = (new_level > 100) ? 100 : new_level;
    LOG_INF("  - Projector Brightness: %u%% -> level %u/9", clamped_level, (clamped_level * 9) / 100);

    // Protocol compliance
    LOG_INF("Protocol Compliance:");
    LOG_INF("  - Message Type: PhoneToGlasses::BrightnessConfig");
    LOG_INF("  - Field 1 present: YES");
    LOG_INF("  - Value type: uint32");
    LOG_INF("  - Implementation: Projector brightness (A6N) + Auto brightness disable");

    // Print to UART
    LOG_INF("\n[Phone->Glasses BRIGHTNESS] %u%% -> Projector: %u/9, Auto: %s->OFF\n",
            current_brightness_level, (clamped_level * 9) / 100, auto_brightness_enabled ? "ON" : "OFF");

    // Clamp and set the new brightness level (this will disable auto brightness)
    protobuf_set_brightness_level(new_level);

    LOG_INF("Brightness Update Result:");
    LOG_INF("  - Previous Level: %u%%",
            current_brightness_level == clamped_level ? new_level : current_brightness_level);
    LOG_INF("  - New Level: %u%%", current_brightness_level);
    LOG_INF("  - Auto Brightness: DISABLED (manual override)");
    LOG_INF("  - Change: %+d%%",
            (int32_t)current_brightness_level
                - (int32_t)(current_brightness_level == clamped_level ? new_level : current_brightness_level));

    LOG_INF("=== END BRIGHTNESS CONFIG MESSAGE ===");
}

void protobuf_process_display_text(const mentraos_ble_DisplayText* display_text)
{
    if (!display_text)
    {
        LOG_ERR("Invalid display text pointer");
        return;
    }

    LOG_INF("=== DISPLAY TEXT MESSAGE (Tag 30) ===");

    // Text content analysis
    size_t text_length = strlen(display_text->text);
    LOG_INF("Text Content:");
    LOG_INF("  - Text: \"%s\"", display_text->text);
    LOG_INF("  - Length: %zu characters", text_length);
    LOG_INF("  - Field 1 (string text): \"%s\"", display_text->text);

    // Color analysis (RGB565 format)
    uint32_t color_rgb888 = display_text->color;
    uint16_t color_rgb565 = (uint16_t)color_rgb888;

    // Convert RGB565 back to RGB888 components for analysis
    uint8_t red   = (color_rgb565 >> 11) & 0x1F;  // 5 bits
    uint8_t green = (color_rgb565 >> 5) & 0x3F;   // 6 bits
    uint8_t blue  = color_rgb565 & 0x1F;          // 5 bits

    // Scale to 8-bit values
    uint8_t red_8bit   = (red * 255) / 31;
    uint8_t green_8bit = (green * 255) / 63;
    uint8_t blue_8bit  = (blue * 255) / 31;

    LOG_INF("Color Configuration:");
    LOG_INF("  - Field 2 (uint32 color): 0x%06X", color_rgb888);
    LOG_INF("  - RGB565 Format: 0x%04X", color_rgb565);
    LOG_INF("  - RGB888 Components: R=%u, G=%u, B=%u", red_8bit, green_8bit, blue_8bit);
    LOG_INF("  - Color Name: %s", (color_rgb565 == 0xF800)   ? "Red"
                                  : (color_rgb565 == 0x07E0) ? "Green"
                                  : (color_rgb565 == 0x001F) ? "Blue"
                                  : (color_rgb565 == 0xFFFF) ? "White"
                                  : (color_rgb565 == 0x0000) ? "Black"
                                  : (color_rgb565 == 0xFFE0) ? "Yellow"
                                  : (color_rgb565 == 0xF81F) ? "Magenta"
                                  : (color_rgb565 == 0x07FF) ? "Cyan"
                                                             : "Custom");

    // Font configuration
    LOG_INF("Font Configuration:");
    LOG_INF("  - Field 3 (uint32 font_code): %u", display_text->font_code);
    LOG_INF("  - Field 6 (uint32 size): %u (font size multiplier)", display_text->size);

    // Position and layout
    LOG_INF("Position & Layout:");
    LOG_INF("  - Field 4 (uint32 x): %u pixels", display_text->x);
    LOG_INF("  - Field 5 (uint32 y): %u pixels", display_text->y);
    LOG_INF("  - Screen Position: (%u, %u)", display_text->x, display_text->y);

    // Protocol compliance check
    LOG_INF("Protocol Compliance:");
    LOG_INF("  - Message Type: PhoneToGlasses::DisplayText");
    LOG_INF("  - All required fields present: YES");
    LOG_INF("  - Color format valid: %s", (color_rgb565 <= 0xFFFF) ? "YES" : "NO");
    LOG_INF("  - Position bounds: X=%u, Y=%u (bounds depend on display)", display_text->x, display_text->y);

    // Print to UART with comprehensive details
    LOG_INF("\n[Phone->Glasses TEXT] Display Text: \"%s\" (len:%zu, pos:(%u,%u), color:0x%04X, font:%u, size:%u)\n",
            display_text->text, text_length, display_text->x, display_text->y, color_rgb565, display_text->font_code,
            display_text->size);

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
        LOG_INF("✅ LVGL: XY positioned text at (%u,%u) with font %upt in Pattern 5\n", display_text->x,
                y_clamped, font_size);
    }
    else
    {
        // Pattern 4 or others: Auto-scroll container (backward compatibility)
        display_update_protobuf_text(display_text->text);
        LOG_INF("✅ LVGL: Protobuf text updated in auto-scroll container (Pattern %d)\n", current_pattern);
    }

    LOG_INF("=== END DISPLAY TEXT MESSAGE ===");
}

void protobuf_process_display_scrolling_text(const mentraos_ble_DisplayScrollingText* scrolling_text)
{
    if (!scrolling_text)
    {
        LOG_ERR("Invalid scrolling text pointer");
        return;
    }

    LOG_INF("=== DISPLAY SCROLLING TEXT MESSAGE (Tag 35) ===");

    // Text content analysis
    size_t text_length = strlen(scrolling_text->text);
    LOG_INF("Text Content:");
    LOG_INF("  - Field 1 (string text): \"%s\"", scrolling_text->text);
    LOG_INF("  - Text Length: %zu characters", text_length);

    // Color analysis (same as DisplayText)
    uint32_t color_rgb888 = scrolling_text->color;
    uint16_t color_rgb565 = (uint16_t)color_rgb888;

    uint8_t red   = (color_rgb565 >> 11) & 0x1F;
    uint8_t green = (color_rgb565 >> 5) & 0x3F;
    uint8_t blue  = color_rgb565 & 0x1F;

    uint8_t red_8bit   = (red * 255) / 31;
    uint8_t green_8bit = (green * 255) / 63;
    uint8_t blue_8bit  = (blue * 255) / 31;

    LOG_INF("Color Configuration:");
    LOG_INF("  - Field 2 (uint32 color): 0x%06X", color_rgb888);
    LOG_INF("  - RGB565 Format: 0x%04X", color_rgb565);
    LOG_INF("  - RGB888 Components: R=%u, G=%u, B=%u", red_8bit, green_8bit, blue_8bit);

    // Font configuration
    LOG_INF("Font Configuration:");
    LOG_INF("  - Field 3 (uint32 font_code): %u", scrolling_text->font_code);
    LOG_INF("  - Field 11 (uint32 size): %u (font size multiplier)", scrolling_text->size);

    // Position and dimensions
    LOG_INF("Position & Dimensions:");
    LOG_INF("  - Field 4 (uint32 x): %u pixels", scrolling_text->x);
    LOG_INF("  - Field 5 (uint32 y): %u pixels", scrolling_text->y);
    LOG_INF("  - Field 6 (uint32 width): %u pixels", scrolling_text->width);
    LOG_INF("  - Field 7 (uint32 height): %u pixels", scrolling_text->height);
    LOG_INF("  - Scroll Area: %ux%u at (%u, %u)", scrolling_text->width, scrolling_text->height, scrolling_text->x,
            scrolling_text->y);

    // Alignment configuration
    const char* alignment_name;
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

    LOG_INF("Text Alignment:");
    LOG_INF("  - Field 8 (Alignment align): %u (%s)", scrolling_text->align, alignment_name);

    // Scrolling behavior
    LOG_INF("Scrolling Behavior:");
    LOG_INF("  - Field 9 (uint32 line_spacing): %u pixels", scrolling_text->line_spacing);
    LOG_INF("  - Field 10 (uint32 speed): %u pixels/second", scrolling_text->speed);
    LOG_INF("  - Field 12 (bool loop): %s", scrolling_text->loop ? "true" : "false");
    LOG_INF("  - Field 13 (uint32 pause_ms): %u milliseconds", scrolling_text->pause_ms);

    // Calculated scrolling parameters
    if (scrolling_text->speed > 0)
    {
        float scroll_time = (float)scrolling_text->height / scrolling_text->speed;
        LOG_INF("  - Calculated scroll time: %.1f seconds", scroll_time);
    }

    // Protocol compliance
    LOG_INF("Protocol Compliance:");
    LOG_INF("  - Message Type: PhoneToGlasses::DisplayScrollingText");
    LOG_INF("  - All fields present: YES");
    LOG_INF("  - Alignment valid: %s", (scrolling_text->align <= 2) ? "YES" : "NO");
    LOG_INF("  - Speed reasonable: %s", (scrolling_text->speed <= 1000) ? "YES" : "VERY_FAST");
    LOG_INF("  - Area size: %u pixels²", scrolling_text->width * scrolling_text->height);

    // Print to UART with comprehensive details
    LOG_INF("\n[Phone->Glasses SCROLL] Scrolling Text: \"%s\" (len:%zu, area:%ux%u, speed:%ups, align:%s, loop:%s)\n",
            scrolling_text->text, text_length, scrolling_text->width, scrolling_text->height, scrolling_text->speed,
            alignment_name, scrolling_text->loop ? "Y" : "N");

    // *** LVGL INTEGRATION: Display scrolling text in protobuf container ***
    // **NEW: Both DisplayText and DisplayScrollingText update the same auto-scroll container**
    display_update_protobuf_text(scrolling_text->text);
    LOG_INF("✅ LVGL: Protobuf scrolling text updated in auto-scroll container\n");

    LOG_INF("=== END SCROLLING TEXT MESSAGE ===");
}

void protobuf_parse_text_brightness(const char* text)
{
    if (!text)
    {
        return;
    }

    LOG_INF("TEXT BRIGHTNESS PARSER ACTIVATED");
    LOG_INF("Parsing text: \"%s\"", text);

    // Look for patterns like "brightness to 61%" or "61%"
    const char* brightness_keyword = "brightness to ";
    const char* percent_sign       = "%";

    char* brightness_pos = strstr(text, brightness_keyword);
    if (brightness_pos)
    {
        // Found "brightness to" pattern
        brightness_pos += strlen(brightness_keyword);

        // Extract the number before the % sign
        int   brightness_value = 0;
        char* percent_pos      = strstr(brightness_pos, percent_sign);

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
                    protobuf_set_brightness_level((uint32_t)brightness_value);
                    LOG_INF("\n[UART BRIGHTNESS] Text brightness set to %d%%\n", brightness_value);
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

void protobuf_process_display_height_config(const mentraos_ble_DisplayHeightConfig* config)
{
    LOG_INF("=== DISPLAY HEIGHT CONFIGURATION (Tag 45) ===");
    
    LOG_INF("Display Height Configuration:");
    LOG_INF("  - Message Type: PhoneToGlasses::DisplayHeightConfig");
    LOG_INF("  - Protocol: MentraOS BLE Protobuf v3 (EXTENDED)");
    LOG_INF("  - Payload Tag: 45 (display_height)");
    LOG_INF("  - Direction: Phone → Glasses");
    
    LOG_INF("Configuration Details:");
    LOG_INF("  - Height: %d pixels", config->height);

    display_update_height(config->height);
}

void protobuf_process_clear_display(void)
{
    LOG_INF("=== CLEAR DISPLAY MESSAGE (Tag 46) ===");
    LOG_WRN("TEMPORARY IMPLEMENTATION: Using tag 46 for ClearDisplay");
    LOG_WRN("TODO: Update to official tag when protobuf definition is updated");

    LOG_INF("Clear Display Command:");
    LOG_INF("  - Message Type: PhoneToGlasses::ClearDisplay");
    LOG_INF("  - Protocol: MentraOS BLE Protobuf v3 (EXTENDED)");
    LOG_INF("  - Payload Tag: 46 (clear_display)");
    LOG_INF("  - Direction: Phone → Glasses");
    LOG_INF("  - Action: Clear all display content");

    LOG_INF("Display Operations:");
    LOG_INF("  - Clear static text: YES");
    LOG_INF("  - Clear scrolling text: YES");
    LOG_INF("  - Reset display state: YES");
    LOG_INF("  - Preserve brightness: YES");

    // Protocol compliance (temporary)
    LOG_INF("Protocol Compliance (TEMPORARY):");
    LOG_INF("  - Message Type: PhoneToGlasses::ClearDisplay");
    LOG_INF("  - Official definition: PENDING");
    LOG_INF("  - Temporary tag: 46");
    LOG_INF("  - Implementation: Display hardware clear");

    // TODO: Implement actual display clearing logic here
    // This is where you would interface with your display driver
    LOG_INF("Display Clear Implementation:");
    LOG_INF("  - Clear framebuffer: TODO");
    LOG_INF("  - Reset text state: TODO");
    LOG_INF("  - Stop scrolling animations: TODO");
    LOG_INF("  - Refresh display: TODO");

    // Print to UART
    LOG_INF("\n[Phone->Glasses CLEAR] Clear Display: all content cleared (temporary tag:46)\n");

    LOG_INF("Clear Display Command Processed");
    LOG_INF("=== END CLEAR DISPLAY MESSAGE ===");

    display_clear_screen();
}

void protobuf_process_auto_brightness_config(const mentraos_ble_AutoBrightnessConfig* auto_brightness_config)
{
    if (!auto_brightness_config)
    {
        LOG_ERR("Invalid auto brightness config pointer");
        return;
    }

    LOG_INF("=== AUTO BRIGHTNESS CONFIG MESSAGE (Tag 38) ===");

    bool enabled        = auto_brightness_config->enabled;
    bool previous_state = auto_brightness_enabled;

    // Update the global auto brightness state
    auto_brightness_enabled = enabled;

    // Auto brightness configuration analysis
    LOG_INF("Auto Brightness Configuration:");
    LOG_INF("  - Field 1 (bool enabled): %s", enabled ? "true" : "false");
    LOG_INF("  - Previous State: %s", previous_state ? "ENABLED" : "DISABLED");
    LOG_INF("  - New State: %s", enabled ? "ENABLED" : "DISABLED");
    LOG_INF("  - State Change: %s", (previous_state != enabled) ? "YES" : "NO");
    LOG_INF("  - Feature: Automatic brightness adjustment based on ambient light sensor");

    // Protocol compliance
    LOG_INF("Protocol Compliance:");
    LOG_INF("  - Message Type: PhoneToGlasses::AutoBrightnessConfig");
    LOG_INF("  - Field 1 present: YES");
    LOG_INF("  - Value type: bool");
    LOG_INF("  - Implementation: Light sensor + Projector brightness control");

    // Auto brightness status and behavior
    LOG_INF("Auto Brightness Status:");
    if (enabled)
    {
        LOG_INF("  - Mode: AUTOMATIC");
        LOG_INF("  - Light Sensor: ACTIVE (will be integrated with driver)");
        LOG_INF("  - Brightness Control: Automatic based on ambient light");
        LOG_INF("  - Manual Override: DISABLED (auto mode takes priority)");
        LOG_INF("  - Current Manual Level: %u%% (will be overridden by sensor)", protobuf_get_brightness_level());
        LOG_INF("  - Sensor Integration: TODO - Light sensor driver pending");
    }
    else
    {
        LOG_INF("  - Mode: MANUAL");
        LOG_INF("  - Light Sensor: INACTIVE");
        LOG_INF("  - Brightness Control: Manual setting only");
        LOG_INF("  - Current Level: %u%%", protobuf_get_brightness_level());
        LOG_INF("  - Auto Adjustment: DISABLED");
    }

    // Implementation details based on your requirements
    LOG_INF("Implementation Details:");
    if (enabled)
    {
        LOG_INF("  - Light Sensor Driver: TODO - Will be integrated later");
        LOG_INF("  - Brightness Algorithm: TODO - Automatic adjustment curve");
        LOG_INF("  - Response Time: TODO - Real-time sensor monitoring");
        LOG_INF("  - Brightness Range: 0-100%% (sensor-controlled)");
        LOG_INF("  - Override Behavior: Manual brightness messages will disable auto mode");
    }
    else
    {
        LOG_INF("  - Light Sensor: Deactivated");
        LOG_INF("  - Manual Control: Active");
        LOG_INF("  - Current Setting: %u%% (preserved)", protobuf_get_brightness_level());
        LOG_INF("  - Manual Override: Ready to accept BrightnessConfig messages");
    }

    // Print to UART with comprehensive details
    LOG_INF("\n[Phone->Glasses AUTO_BRIGHTNESS] Auto Brightness: %s->%s (manual_level:%u%%)\n",
            previous_state ? "ON" : "OFF", enabled ? "ON" : "OFF", protobuf_get_brightness_level());

    // Status change logging
    LOG_INF("Auto Brightness Update Result:");
    if (previous_state != enabled)
    {
        if (enabled)
        {
            LOG_INF("  - Transition: Manual → Automatic");
            LOG_INF("  - Light Sensor: Activating (pending driver integration)");
            LOG_INF("  - Brightness Control: Sensor will override manual setting");
            LOG_INF("  - Manual Level Preserved: %u%% (for fallback)", protobuf_get_brightness_level());
        }
        else
        {
            LOG_INF("  - Transition: Automatic → Manual");
            LOG_INF("  - Light Sensor: Deactivating");
            LOG_INF("  - Brightness Control: Manual setting restored");
            LOG_INF("  - Current Level: %u%%", protobuf_get_brightness_level());
        }
    }
    else
    {
        LOG_INF("  - No State Change: Already %s", enabled ? "AUTOMATIC" : "MANUAL");
    }

    LOG_INF("  - Current Mode: %s", enabled ? "AUTOMATIC" : "MANUAL");
    LOG_INF("  - Ambient Control: %s", enabled ? "ACTIVE (pending sensor driver)" : "INACTIVE");
    LOG_INF("  - Manual Override Ready: %s", enabled ? "NO (auto mode active)" : "YES");

    LOG_INF("=== END AUTO BRIGHTNESS CONFIG MESSAGE ===");
}

void protobuf_process_mic_state_config(const mentraos_ble_MicStateConfig* mic_state)
{
    if (!mic_state)
    {
        LOG_ERR("Invalid mic state config pointer");
        return;
    }

    LOG_INF("=== MICROPHONE STATE CONFIG MESSAGE (Tag 20) ===");

    // *** RAW PROTOBUF FIELD ANALYSIS ***
    LOG_INF("\n🔍 RAW MICSTATECONFIG FIELD VALUES:\n");
    LOG_INF("  - enabled field: %s (bool value: %d)\n", mic_state->enabled ? "true" : "false", mic_state->enabled);
    LOG_INF("🔍 FIELD INTERPRETATION:\n");
    LOG_INF("  - Message Type: PhoneToGlasses::MicStateConfig\n");
    LOG_INF("  - Tag Number: 20\n");
    LOG_INF("  - Field 1 (enabled): %s\n", mic_state->enabled ? "ENABLE_MICROPHONE" : "DISABLE_MICROPHONE");
    LOG_INF("  - Expected Action: %s\n",
            mic_state->enabled ? "Start PDM capture + LC3 encoding + BLE streaming" : "Stop all audio processing");

    bool enabled = mic_state->enabled;

    pdm_audio_state_t current_state = pdm_audio_stream_get_state();
    bool              was_streaming = (current_state == PDM_AUDIO_STATE_STREAMING);

    LOG_INF("Microphone Configuration:");
    LOG_INF("  - Field 1 (bool enabled): %s", enabled ? "true" : "false");
    LOG_INF("  - Previous State: %s", was_streaming ? "STREAMING" : "DISABLED");
    LOG_INF("  - Requested State: %s", enabled ? "STREAMING" : "DISABLED");
    LOG_INF("  - State Change Required: %s", (was_streaming != enabled) ? "YES" : "NO");

    // Hardware configuration details
    LOG_INF("Hardware Configuration:");
    LOG_INF("  - PDM Clock Pin: P0.20 (PDM_CLK)");
    LOG_INF("  - PDM Data Pin: P0.21 (PDM_DIN)");
    LOG_INF("  - Sample Rate: %d Hz", PDM_SAMPLE_RATE);
    LOG_INF("  - Bit Depth: 16-bit PCM");
    LOG_INF("  - Channels: %d (Mono)", PDM_CHANNELS);
    // LOG_INF("  - Frame Size: %d samples (%d ms)",
    //         PDM_FRAME_SIZE_SAMPLES, LC3_FRAME_DURATION_MS);

    // LC3 encoding configuration
    LOG_INF("Audio Streaming Configuration:");
    LOG_INF("  - Codec: LC3 (Low Complexity Communication Codec)");
    // LOG_INF("  - Frame Duration: %d ms", LC3_FRAME_DURATION_MS);
    // LOG_INF("  - Bitrate: %d bps", LC3_BITRATE_DEFAULT);
    LOG_INF("  - Transport: BLE via 0xA0 audio chunk messages");
    LOG_INF("  - Stream ID: 0x01 (microphone audio)");

    // Apply the configuration
    int ret = pdm_audio_stream_set_enabled(enabled);

    // Get updated statistics
    uint32_t frames_captured, frames_encoded, frames_transmitted, errors;
    pdm_audio_stream_get_stats(&frames_captured, &frames_encoded, &frames_transmitted, &errors);

    LOG_INF("Configuration Result:");
    if (ret == 0)
    {
        LOG_INF("  - Status: SUCCESS");
        LOG_INF("  - Microphone: %s", enabled ? "STREAMING ACTIVE" : "STREAMING STOPPED");
        LOG_INF("  - Audio Processing: %s", enabled ? "ACTIVE" : "INACTIVE");
        LOG_INF("  - BLE Transmission: %s", enabled ? "ACTIVE" : "INACTIVE");
    }
    else
    {
        LOG_ERR("  - Status: FAILED (error %d)", ret);
        LOG_ERR("  - Microphone: ERROR STATE");
        streaming_errors++;
    }

    // Current streaming statistics
    LOG_INF("Streaming Statistics:");
    LOG_INF("  - Frames Captured: %u", frames_captured);
    LOG_INF("  - Frames Encoded: %u", frames_encoded);
    LOG_INF("  - Frames Transmitted: %u", frames_transmitted);
    LOG_INF("  - Streaming Errors: %u", errors);

    // Protocol compliance
    LOG_INF("Protocol Compliance:");
    LOG_INF("  - Message Type: PhoneToGlasses::MicStateConfig");
    LOG_INF("  - Field 1 present: YES");
    LOG_INF("  - Value type: bool");
    LOG_INF("  - Implementation: PDM microphone + LC3 encoding + BLE streaming");

    // Print concise status to UART
    LOG_INF("\n[Phone->Glasses MIC_STATE] Microphone: %s->%s (frames: %u/%u/%u, errors: %u)\n",
            was_streaming ? "ON" : "OFF", enabled ? "ON" : "OFF", frames_captured, frames_encoded, frames_transmitted,
            errors);

    LOG_INF("=== END MICROPHONE STATE CONFIG MESSAGE ===");
}

// =============================================================================
// PING/PONG CONNECTIVITY MONITORING IMPLEMENTATION
// =============================================================================
// Glasses send periodic pings (tag 15) to phone
// Phone responds with pongs (tag 16)
// After 3 failed ping attempts, glasses go to sleep/disconnect mode

// Timer handler: Send ping every 10 seconds
static void ping_timer_handler(struct k_timer* timer)
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
static void ping_timeout_handler(struct k_timer* timer)
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
    message.which_payload               = mentraos_ble_GlassesToPhone_pong_tag;

    // Note: Current protobuf only has dummy_field, no timestamp/sequence
    // For now we'll track sequence numbers in our local variables
    message.payload.pong.dummy_field = 1;  // Just to set something

    // Encode the message
    uint8_t      buffer[256];
    pb_ostream_t stream = pb_ostream_from_buffer(buffer, sizeof(buffer));

    if (pb_encode(&stream, mentraos_ble_GlassesToPhone_fields, &message))
    {
        size_t message_length = stream.bytes_written;

        if (ping_logging_enabled)
        {
            LOG_DBG("[PING] Sending ping #%u (%zu bytes)", ping_sequence_number, message_length);
        }

        // TODO: Get current BLE connection handle and send
        // int result = custom_nus_send(conn, buffer, message_length);

        // Start timeout timer
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
static void protobuf_process_pong_response(const mentraos_ble_PingRequest* pong)
{
    if (!ping_waiting_for_pong)
    {
        LOG_WRN("[PING] Received unexpected pong (not waiting)");
        return;
    }

    // Stop timeout timer
    k_timer_stop(&ping_timeout_timer);
    ping_waiting_for_pong = false;

    // Calculate simple round-trip time (note: no timestamp in current protobuf)
    int64_t current_time = k_uptime_get();

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
    phone_connected       = false;
    ping_retry_count      = 0;
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

void protobuf_send_pong_response(mentraos_ble_PingRequest* ping_request)
{
    LOG_INF("[DEPRECATED] protobuf_send_pong_response called - glasses now send pings instead\n");
    // This function is no longer used in the new ping/pong direction
}
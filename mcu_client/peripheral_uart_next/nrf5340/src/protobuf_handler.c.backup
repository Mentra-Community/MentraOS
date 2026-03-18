/*
 * Copyright (c) 2024 Mentra
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <stdio.h>

#include "protobuf_handler.h"

LOG_MODULE_REGISTER(protobuf_handler, LOG_LEVEL_DBG);

void protobuf_analyze_message(const uint8_t *data, uint16_t len)
{
	if (len == 0) {
		LOG_WRN("Received empty data - ignoring");
		return;
	}

	LOG_INF("=== BLE DATA RECEIVED ===");
	LOG_INF("Received BLE data (%u bytes):", len);
	
	// Print hex dump
	for (int i = 0; i < len; i++) {
		printk("0x%02X ", data[i]);
		if ((i + 1) % 16 == 0) {
			printk("\n");
		}
	}
	if (len % 16 != 0) {
		printk("\n");
	}

	// Check if this looks like a protobuf message (starts with control header)
	uint8_t firstByte = data[0];
	switch (firstByte) {
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
		break;
	}

	// Show raw ASCII if printable
	LOG_INF("[ASCII] Raw string: \"");
	for (int i = 0; i < len; i++) {
		if (data[i] >= 32 && data[i] <= 126) {
			printk("%c", data[i]);
		} else {
			printk(".");
		}
	}
	printk("\"\n");
	LOG_INF("=== END BLE DATA ===");
}

void protobuf_parse_control_message(const uint8_t *protobuf_data, uint16_t len)
{
	LOG_INF("Parsing protobuf control message (%u bytes)", len);
	
	if (len == 0) {
		LOG_WRN("Empty protobuf message");
		return;
	}

	// Basic protobuf field parsing - this is simplified
	// In a real implementation, you'd use nanopb or similar
	for (int i = 0; i < len && i < 10; i++) {
		uint8_t field_tag = protobuf_data[i] >> 3;
		uint8_t wire_type = protobuf_data[i] & 0x07;
		
		LOG_DBG("Protobuf field: tag=%u, wire_type=%u", field_tag, wire_type);
		
		if (field_tag == 1 && wire_type == 2) { // msg_id field (string)
			LOG_INF("Found msg_id field");
			break;
		}
	}
}

void protobuf_parse_audio_chunk(const uint8_t *data, uint16_t len)
{
	if (len < 2) {
		LOG_WRN("Audio chunk too short");
		return;
	}

	uint8_t stream_id = data[1];
	uint16_t audio_data_len = len - 2;
	
	LOG_INF("Audio chunk: stream_id=0x%02X, data_len=%u", stream_id, audio_data_len);
}

void protobuf_parse_image_chunk(const uint8_t *data, uint16_t len)
{
	if (len < 4) {
		LOG_WRN("Image chunk too short");
		return;
	}

	uint16_t stream_id = (data[1] << 8) | data[2];
	uint8_t chunk_index = data[3];
	uint16_t image_data_len = len - 4;
	
	LOG_INF("Image chunk: stream_id=0x%04X, chunk_index=%u, data_len=%u", 
		stream_id, chunk_index, image_data_len);
}

int protobuf_generate_echo_response(const uint8_t *input_data, uint16_t input_len,
				   uint8_t *output_data, uint16_t max_output_len)
{
	const char *response_template = "Echo: Received %u bytes";
	int response_len = snprintf((char *)output_data, max_output_len, 
				   response_template, input_len);
	
	if (response_len < 0 || response_len >= max_output_len) {
		LOG_ERR("Echo response too long");
		return -ENOMEM;
	}
	
	LOG_INF("Generated echo response: %s", output_data);
	return response_len;
}

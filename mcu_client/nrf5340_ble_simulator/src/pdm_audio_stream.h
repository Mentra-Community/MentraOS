/*
 * Copyright (c) 2025 Mentra
 *
 * SPDX-License-Identifier: Apache-2.0
 * 
 * PDM Audio Stream Module
 * 
 * Provides microphone input capture via PDM and LC3 audio streaming 
 * to mobile app via BLE protobuf messages.
 * 
 * HARDWARE CONFIGURATION:
 * - PDM_CLK: P1.12 (nRF5340 PDM Clock Output)  
 * - PDM_DIN: P1.11 (nRF5340 PDM Data Input)
 * - Microphone: Digital PDM microphone connected to P1.11/P1.12
 * 
 * AUDIO SPECIFICATIONS:
 * - Sample Rate: 16 kHz (optimized for voice)
 * - Bit Depth: 16-bit PCM
 * - Channels: Mono (single microphone)
 * - Frame Size: 160 samples (10ms @ 16kHz)
 * 
 * LC3 STREAMING:
 * - Codec: LC3 (Low Complexity Communication Codec)
 * - Frame Duration: 10ms
 * - Bitrate: Configurable (default optimized for voice)
 * - Transport: BLE via protobuf 0xA0 audio chunk messages
 * 
 * INTEGRATION:
 * - MicStateConfig (Tag 20): Enable/disable microphone streaming
 * - Audio Chunk (0xA0): Stream LC3-encoded audio data to mobile app
 * - Real-time streaming with minimal latency
 */

#ifndef PDM_AUDIO_STREAM_H
#define PDM_AUDIO_STREAM_H

#include <stdint.h>
#include <stdbool.h>

/* Audio configuration constants */
#define PDM_SAMPLE_RATE         16000    // 16 kHz voice optimized
#define PDM_BIT_DEPTH           16       // PCM bit depth, measured in bits
#define PDM_CHANNELS            2        // Stereo I2S microphone input (two I2S microphones)
#define PDM_FRAME_SIZE_SAMPLES  160      // 10ms frame @ 16kHz
#define PDM_FRAME_SIZE_BYTES    (PDM_FRAME_SIZE_SAMPLES * 2)  // 16-bit samples

/* LC3 encoding configuration */
#define LC3_FRAME_DURATION_US   10000    // 10ms frame duration
#define LC3_MAX_ENCODED_SIZE    100      // Maximum LC3 encoded frame size
#define LC3_BITRATE_DEFAULT     32000    // 32 kbps default bitrate
#define LC3_FRAME_LEN           (LC3_BITRATE_DEFAULT * LC3_FRAME_DURATION_US / 8 / 1000000)

/* Audio streaming state */
typedef enum {
    PDM_AUDIO_STATE_DISABLED = 0,
    PDM_AUDIO_STATE_ENABLED = 1,
    PDM_AUDIO_STATE_STREAMING = 2,
    PDM_AUDIO_STATE_ERROR = 3
} pdm_audio_state_t;

/**
 * @brief Initialize PDM audio streaming system
 * 
 * Sets up PDM driver, LC3 encoder, and audio processing thread.
 * Must be called before any other PDM audio functions.
 * 
 * @return 0 on success, negative error code on failure
 */
int pdm_audio_stream_init(void);

/**
 * @brief Start I2S only (without LC3 encoding)
 * 
 * Starts I2S hardware and sets RX callback to receive data.
 * LC3 encoding remains disabled until pdm_audio_stream_set_enabled(true) is called.
 * This function is called by VAD interrupt handler when VAD detects speech.
 * 
 * @return 0 on success, negative error code on failure
 */
int pdm_audio_stream_start_i2s_only(void);

/**
 * @brief Stop I2S only (without stopping LC3 encoding)
 * 
 * Stops I2S hardware but keeps LC3 encoder state unchanged.
 * This function is called by VAD timeout handler when VAD timeout expires.
 * 
 * @return 0 on success, negative error code on failure
 */
int pdm_audio_stream_stop_i2s_only(void);

/**
 * @brief Check if LC3 encoding is currently active
 * 
 * Returns true if LC3 encoding is enabled and active (controlled by BLE).
 * 
 * @return true if encoding is active, false otherwise
 */
bool pdm_audio_stream_is_encoding_active(void);

/**
 * @brief Enable/disable microphone audio streaming
 * 
 * Controls microphone capture and LC3 streaming to mobile app.
 * Called in response to MicStateConfig protobuf messages (Tag 20).
 * If I2S is already running (started by VAD interrupt), only starts LC3 encoding.
 * 
 * @param enabled true to start streaming, false to stop
 * @return 0 on success, negative error code on failure
 */
int pdm_audio_stream_set_enabled(bool enabled);

/**
 * @brief Get current audio streaming state
 * 
 * @return Current streaming state
 */
pdm_audio_state_t pdm_audio_stream_get_state(void);

/**
 * @brief Get current audio streaming statistics
 * 
 * Provides debugging information about streaming performance.
 * 
 * @param frames_captured Output: Number of audio frames captured
 * @param frames_encoded Output: Number of frames successfully LC3 encoded  
 * @param frames_transmitted Output: Number of frames sent via BLE
 * @param errors Output: Number of streaming errors encountered
 */
void pdm_audio_stream_get_stats(uint32_t *frames_captured, uint32_t *frames_encoded,
                                uint32_t *frames_transmitted, uint32_t *errors);

#endif /* PDM_AUDIO_STREAM_H */

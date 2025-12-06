/*
 * @Author       : Cole
 * @Date         : 2025-12-03 10:00:31
 * @LastEditTime : 2025-12-23 19:15:07
 * @FilePath     : pdm_audio_stream.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2025 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "pdm_audio_stream.h"
#include "bsp_gx8002.h"

#include <string.h>
#include <stdlib.h>
#include <limits.h>
#include <stdio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "bspal_audio_i2s.h"
#include "mentra_ble_service.h"
#include "mos_pdm.h"
#include "sw_codec_lc3.h"

// Use I2S input instead of PDM (nRF5340 as master, generating clocks for two I2S microphones)
#define USE_I2S_INPUT 1

// I2S headphone playback is enabled by default (decodes LC3 and plays to I2S headphones)
// Audio will be both sent via BLE (when connected) and played to I2S headphones
#define ENABLE_I2S_HEADPHONE_PLAYBACK 1  // I2S headphone playback (default: enabled)

// Audio channel definitions for LC3 codec
#define AUDIO_CH_L 0  // Left channel
#define AUDIO_CH_R 1  // Right channel

extern bool get_ble_connected_status(void);
int enable_audio_system(bool enable);
#define TASK_PDM_AUDIO_THREAD_PRIORITY 5
static bool audio_system_enabled = false;

LOG_MODULE_REGISTER(pdm_audio_stream, LOG_LEVEL_DBG);
extern int      ble_send_data(const uint8_t *data, uint16_t len);
extern uint16_t get_ble_payload_mtu(void);
// Simple audio streaming state
static bool     pdm_enabled        = false;
static bool     pdm_initialized    = false;
static uint32_t streaming_errors   = 0;
static uint32_t frames_transmitted = 0;
static uint16_t pcm_bytes_req_enc;
static uint8_t  frame_count = 0;  // LC3 frame counter for BLE packet batching

// I2S input support
static bool i2s_input_enabled = false;
static K_SEM_DEFINE(i2s_data_ready, 0, 1);
static int16_t i2s_rx_buffer[PDM_PCM_REQ_BUFFER_SIZE * 2];  // Stereo buffer (L/R interleaved)
static bool i2s_data_available = false;
static bool i2s_stopped_by_vad = false;  // Flag to indicate I2S was stopped by VAD timeout
// Mock audio processing thread
static K_THREAD_STACK_DEFINE(audio_thread_stack, 1024 * 6);  // Increased stack size to prevent overflow
static struct k_thread audio_thread_data;
static k_tid_t         audio_thread_tid;

#define BLE_AUDIO_HDR 0xA0
uint8_t stream_id = 0;  // 0=MIC, 1=TTS
#define BLE_AUDIO_HDR_LEN 1
#define STREAM_ID_LEN     1

#define MAX_FRAMES_PER_PACKET 5  // Maximum number of LC3 frames per BLE packet

/* ---- Drop-only mic gate (minimal pop suppression) ---- */
#ifndef MIC_WARMUP_MS
#define MIC_WARMUP_MS 200u /* Warm-up discard duration when opening microphone */
#endif
#ifndef MIC_TAIL_MS
#define MIC_TAIL_MS 80u /* Tail discard duration when closing microphone */
#endif

#define MS_TO_SAMPLES(ms) ((uint32_t)((uint64_t)(ms) * PDM_SAMPLE_RATE / 1000u))


static bool        pending_disable = false;
/* ---- ultra-short fade to remove residual clicks (8~10ms) ---- */
#ifndef MIC_FADE_MS
#define MIC_FADE_MS 8u /* Fade duration: 8~12ms are all acceptable */
#endif
#define Q15_ONE 32767
static bool           fade_in_active   = false;
static bool           fade_out_active  = false;
static uint32_t       fade_total_samp  = 0;
static uint32_t       fade_remain_samp = 0;
static inline int16_t mul_q15_sat(int16_t s, uint32_t g_q15)
{
    int32_t v = ((int32_t)s * (int32_t)g_q15) >> 15;
    if (v > 32767)
        v = 32767;
    else if (v < -32768)
        v = -32768;
    return (int16_t)v;
}
static inline void start_fade_in(void)
{
    fade_total_samp  = MS_TO_SAMPLES(MIC_FADE_MS);
    fade_remain_samp = fade_total_samp;
    fade_in_active   = true;
    fade_out_active  = false;
}
static inline void start_fade_out(void)
{
    fade_total_samp  = MS_TO_SAMPLES(MIC_FADE_MS);
    fade_remain_samp = fade_total_samp;
    fade_out_active  = true;
    fade_in_active   = false;
}
// Return: 0=not finished; 1=fade-out just finished; 2=fade-in just finished
static int apply_fade_linear_q15(int16_t *buf, size_t n)
{
    if ((!fade_in_active && !fade_out_active) || n == 0 || fade_remain_samp == 0)
        return 0;
    size_t N = (fade_remain_samp > n) ? n : fade_remain_samp;
    for (size_t i = 0; i < N; ++i)
    {
        uint32_t k = fade_total_samp - fade_remain_samp + (i + 1); /* [1..fade_total] */
        if (fade_in_active)
        {
            uint32_t g = (uint32_t)((uint64_t)k * Q15_ONE / fade_total_samp); /* 0→1 */
            buf[i]     = mul_q15_sat(buf[i], g);
        }
        else
        {                                                                                         /* fade_out_active */
            uint32_t g = (uint32_t)((uint64_t)(fade_total_samp - k) * Q15_ONE / fade_total_samp); /* 1→0 */
            buf[i]     = mul_q15_sat(buf[i], g);
        }
    }
    fade_remain_samp -= N;
    if (fade_out_active && n > N)
    {
        /* Zero the second half of the frame after fade-out to avoid tail steps */
        memset(&buf[N], 0, (n - N) * sizeof(int16_t)); 
    }
    if (fade_remain_samp == 0)
    {
        int finished   = fade_out_active ? 1 : 2;
        fade_in_active = fade_out_active = false;
        return finished;
    }
    return 0;
}

static inline uint8_t get_frames_per_packet(void)
{
    // Available space = MTU - packet header (type + stream_id)
    uint16_t payload_space = get_ble_payload_mtu() - BLE_AUDIO_HDR_LEN - STREAM_ID_LEN;
    uint8_t  frames        = payload_space / LC3_FRAME_LEN;
    if (frames > MAX_FRAMES_PER_PACKET)
    {
        frames = MAX_FRAMES_PER_PACKET;
    }
    return frames > 0 ? frames : 1;  // Minimum 1 frame
}
void send_lc3_multi_frame_packet(const uint8_t *frames, uint8_t num_frames, uint8_t stream_id)
{
    static uint8_t buf[517];
    uint16_t       offset = 0;
    memset(buf, 0, sizeof(buf));

    buf[offset++] = BLE_AUDIO_HDR;
    buf[offset++] = stream_id;

    memcpy(&buf[offset], frames, num_frames * LC3_FRAME_LEN);
    offset += num_frames * LC3_FRAME_LEN;
    
    uint16_t notify_len = offset;
    
    // Check BLE connection status - I2S is controlled by VAD interrupt, not by gx8002 enable_i2s command
    // I2S input is enabled when VAD interrupt triggers, and we're here because we have encoded data
    bool ble_connected = get_ble_connected_status();
    
    if (!ble_connected)
    {
        // BLE not connected, silently drop audio data to avoid blocking
        static uint32_t drop_count_ble = 0;
        drop_count_ble++;
        if (drop_count_ble % 1000 == 0)
        {
            LOG_DBG("Dropping audio data - BLE not connected (dropped %u packets)", drop_count_ble);
        }
        return;
    }
    
    // BLE connected and we have encoded data - send audio data
    int ret = ble_send_data(buf, notify_len);
    if (ret != 0)
    {
        // BLE send failed - drop this packet to avoid blocking audio processing
        static uint32_t send_error_count = 0;
        send_error_count++;
        if (send_error_count % 100 == 0)
        {
            LOG_WRN("BLE send failed, dropping audio packet: %d (dropped %u packets)", ret, send_error_count);
        }
        // Don't retry or block - just drop the packet and continue
    }
}

int user_sw_codec_lc3_init(void)
{
    int ret = sw_codec_lc3_init(NULL, NULL, LC3_FRAME_DURATION_US);
    return ret;
}
int lc3_encoder_start(void)
{
    int ret = sw_codec_lc3_enc_init(PDM_SAMPLE_RATE, PDM_BIT_DEPTH, LC3_FRAME_DURATION_US, LC3_BITRATE_DEFAULT,
                                    PDM_CHANNELS, &pcm_bytes_req_enc);
    if (ret < 0)
    {
        LOG_ERR("LC3 encoder initialization failed with error: %d", ret);
        return -1;
    }
    LOG_INF("LC3 encoder pcm_bytes_req_enc:%d", pcm_bytes_req_enc);
    return 0;
}
int lc3_decoder_start(void)
{
    int ret = sw_codec_lc3_dec_init(PDM_SAMPLE_RATE, PDM_BIT_DEPTH, LC3_FRAME_DURATION_US, PDM_CHANNELS);
    if (ret < 0)
    {
        LOG_ERR("LC3 decoder initialization failed with error: %d", ret);
        return -1;
    }
    LOG_INF("LC3 decoder initialized successfully");
    return 0;
}
int lc3_encoder_stop(void)
{
    int ret = sw_codec_lc3_enc_uninit_all();
    if (ret < 0)
    {
        LOG_ERR("LC3 encoder uninitialization failed with error: %d", ret);
        return -1;
    }
    LOG_INF("LC3 encoder uninitialized successfully");
    return 0;
}
int lc3_decoder_stop(void)
{
    int ret = sw_codec_lc3_dec_uninit_all();
    if (ret < 0)
    {
        LOG_ERR("LC3 decoder uninitialization failed with error: %d", ret);
        return -1;
    }
    LOG_INF("LC3 decoder uninitialized successfully");
    return 0;
}

// Forward declaration
static void i2s_rx_data_callback(const int16_t *rx_data, size_t data_size);

// Simple audio processing function
static void audio_processing_thread(void *p1, void *p2, void *p3)
{
    ARG_UNUSED(p1);
    ARG_UNUSED(p2);
    ARG_UNUSED(p3);

    LOG_INF("Audio processing thread started");
    int16_t         pcm_req_buffer[PDM_PCM_REQ_BUFFER_SIZE * 2]  = {0};  // Stereo buffer (L/R interleaved)
    uint8_t         lc3_frame_buffer[MAX_FRAMES_PER_PACKET][LC3_FRAME_LEN];
    uint8_t         max_frames_per_packet;
    
#if USE_I2S_INPUT
    LOG_INF("Using I2S input (master mode)");
    // I2S will be initialized when enable_audio_system(true) is called
#else
    pdm_init();
#endif
    user_sw_codec_lc3_init();

    while (1)
    {
        // Check if audio is enabled
        bool need_run = pdm_enabled || fade_in_active || fade_out_active;
        
        static uint32_t loop_count = 0;
        loop_count++;
        if (loop_count <= 10 || loop_count % 1000 == 0)
        {
            LOG_INF("audio_processing_thread loop #%u: need_run=%d, pdm_enabled=%d, audio_system_enabled=%d, i2s_input_enabled=%d", 
                    loop_count, need_run, pdm_enabled, audio_system_enabled, i2s_input_enabled);
        }
        
        if (need_run)
        {
            bool got_audio_data = false;
#if USE_I2S_INPUT
            // Check if I2S is enabled - if not, skip encoding (wait for I2S to restart)
            if (!i2s_input_enabled)
            {
                // I2S is stopped - do not send data to LC3 encoder
                // Wait for I2S to restart before continuing encoding
                if (pdm_enabled)
                {
                    static uint32_t skip_count = 0;
                    skip_count++;
                    if (skip_count <= 5 || skip_count % 100 == 0)
                    {
                        LOG_INF("I2S stopped - skipping LC3 encoding (waiting for I2S restart)");
                    }
                }
                // Sleep and continue loop without encoding
                k_sleep(K_MSEC(10));
                continue;
            }
            
            // Wait for I2S data (with timeout)
            int sem_result = k_sem_take(&i2s_data_ready, K_MSEC(100));
            if (sem_result == 0 && i2s_data_available)
            {
                static uint32_t process_count = 0;
                process_count++;
                if (process_count <= 5 || process_count % 100 == 0)
                {
                    LOG_INF("Processing I2S data #%u: copying %u samples", process_count, PDM_PCM_REQ_BUFFER_SIZE * 2);
                }
                memcpy(pcm_req_buffer, i2s_rx_buffer, PDM_PCM_REQ_BUFFER_SIZE * 2 * sizeof(int16_t));
                i2s_data_available = false;
                got_audio_data = true;
                // Clear VAD stop flag if we got data (I2S has been restarted)
                i2s_stopped_by_vad = false;
            } 
            else if (sem_result == 0 && !i2s_data_available)
            {
                // Semaphore was taken but data flag is false (race condition)
                static uint32_t race_count = 0;
                race_count++;
                if (race_count <= 5 || race_count % 100 == 0)
                {
                    LOG_WRN("I2S semaphore taken but data_available=false (race condition) #%u", race_count);
                }
            }
            else if (sem_result != 0) 
            {
                // Timeout waiting for data
                static uint32_t timeout_count = 0;
                timeout_count++;
                if (timeout_count <= 10 || timeout_count % 50 == 0) 
                {
                    LOG_WRN("I2S data timeout #%u (waiting for I2S microphone data)", timeout_count);
                    if (timeout_count == 10) 
                    {
                        LOG_WRN("I2S master mode: No data received. Check I2S microphone connections (SDIN, SCK, LRCK)");
                    }
                }
            }
#else
            if (!get_pdm_sample(pcm_req_buffer, PDM_PCM_REQ_BUFFER_SIZE))
            {
                got_audio_data = true;
            }
#endif
            
            if (got_audio_data)
            {
                static uint32_t encode_count = 0;
                encode_count++;
                if (encode_count <= 5 || encode_count % 100 == 0)
                {
                    LOG_INF("Starting LC3 encoding #%u", encode_count);
                }
                // Process stereo I2S input: encode left and right channels separately, then send via BLE
                size_t mono_samples_per_channel = PDM_PCM_REQ_BUFFER_SIZE;
                
                // Extract left and right channels from interleaved stereo input (L/R/L/R...)
                static int16_t left_channel[PDM_PCM_REQ_BUFFER_SIZE];
                static int16_t right_channel[PDM_PCM_REQ_BUFFER_SIZE];
                static uint8_t lc3_encoded_frame_l[LC3_FRAME_LEN];
                static uint8_t lc3_encoded_frame_r[LC3_FRAME_LEN];
                static uint16_t encoded_bytes_written_l_ch = 0;
                static uint16_t encoded_bytes_written_r_ch = 0;
                
                for (size_t i = 0; i < mono_samples_per_channel && i < PDM_PCM_REQ_BUFFER_SIZE; i++)
                {
                    left_channel[i] = pcm_req_buffer[i * 2];      // Left channel (even indices)
                    right_channel[i] = pcm_req_buffer[i * 2 + 1]; // Right channel (odd indices)
                }
                
                // Apply fade if needed
                size_t frame_samples = PDM_PCM_REQ_BUFFER_SIZE * PDM_CHANNELS;
                int fstat = apply_fade_linear_q15(pcm_req_buffer, frame_samples);
                if (fstat == 1)
                {
                    // Fade-out finished - stop encoding
                    LOG_INF("Fade-out completed");
                    pending_disable = false;
                    pdm_enabled = false;
                    frame_count = 0;
                    LOG_INF("⏹️ Audio encoding stopped after fade-out");
                    continue;
                }
                
                // Encode left channel
                int ret = sw_codec_lc3_enc_run(left_channel, mono_samples_per_channel * sizeof(int16_t), 
                                              LC3_USE_BITRATE_FROM_INIT, AUDIO_CH_L,
                                              LC3_FRAME_LEN, lc3_encoded_frame_l, &encoded_bytes_written_l_ch);
                if (ret < 0)
                {
                    LOG_ERR("LC3 encoding (L channel) failed: %d", ret);
                    continue;
                }
                
                // Encode right channel
                ret = sw_codec_lc3_enc_run(right_channel, mono_samples_per_channel * sizeof(int16_t), 
                                          LC3_USE_BITRATE_FROM_INIT, AUDIO_CH_R,
                                          LC3_FRAME_LEN, lc3_encoded_frame_r, &encoded_bytes_written_r_ch);
                if (ret < 0)
                {
                    LOG_ERR("LC3 encoding (R channel) failed: %d", ret);
                    continue;
                }
                
#if ENABLE_I2S_HEADPHONE_PLAYBACK
                // Decode LC3 and play to I2S headphones (default behavior)
                static int16_t lc3_decoded_l[PDM_PCM_REQ_BUFFER_SIZE];
                static int16_t lc3_decoded_r[PDM_PCM_REQ_BUFFER_SIZE];
                static uint16_t decoded_bytes_written_l_ch = 0;
                static uint16_t decoded_bytes_written_r_ch = 0;
                static uint32_t decode_count = 0;
                
                decode_count++;
                if (decode_count <= 5 || decode_count % 100 == 0)
                {
                    LOG_INF("Starting LC3 decoding #%u (encoded_l=%u bytes, encoded_r=%u bytes)", 
                            decode_count, encoded_bytes_written_l_ch, encoded_bytes_written_r_ch);
                }
                
                // Decode left channel
                ret = sw_codec_lc3_dec_run(lc3_encoded_frame_l, encoded_bytes_written_l_ch,
                                          sizeof(lc3_decoded_l), AUDIO_CH_L, lc3_decoded_l,
                                          &decoded_bytes_written_l_ch, false);
                if (ret < 0)
                {
                    static uint32_t decode_error_count_l = 0;
                    decode_error_count_l++;
                    if (decode_error_count_l <= 5 || decode_error_count_l % 100 == 0)
                    {
                        LOG_ERR("LC3 decoding (L channel) failed: %d (error #%u)", ret, decode_error_count_l);
                    }
                }
                else
                {
                    // Decode right channel
                    ret = sw_codec_lc3_dec_run(lc3_encoded_frame_r, encoded_bytes_written_r_ch,
                                              sizeof(lc3_decoded_r), AUDIO_CH_R, lc3_decoded_r,
                                              &decoded_bytes_written_r_ch, false);
                    if (ret < 0)
                    {
                        static uint32_t decode_error_count_r = 0;
                        decode_error_count_r++;
                        if (decode_error_count_r <= 5 || decode_error_count_r % 100 == 0)
                        {
                            LOG_ERR("LC3 decoding (R channel) failed: %d (error #%u)", ret, decode_error_count_r);
                        }
                    }
                    else
                    {
                        // Calculate samples per channel from decoded bytes
                        size_t samples_per_ch_l = decoded_bytes_written_l_ch / sizeof(int16_t);
                        size_t samples_per_ch_r = decoded_bytes_written_r_ch / sizeof(int16_t);
                        size_t samples_per_ch = (samples_per_ch_l < samples_per_ch_r) ? samples_per_ch_l : samples_per_ch_r;
                        
                        if (samples_per_ch > PDM_PCM_REQ_BUFFER_SIZE)
                        {
                            samples_per_ch = PDM_PCM_REQ_BUFFER_SIZE;
                        }
                        
                        // Play decoded audio to I2S headphones (stereo)
                        static uint32_t play_count = 0;
                        play_count++;
                        if (play_count <= 5 || play_count % 100 == 0)
                        {
                            LOG_INF("Playing to I2S headphones #%u: %u samples per channel", play_count, samples_per_ch);
                        }
                        i2s_pcm_player((void *)lc3_decoded_l, samples_per_ch, 0);   // Left channel
                        i2s_pcm_player((void *)lc3_decoded_r, samples_per_ch, 1);   // Right channel
                    }
                }
#endif  // ENABLE_I2S_HEADPHONE_PLAYBACK
                
                // Check BLE MTU before sending (only if BLE is connected)
                if (get_ble_connected_status())
                {
                    uint16_t mtu = get_ble_payload_mtu();
                    if (mtu >= (BLE_AUDIO_HDR_LEN + STREAM_ID_LEN + (LC3_FRAME_LEN * MAX_FRAMES_PER_PACKET)))
                    {
                        // Add left channel frame to buffer
                        memcpy(lc3_frame_buffer[frame_count], lc3_encoded_frame_l, LC3_FRAME_LEN);
                        frame_count++;
                        
                        // Add right channel frame to buffer
                        if (frame_count < MAX_FRAMES_PER_PACKET)
                        {
                            memcpy(lc3_frame_buffer[frame_count], lc3_encoded_frame_r, LC3_FRAME_LEN);
                            frame_count++;
                        }
                        
                        // Send packet when buffer is full or we have both channels
                        max_frames_per_packet = get_frames_per_packet();
                        if (frame_count >= max_frames_per_packet)
                        {
                            send_lc3_multi_frame_packet((uint8_t *)lc3_frame_buffer, frame_count, stream_id);
                            frame_count = 0;
                        }
                    }
                    else
                    {
                        LOG_ERR("BLE MTU is too small (%u bytes)", mtu);
                    }
                }
                
                // Small delay to yield CPU
                k_sleep(K_MSEC(1));
            }
        }
        else
        {
            // Audio system continues running even when BLE is disconnected
            // I2S headphone playback works independently of BLE connection status
            k_sleep(K_MSEC(10));
        }
    }
}

int pdm_audio_stream_init(void)
{
    if (pdm_initialized)
    {
        LOG_WRN("Audio stream already initialized");
        return 0;
    }

#if USE_I2S_INPUT
    LOG_INF("Initializing I2S audio stream (master mode)");
    audio_i2s_init();
    LOG_INF("I2S hardware initialized");
#else
    LOG_INF("Initializing PDM audio stream");
#endif

    // Create audio processing thread
    audio_thread_tid = k_thread_create(&audio_thread_data, audio_thread_stack,
                                       K_THREAD_STACK_SIZEOF(audio_thread_stack), audio_processing_thread, NULL, NULL,
                                       NULL, TASK_PDM_AUDIO_THREAD_PRIORITY, 0, K_NO_WAIT);

    if (audio_thread_tid)
    {
        k_thread_name_set(audio_thread_tid, "audio_proc");
        pdm_initialized = true;
#if USE_I2S_INPUT
        LOG_INF("I2S audio stream initialized successfully");
#else
        LOG_INF("✅ PDM audio stream initialized successfully");
#endif

#if ENABLE_I2S_HEADPHONE_PLAYBACK
        // Auto-enable audio system on startup - I2S mic will capture audio,
        // encode/decode via LC3, and play to I2S headphones by default
        // BLE transmission will start automatically when app connects
        k_sleep(K_MSEC(100));
        LOG_INF("Auto-enabling audio system: I2S mic -> LC3 encode/decode -> I2S headphones");
        pdm_audio_stream_set_enabled(true);
#endif

        return 0;
    }
    else
    {
        LOG_ERR("❌ Failed to create audio processing thread");
        return -1;
    }
}

static void i2s_rx_data_callback(const int16_t *rx_data, size_t data_size)
{
    // Check if I2S input is still enabled - if not, ignore callback
    if (!i2s_input_enabled)
    {
        return;
    }
    
    static uint32_t callback_count = 0;
    callback_count++;
    
    if (callback_count <= 5 || callback_count % 100 == 0)
    {
        LOG_INF("I2S RX callback #%u: received %u bytes (%u samples)", 
                callback_count, data_size, data_size / sizeof(int16_t));
        if (callback_count <= 3)
        {
            LOG_INF("First samples (before attenuation): L[0]=%d, R[0]=%d, L[1]=%d, R[1]=%d", 
                    rx_data[0], rx_data[1], 
                    data_size > 4 ? rx_data[2] : 0,
                    data_size > 6 ? rx_data[3] : 0);
        }
    }
    
    // Apply input attenuation to prevent saturation
    size_t sample_count = data_size / sizeof(int16_t);
    for (size_t i = 0; i < sample_count; i++)
    {
        int32_t sample = (int32_t)rx_data[i];
        sample = (sample * 2) / 3;  // Attenuation: multiply by 2/3
        i2s_rx_buffer[i] = (int16_t)sample;
    }
    
    if (callback_count <= 3)
    {
        LOG_INF("First samples (after *2/3 attenuation): L[0]=%d, R[0]=%d, L[1]=%d, R[1]=%d", 
                i2s_rx_buffer[0], i2s_rx_buffer[1], 
                sample_count > 2 ? i2s_rx_buffer[2] : 0,
                sample_count > 3 ? i2s_rx_buffer[3] : 0);
    }
    
    i2s_data_available = true;
    k_sem_give(&i2s_data_ready);
    
    if (callback_count <= 10 || callback_count % 100 == 0)
    {
        LOG_INF("i2s_rx_data_callback #%u: set data_available=true, gave semaphore, data_size=%u", 
                callback_count, data_size);
    }
}

int pdm_audio_stream_start_i2s_only(void)
{
#if USE_I2S_INPUT
    if (!i2s_input_enabled)
    {
        bool lc3_was_paused = (i2s_stopped_by_vad && pdm_enabled && audio_system_enabled);
        
        LOG_INF("Starting I2S only (no LC3 encoding) - nRF5340 generating clocks for I2S microphones");
        i2s_stopped_by_vad = false;
        audio_i2s_set_rx_callback(i2s_rx_data_callback);
        audio_i2s_start();
        i2s_input_enabled = true;
        
        if (lc3_was_paused)
        {
            LOG_INF("✅ I2S restarted - LC3 encoding will resume now that I2S is available");
        }
        else
        {
            LOG_INF("✅ I2S started (master mode) - generating clocks, ready to receive data, LC3 encoding disabled");
        }
        return 0;
    }
    else
    {
        LOG_WRN("I2S already enabled");
        i2s_stopped_by_vad = false;
        return 0;
    }
#else
    LOG_ERR("I2S input not enabled in build configuration");
    return -ENOTSUP;
#endif
}

int pdm_audio_stream_stop_i2s_only(void)
{
#if USE_I2S_INPUT
    if (i2s_input_enabled)
    {
        bool lc3_active = pdm_enabled && audio_system_enabled;
        
        if (lc3_active)
        {
            LOG_INF("⚠️ Stopping I2S while LC3 encoding is active - encoding will pause until I2S restarts");
            i2s_stopped_by_vad = true;
        }
        
        LOG_INF("Stopping nRF5340 I2S master");
        
        i2s_input_enabled = false;
        i2s_data_available = false;
        k_sem_give(&i2s_data_ready);
        audio_i2s_set_rx_callback(NULL);
        audio_i2s_stop();
        
        LOG_INF("✅ nRF5340 I2S master stopped - LC3 encoding paused (will resume when I2S restarts)");
        return 0;
    }
    else
    {
        LOG_WRN("I2S already stopped");
        return 0;
    }
#else
    LOG_ERR("I2S input not enabled in build configuration");
    return -ENOTSUP;
#endif
}

bool pdm_audio_stream_is_encoding_active(void)
{
    return pdm_enabled && audio_system_enabled;
}

int enable_audio_system(bool enable)
{
    LOG_INF("enable_audio_system called: enable=%d, audio_system_enabled=%d", enable, audio_system_enabled);
    
    if (enable && !audio_system_enabled)
    {
        LOG_INF("Starting audio system (first time)");
#if USE_I2S_INPUT
        if (!i2s_input_enabled)
        {
            LOG_INF("Setting I2S RX callback and starting I2S");
            audio_i2s_set_rx_callback(i2s_rx_data_callback);
            LOG_INF("Starting I2S in master mode - generating clocks for I2S microphones");
            audio_i2s_start();
            i2s_input_enabled = true;
            LOG_INF("I2S input started (master mode) - generating clocks, ready to receive data from I2S microphones");
        }
        else
        {
            LOG_WRN("I2S input already enabled, skipping start");
        }
#else
        pdm_start();
#endif
        lc3_encoder_start();
#if ENABLE_I2S_HEADPHONE_PLAYBACK
        lc3_decoder_start();
#endif

        audio_system_enabled = true;
        LOG_INF("Started audio streaming");
        LOG_INF("Audio system fully enabled: I2S=%d, Encoder=%d", i2s_input_enabled, audio_system_enabled);
    }
    else if (enable && audio_system_enabled)
    {
        LOG_INF("Audio system already enabled, restarting encoder");
#if USE_I2S_INPUT
        if (!i2s_input_enabled)
        {
            LOG_WRN("I2S was stopped, restarting...");
            audio_i2s_set_rx_callback(i2s_rx_data_callback);
            audio_i2s_start();
            i2s_input_enabled = true;
            LOG_INF("I2S restarted");
        }
        else
        {
            LOG_INF("I2S already running");
        }
#endif
        lc3_encoder_start();
        LOG_INF("Encoder restarted");
    }
    else if (!enable && audio_system_enabled)
    {
        LOG_INF("Stopping audio system");
#if USE_I2S_INPUT
        if (i2s_input_enabled)
        {
            LOG_INF("Stopping I2S input to save power");
            i2s_input_enabled = false;
            i2s_data_available = false;
            audio_i2s_set_rx_callback(NULL);
            audio_i2s_stop();
            LOG_INF("⏹️ I2S input stopped");
        }
#else
        pdm_stop();
#endif
        lc3_encoder_stop();
#if ENABLE_I2S_HEADPHONE_PLAYBACK
        lc3_decoder_stop();
#endif

        audio_system_enabled = false;
        LOG_INF("⏹️ Stopped audio streaming");
    }
    return 0;
}

int pdm_audio_stream_set_enabled(bool enabled)
{
    if (!pdm_initialized)
    {
        LOG_ERR("❌ PDM audio stream not initialized");
        return -ENODEV;
    }

    if (enabled)
    {
        LOG_INF("Enabling microphone streaming");
        LOG_INF("Current state: pdm_enabled=%d, audio_system_enabled=%d, i2s_input_enabled=%d", 
                pdm_enabled, audio_system_enabled, i2s_input_enabled);
        
        if (i2s_input_enabled)
        {
            LOG_INF("I2S already running (started by VAD interrupt) - ensuring callback and starting LC3 encoder");
            audio_i2s_set_rx_callback(i2s_rx_data_callback);
            
            int ret = lc3_encoder_start();
            if (ret < 0)
            {
                LOG_ERR("Failed to start LC3 encoder: %d", ret);
                return ret;
            }
            
            audio_system_enabled = true;
            LOG_INF("✅ LC3 encoder started - ready to encode I2S data and send via BLE");
        }
        else
        {
            LOG_INF("I2S not running - starting I2S and LC3 encoder");
            enable_audio_system(true);
        }
        
        pdm_enabled        = true;
        pending_disable    = false;
        frames_transmitted = 0;
        streaming_errors   = 0;
        start_fade_in();
        LOG_INF("Mic enable -> start encoding (VAD always on, no warmup needed)");
        LOG_INF("After enable: pdm_enabled=%d, audio_system_enabled=%d, i2s_input_enabled=%d", 
                pdm_enabled, audio_system_enabled, i2s_input_enabled);
        return 0;
    }
    else
    {
        if (!pdm_enabled)
        {
            LOG_INF("Audio encoding already disabled");
            return 0;
        }
        
        LOG_INF("Disabling microphone streaming");
        LOG_INF("Current state: pdm_enabled=%d, audio_system_enabled=%d, i2s_input_enabled=%d", 
                pdm_enabled, audio_system_enabled, i2s_input_enabled);
        
        LOG_INF("Stopping audio system immediately");
        enable_audio_system(false);
        
        pending_disable = false;
        pdm_enabled     = false;
        frame_count     = 0;
        LOG_INF("⏹️ Audio encoding disabled");
        return 0;
    }
}

pdm_audio_state_t pdm_audio_stream_get_state(void)
{
    if (!pdm_initialized)
    {
        return PDM_AUDIO_STATE_DISABLED;
    }
    return pdm_enabled ? PDM_AUDIO_STATE_STREAMING : PDM_AUDIO_STATE_ENABLED;
}

void pdm_audio_stream_get_stats(uint32_t *frames_captured, uint32_t *frames_encoded, uint32_t *frames_transmitted_out,
                                uint32_t *streaming_errors_out)
{
    if (frames_captured)
        *frames_captured = frames_transmitted;
    if (frames_encoded)
        *frames_encoded = frames_transmitted;
    if (frames_transmitted_out)
        *frames_transmitted_out = frames_transmitted;
    if (streaming_errors_out)
        *streaming_errors_out = streaming_errors;
}

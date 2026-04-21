#include "pdm_audio_stream.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#if CONFIG_PDM_SHELL_I2S_LOOPBACK
#include "mos_i2s_master.h"
#endif
#include "mos_ble_service.h"
#include "sw_codec_lc3.h"

extern bool get_ble_connected_status(void);
int enable_audio_system(bool enable);
#define TASK_PDM_AUDIO_THREAD_PRIORITY 5
static bool audio_system_enabled = false;

#if CONFIG_PDM_SHELL_I2S_LOOPBACK
/* Runtime control for I2S output (can be toggled via shell) */
static bool i2s_output_enabled = false;
#endif

LOG_MODULE_REGISTER(pdm_audio_stream, LOG_LEVEL_INF);
extern int ble_send_data(const uint8_t *data, uint16_t len);
extern uint16_t get_ble_payload_mtu(void);
// Simple audio streaming state
static bool     pdm_enabled        = false;
static bool     pdm_initialized    = false;
static uint32_t streaming_errors   = 0;  /* Count of streaming errors / 流传输错误计数 */
static uint32_t frames_transmitted = 0;  /* Count of transmitted frames / 已传输帧计数 */
static uint32_t frames_captured    = 0;  /* Count of captured frames / 已采集帧计数 */
static uint32_t frames_encoded     = 0;  /* Count of encoded frames / 已编码帧计数 */
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
static uint32_t frames_decoded = 0; /* LC3 decode frames fed to I2S (loopback only) */
#endif
static uint32_t packets_transmitted = 0; /* Count of BLE audio packets / BLE音频包计数 */
static uint32_t packets_send_fail   = 0; /* Count of BLE send failures / BLE发送失败计数 */
static uint16_t pcm_bytes_req_enc;
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
static bool lc3_decoder_active = false;
#endif

// Mock audio processing thread
static K_THREAD_STACK_DEFINE(audio_thread_stack, 1024 * 4);
static struct k_thread audio_thread_data;
static k_tid_t audio_thread_tid;

#define BLE_AUDIO_HDR 0xA0
uint8_t stream_id = 0;  // 0=MIC, 1=TTS
#define BLE_AUDIO_HDR_LEN 1
#define STREAM_ID_LEN 1

#define MAX_FRAMES_PER_PACKET 5  // 8 // 每个 BLE 包最多包含的 LC3 帧数;Maximum number of LC3 frames per BLE packet

/* ---- Drop-only mic gate (minimal pop suppression) ---- */
#ifndef MIC_WARMUP_MS
#define MIC_WARMUP_MS 200u /* 开麦预热丢弃时长 Warm-up discard duration */
#endif
#ifndef MIC_TAIL_MS
#define MIC_TAIL_MS 80u /* 关麦尾巴丢弃时长 Tail discard duration */
#endif

#define MS_TO_SAMPLES(ms) ((uint32_t)((uint64_t)(ms) * PDM_SAMPLE_RATE * PDM_AUDIO_CHANNELS / 1000u))

typedef enum
{
    MIC_OFF = 0,    // 关闭阶段;off phase
    MIC_DROP_WARM,  // 预热阶段;warm-up phase
    MIC_ON,         // 正常采集阶段;normal capture phase
    MIC_DROP_TAIL   // 尾巴阶段;tail phase
} mic_phase_t;
static mic_phase_t mic_phase = MIC_OFF;
static uint32_t drop_samples = 0;  // 丢弃样本计数器；Drop sample counter;
static bool pending_disable = false;
/* ---- ultra-short fade to remove residual clicks (8~10ms) ---- */
#ifndef MIC_FADE_MS
#define MIC_FADE_MS 8u /* 8~12ms 都可;8~12ms are all acceptable */
#endif
#define Q15_ONE 32767
static bool fade_in_active = false;
static bool fade_out_active = false;
static uint32_t fade_total_samp = 0;
static uint32_t fade_remain_samp = 0;
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
    fade_total_samp = MS_TO_SAMPLES(MIC_FADE_MS);
    fade_remain_samp = fade_total_samp;
    fade_in_active = true;
    fade_out_active = false;
}
/**
 * 线性淡入淡出
 * Linear fade-in/fade-out
 */
static inline void start_fade_out(void)
{
    fade_total_samp = MS_TO_SAMPLES(MIC_FADE_MS);
    fade_remain_samp = fade_total_samp;
    fade_out_active = true;
    fade_in_active = false;
}
/* 返回：0=未结束；1=淡出刚结束；2=淡入刚结束 */
// Return: 0=not finished; 1=fade-out just finished; 2=fade-in just finished
static int apply_fade_linear_q15(int16_t *buf, size_t n)
{
    if ((!fade_in_active && !fade_out_active) || n == 0 || fade_remain_samp == 0)
    {
        return 0;
    }
    size_t N = (fade_remain_samp > n) ? n : fade_remain_samp;
    for (size_t i = 0; i < N; ++i)
    {
        uint32_t k = fade_total_samp - fade_remain_samp + (i + 1); /* [1..fade_total] */
        if (fade_in_active)
        {
            uint32_t g = (uint32_t)((uint64_t)k * Q15_ONE / fade_total_samp); /* 0→1 */
            buf[i] = mul_q15_sat(buf[i], g);
        }
        else
        { /* fade_out_active */
            uint32_t g = (uint32_t)((uint64_t)(fade_total_samp - k) * Q15_ONE / fade_total_samp); /* 1→0 */
            buf[i] = mul_q15_sat(buf[i], g);
        }
    }
    fade_remain_samp -= N;
    if (fade_out_active && n > N)
    {
        /* 淡出后半帧清零，避免尾部台阶;Zero the second half of the frame after fade-out to avoid tail steps */
        memset(&buf[N], 0, (n - N) * sizeof(int16_t));
    }
    if (fade_remain_samp == 0)
    {
        int finished = fade_out_active ? 1 : 2;
        fade_in_active = fade_out_active = false;
        return finished;
    }
    return 0;
}

/* ---- Mic filter chain: DC block + simple low-pass ---- */
static int32_t dc_prev_in = 0;
static int32_t dc_prev_out = 0;
static int32_t lp_prev_out = 0;

static inline void reset_mic_filters(void)
{
    dc_prev_in = 0;
    dc_prev_out = 0;
    lp_prev_out = 0;
}

static inline int16_t apply_mic_filters(int16_t sample)
{
    const int32_t alpha_q15 = 32512; /* ~=0.995 */
    int32_t x = sample;
    int32_t hp = x - dc_prev_in + ((alpha_q15 * dc_prev_out) >> 15);
    dc_prev_in = x;
    dc_prev_out = hp;

    /* One-pole low-pass to smooth high-frequency hiss. */
    lp_prev_out += (hp - lp_prev_out) >> 3;
    int32_t filtered = lp_prev_out;

    if (filtered > 32767)
    {
        filtered = 32767;
    }
    else if (filtered < -32768)
    {
        filtered = -32768;
    }
    return (int16_t)filtered;
}

static inline size_t mix_frame_to_mono(const int16_t *input_frame, size_t input_samples, bool stereo_input,
                                       int16_t *mono_frame)
{
    pdm_channel_t channel = pdm_audio_stream_get_channel();
    size_t mono_samples = stereo_input ? (input_samples >> 1) : input_samples;

    for (size_t i = 0; i < mono_samples; ++i)
    {
        int32_t mixed = 0;

        if (stereo_input)
        {
            const int16_t left = input_frame[(i << 1) + 0];
            const int16_t right = input_frame[(i << 1) + 1];
            switch (channel)
            {
                case PDM_CHANNEL_LEFT:
                    mixed = left;
                    break;
                case PDM_CHANNEL_RIGHT:
                    mixed = right;
                    break;
                case PDM_CHANNEL_STEREO_MIXED:
                default:
                    mixed = ((int32_t)left + (int32_t)right) / 2;
                    break;
            }
        }
        else
        {
            mixed = input_frame[i];
        }

        if (mixed > 32767)
        {
            mixed = 32767;
        }
        else if (mixed < -32768)
        {
            mixed = -32768;
        }

        mono_frame[i] = apply_mic_filters((int16_t)mixed);
    }

    if (mono_samples < PDM_PCM_REQ_BUFFER_SIZE)
    {
        memset(&mono_frame[mono_samples], 0, (PDM_PCM_REQ_BUFFER_SIZE - mono_samples) * sizeof(int16_t));
    }

    return mono_samples;
}

static inline uint8_t get_frames_per_packet(void)
{
    /* Audio protocol requires fixed 5 LC3 frames per packet (202 bytes total). */
    return MAX_FRAMES_PER_PACKET;
}
static int send_lc3_multi_frame_packet(const uint8_t *frames, uint8_t num_frames, uint8_t stream_id)
{
    static uint8_t buf[517];
    uint16_t offset = 0;
    memset(buf, 0, sizeof(buf));

    buf[offset++] = BLE_AUDIO_HDR;
    buf[offset++] = stream_id;

    // frames 是连续 num_frames * LC3_FRAME_LEN 的数据
    // frames is a continuous data of num_frames * LC3_FRAME_LEN
    memcpy(&buf[offset], frames, num_frames * LC3_FRAME_LEN);
    offset += num_frames * LC3_FRAME_LEN;
    // 实际最大长度不能超过当前协商MTU的payload空间
    // The actual maximum length cannot exceed the payload space of the
    // currently negotiated MTU
    uint16_t notify_len = offset;
    int ret = ble_send_data(buf, notify_len);
    if (ret == 0)
    {
        frames_transmitted += num_frames;
        packets_transmitted++;
    }
    else
    {
        packets_send_fail++;
    }
    return ret;
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
    return 0;
}
int lc3_decoder_start(void)
{
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
    if (lc3_decoder_active)
    {
        LOG_WRN("LC3 decoder already initialized");
        return -EALREADY;
    }

    int ret = sw_codec_lc3_dec_init(PDM_SAMPLE_RATE, PDM_BIT_DEPTH, LC3_FRAME_DURATION_US, PDM_CHANNELS);
    if (ret < 0)
    {
        LOG_ERR("LC3 decoder initialization failed with error: %d", ret);
        return ret;
    }
    lc3_decoder_active = true;
    return 0;
#else
    return -ENOTSUP;
#endif
}
int lc3_encoder_stop(void)
{
    int ret = sw_codec_lc3_enc_uninit_all();
    if (ret < 0)
    {
        LOG_ERR("LC3 encoder uninitialization failed with error: %d", ret);
        return -1;
    }
    return 0;
}
int lc3_decoder_stop(void)
{
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
    if (!lc3_decoder_active)
    {
        return -EALREADY;
    }

    int ret = sw_codec_lc3_dec_uninit_all();
    if (ret < 0)
    {
        LOG_ERR("LC3 decoder uninitialization failed with error: %d", ret);
        return ret;
    }
    lc3_decoder_active = false;
    return 0;
#else
    return -ENOTSUP;
#endif
}
// Simple audio processing function
static void audio_processing_thread(void *p1, void *p2, void *p3)
{
    ARG_UNUSED(p1);
    ARG_UNUSED(p2);
    ARG_UNUSED(p3);

    int ret;
    int16_t pcm_frame_buffer[PDM_PCM_FRAME_SAMPLES] = {0};
    int16_t pcm_mono_buffer[PDM_PCM_REQ_BUFFER_SIZE] = {0};
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
    int16_t pcm_decode_buffer[PDM_PCM_REQ_BUFFER_SIZE] = {0};
#endif
    static uint16_t encoded_bytes_written_l;
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
    static uint16_t decoded_bytes_written_l;
#endif
    uint8_t lc3_frame_buffer[MAX_FRAMES_PER_PACKET][LC3_FRAME_LEN];
    uint8_t frame_count = 0;
    uint8_t max_frames_per_packet;
    pdm_init();
    user_sw_codec_lc3_init();

    while (1)
    {
        // Check if PDM audio is enabled
        bool need_run = pdm_enabled || (mic_phase == MIC_DROP_WARM) || (mic_phase == MIC_DROP_TAIL) || fade_in_active
                        || fade_out_active;
        if (need_run)
        {
            uint32_t raw_frame_samples = pdm_get_frame_samples();
            if (!get_pdm_sample(pcm_frame_buffer, raw_frame_samples))
            {
                frames_captured++; /* Count captured frames */
                bool stereo_input = (raw_frame_samples == PDM_PCM_FRAME_SAMPLES);
                size_t frame_samples =
                    mix_frame_to_mono(pcm_frame_buffer, raw_frame_samples, stereo_input, pcm_mono_buffer);
                /* 丢弃阶段：开麦预热 or 关麦尾巴，在帧边界处理 */
                // Drop phase: warm-up when opening mic or tail when closing mic, handled at frame boundary
                if (mic_phase == MIC_DROP_WARM)
                {
                    if (drop_samples > frame_samples)
                    {
                        drop_samples -= frame_samples;
                        continue;  // 整帧丢弃；drop entire frame;
                    }
                    else
                    {
                        /* ① 预热结束：若期间收到了关闭请求，则不做淡入，直接进入尾巴丢弃 */
                        // ① Warm-up ended: if a close request was received during this period, do not fade in, directly
                        // enter tail drop
                        drop_samples = 0;
                        if (pending_disable)
                        {
                            pending_disable = false; /* 消费关闭标记; consume close flag */
                            mic_phase = MIC_DROP_TAIL; /* 切到尾巴丢弃; switch to tail drop */
                            drop_samples = MS_TO_SAMPLES(MIC_TAIL_MS);
                            continue; /* 这一帧不编码; skip encoding this frame */
                        }
                        /* 正常路径：进入 ON 并开启极短淡入 */
                        // Normal path: enter ON and start ultra-short fade-in
                        mic_phase = MIC_ON;
                        start_fade_in(); /* 预热完成，开启 8ms 淡入; Warm-up complete, start 8ms fade-in */
                        continue; /* 这一帧也丢掉更稳妥，下一帧开始编码 ; it's safer to drop this frame too, start
                                     encoding from the next frame */
                    }
                }

                if (mic_phase == MIC_DROP_TAIL)
                {
                    if (drop_samples > frame_samples)
                    {
                        drop_samples -= frame_samples;
                        continue; /* 丢弃尾巴期间不编码也不发送; do not encode or send during tail drop */
                    }
                    else
                    {
                        drop_samples = 0;
                        mic_phase = MIC_OFF;
                        // 在帧边界真正停硬件并标记禁用；is actually stop hardware and mark disabled at frame boundary
                        enable_audio_system(false);
                        pdm_enabled = false;
                        pending_disable = false;
                        // 避免残留聚包; avoid residual packet aggregation;
                        frame_count = 0;
                        continue;
                    }
                }
                {
                    int fstat = apply_fade_linear_q15(pcm_mono_buffer, frame_samples);
                    if (fstat == 1)
                    {
                        /* ② 淡出刚结束：进入尾巴丢弃，并清掉待关闭标记 */
                        // ② Fade-out just ended: enter tail drop, and clear the pending close flag;
                        pending_disable = false;
                        mic_phase = MIC_DROP_TAIL;
                        drop_samples = MS_TO_SAMPLES(MIC_TAIL_MS);
                        continue; /* 这一帧已淡出为 0，不编码; this frame has faded to 0, do not encode; */
                    }
                    /* fstat == 2 (淡入结束) 或 0 (无淡变)，继续正常编码 ; fstat == 2 (fade-in ended) or 0 (no fade),
                     * continue normal encoding; */
                }

                __ASSERT_NO_MSG(pcm_bytes_req_enc == sizeof(pcm_mono_buffer));
                ret = sw_codec_lc3_enc_run(pcm_mono_buffer, sizeof(pcm_mono_buffer), LC3_USE_BITRATE_FROM_INIT, 0,
                                           LC3_FRAME_LEN, lc3_frame_buffer[frame_count], &encoded_bytes_written_l);

                if (ret < 0)
                {
                    LOG_ERR("LC3 encoding failed with error: %d", ret);
                    streaming_errors++;
                    continue;
                }

                frames_encoded++; /* Count encoded frames */

#if CONFIG_PDM_SHELL_I2S_LOOPBACK
                if (i2s_output_enabled && lc3_decoder_active)
                {
                    ret = sw_codec_lc3_dec_run(lc3_frame_buffer[frame_count], encoded_bytes_written_l,
                                                 PDM_PCM_REQ_BUFFER_SIZE * sizeof(int16_t), 0, pcm_decode_buffer,
                                                 &decoded_bytes_written_l, false);
                    if (ret < 0)
                    {
                        LOG_ERR("LC3 decoding failed with error: %d", ret);
                        streaming_errors++;
                    }
                    else
                    {
                        frames_decoded++;
                        i2s_pcm_player((void *)pcm_decode_buffer,
                                       (int16_t)(decoded_bytes_written_l / sizeof(int16_t)), 0);
                    }
                }
#endif

                uint16_t mtu = get_ble_payload_mtu();
                uint16_t min_audio_payload = BLE_AUDIO_HDR_LEN + STREAM_ID_LEN + (LC3_FRAME_LEN * MAX_FRAMES_PER_PACKET);
                if (mtu < min_audio_payload)
                {
                    continue;
                }
                frame_count++;
                max_frames_per_packet = get_frames_per_packet();
                if (frame_count >= max_frames_per_packet)
                {
                    (void)send_lc3_multi_frame_packet((uint8_t *)lc3_frame_buffer, frame_count, stream_id);
                    frame_count = 0;
                }
                k_sleep(K_MSEC(1));
            }
        }
        else
        {
            if (audio_system_enabled && !get_ble_connected_status() && mic_phase == MIC_OFF)
            {
                enable_audio_system(false);
            }
            k_sleep(K_MSEC(10));  // Sleep longer when PDM is disabled
        }
    }
}

int pdm_audio_stream_init(void)
{
    if (pdm_initialized)
    {
        LOG_WRN("⚠️ PDM audio stream already initialized");
        return 0;
    }

    LOG_INF("🔧 Initializing PDM audio stream...");

    // Create audio processing thread
    audio_thread_tid = k_thread_create(&audio_thread_data, audio_thread_stack,
                                       K_THREAD_STACK_SIZEOF(audio_thread_stack), 
                                       audio_processing_thread, 
                                       NULL, 
                                       NULL,
                                       NULL, 
                                       TASK_PDM_AUDIO_THREAD_PRIORITY, 
                                       0, 
                                       K_NO_WAIT);

    if (audio_thread_tid)
    {
        k_thread_name_set(audio_thread_tid, "audio_proc");
        pdm_initialized = true;
        LOG_INF("✅ PDM audio stream initialized successfully");
        return 0;
    }
    else
    {
        LOG_ERR("❌ Failed to create audio processing thread");
        return -1;
    }
}

int enable_audio_system(bool enable)
{
    if (enable && !audio_system_enabled)  // Start audio system
    {
        reset_mic_filters();
        pdm_start();
        lc3_encoder_start();

        audio_system_enabled = true;
    }
    else if (enable && audio_system_enabled)  // Already started / 已经启动
    {
        return -EALREADY;
    }
    else if (!enable && audio_system_enabled)  // Stop audio system
    {
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
        extern bool audio_i2s_is_initialized(void);
        extern void audio_i2s_stop(void);

        bool i2s_was_initialized = audio_i2s_is_initialized();
        if (i2s_was_initialized)
        {
            audio_i2s_stop();
        }
        if (lc3_decoder_active)
        {
            (void)lc3_decoder_stop();
        }
#endif

        pdm_stop();
        lc3_encoder_stop();

        audio_system_enabled = false;
    }
    else if (!enable && !audio_system_enabled)  // Already stopped / 已经停止
    {
        return -EALREADY;
    }
    return 0;
}
int pdm_audio_stream_set_enabled(bool enabled)
{
    if (!pdm_initialized)
    {
        return -ENODEV;
    }

    if (enabled)
    {
        if (pdm_enabled && mic_phase != MIC_OFF)
        {
            return -EALREADY;
        }

        int ret = enable_audio_system(true);
        if (ret == -EALREADY)
        {
            return -EALREADY;
        }
        if (ret < 0)
        {
            return ret;
        }

        pdm_enabled = true;
        pending_disable = false;
        mic_phase = MIC_DROP_WARM;
        drop_samples = MS_TO_SAMPLES(MIC_WARMUP_MS);

        frames_transmitted = 0;
        frames_captured = 0;
        frames_encoded = 0;
#if CONFIG_PDM_SHELL_I2S_LOOPBACK
        frames_decoded = 0;
#endif
        streaming_errors = 0;
        packets_transmitted = 0;
        packets_send_fail = 0;

        return 0;
    }

    if (!pdm_enabled && mic_phase == MIC_OFF)
    {
        return 0;
    }

    start_fade_out();
    pending_disable = true;
    return 0;
}

pdm_audio_state_t pdm_audio_stream_get_state(void)
{
    if (!pdm_initialized)
    {
        return PDM_AUDIO_STATE_DISABLED;
    }
    return pdm_enabled ? PDM_AUDIO_STATE_STREAMING : PDM_AUDIO_STATE_ENABLED;
}

void pdm_audio_stream_get_stats(uint32_t *frames_captured_out, uint32_t *frames_encoded_out,
                                uint32_t *frames_transmitted_out, uint32_t *errors_out)
{
    if (frames_captured_out)
    {
        *frames_captured_out = frames_captured;
    }
    if (frames_encoded_out)
    {
        *frames_encoded_out = frames_encoded;
    }
    if (frames_transmitted_out)
    {
        *frames_transmitted_out = frames_transmitted;
    }
    if (errors_out)
    {
        *errors_out = streaming_errors;
    }
}

#if CONFIG_PDM_SHELL_I2S_LOOPBACK
/**
 * @brief Enable/disable I2S audio output (loopback playback)
 * 启用/禁用I2S音频输出（环回播放）
 */
bool pdm_audio_get_i2s_output(void)
{
    return i2s_output_enabled;
}

int pdm_audio_set_i2s_output(bool enabled)
{
    if (enabled == i2s_output_enabled)
    {
        return 0;
    }

    if (enabled)
    {
        int ret = lc3_decoder_start();
        if (ret < 0 && ret != -EALREADY)
        {
            LOG_ERR("Failed to enable I2S loopback: LC3 decoder start error %d", ret);
            return ret;
        }
    }
    else
    {
        (void)lc3_decoder_stop();
    }

    i2s_output_enabled = enabled;
    return 0;
}
#else
bool pdm_audio_get_i2s_output(void)
{
    return false;
}

int pdm_audio_set_i2s_output(bool enabled)
{
    ARG_UNUSED(enabled);
    return -ENOTSUP;
}
#endif

int pdm_audio_stream_set_channel(pdm_channel_t channel)
{
    if (!pdm_audio_stream_is_initialized())
    {
        LOG_ERR("PDM device not initialized");
        return -ENODEV;
    }

    return pdm_set_channel(channel);
}

pdm_channel_t pdm_audio_stream_get_channel(void)
{
    return pdm_get_channel();
}

bool pdm_audio_stream_is_initialized(void)
{
    return pdm_initialized;
}

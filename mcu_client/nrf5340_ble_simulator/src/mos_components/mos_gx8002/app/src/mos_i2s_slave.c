#include "mos_i2s_slave.h"

#include <nrfx_i2s.h>
#include <string.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/pinctrl.h>
#include <zephyr/irq.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "sw_codec_lc3.h"
#include "vad_interrupt_handler.h"

/* Buffer size constant (was from pdm_audio_stream.h) */
#ifndef PDM_PCM_REQ_BUFFER_SIZE
#define PDM_PCM_REQ_BUFFER_SIZE 160
#endif

LOG_MODULE_REGISTER(mos_i2s_slave, LOG_LEVEL_INF);

#define I2S_NL DT_NODELABEL(i2s0)

#define GX8002_AUDIO_STREAM_ID 0
#define GX8002_BLE_AUDIO_HDR 0xA0
#define GX8002_FRAME_HEADER_LEN 2 /* 2-byte frame header: [0xA0, stream_id] */
#define GX8002_LC3_FRAMES_PER_PACKET 5
#define GX8002_PACKET_PAYLOAD_BYTES (GX8002_LC3_FRAMES_PER_PACKET * GX8002_LC3_FRAME_LEN) /* 5 * 40 = 200 */
#define GX8002_PACKET_TOTAL_LEN (GX8002_FRAME_HEADER_LEN + GX8002_PACKET_PAYLOAD_BYTES) /* 202 */
#define GX8002_BLE_AUDIO_HDR_LEN 1  // 1 byte header for BLE audio packet (stream ID, e.g., 0 for GX8002 mic)
#define GX8002_STREAM_ID_LEN 1
#define GX8002_PDM_SAMPLE_RATE 16000  // GX8002 PDM mic sample rate is fixed at 16 kHz
#define GX8002_PDM_BIT_DEPTH 16  // GX8002 PDM mic provides 16-bit samples (in 32-bit words, left-aligned)
#define GX8002_PDM_CHANNELS 1  // Encode mono: (L+R)/2 mix from GX8002 stereo output
#define GX8002_LC3_FRAME_DURATION_US 10000  // LC3 frame duration is 10 ms
#define GX8002_LC3_BITRATE_DEFAULT 32000  // Default LC3 bitrate for 16 kHz mono audio; can be adjusted based on quality/latency needs
#define GX8002_LC3_FRAME_LEN (GX8002_LC3_BITRATE_DEFAULT * GX8002_LC3_FRAME_DURATION_US / 8 / 1000000)

extern int ble_send_data(const uint8_t *data, uint16_t len);
extern uint16_t get_ble_payload_mtu(void);
extern bool get_ble_connected_status(void);

enum gx8002_i2s_state
{
    GX8002_I2S_UNINIT = 0,
    GX8002_I2S_IDLE,
    GX8002_I2S_STARTED,
};

static enum gx8002_i2s_state state = GX8002_I2S_UNINIT;

PINCTRL_DT_DEFINE(I2S_NL);

static nrfx_i2s_t i2s_inst = NRFX_I2S_INSTANCE(0);

static uint32_t i2s_rx_req_buffer[2][PDM_PCM_REQ_BUFFER_SIZE];
static uint32_t i2s_tx_req_buffer[2][PDM_PCM_REQ_BUFFER_SIZE];

static nrfx_i2s_config_t cfg = {
    .skip_gpio_cfg = true,
    .skip_psel_cfg = true,
    .irq_priority = DT_IRQ(I2S_NL, priority),
    .mode = NRF_I2S_MODE_SLAVE,
    .format = NRF_I2S_FORMAT_I2S,
    .alignment = NRF_I2S_ALIGN_LEFT,
    .sample_width = NRF_I2S_SWIDTH_16BIT,
    .channels = NRF_I2S_CHANNELS_STEREO,
    .enable_bypass = false,
    /* SLAVE mode: SCK and LRCK come from GX8002 master.
     * MCK must be disabled; clksrc/ratio only affect MCK output. */
    .clksrc = NRF_I2S_CLKSRC_PCLK32M,
    .mck_setup = NRF_I2S_MCK_DISABLED,
    .ratio = NRF_I2S_RATIO_32X, /* 16-bit stereo = 32 SCK/LRCK */
};

static nrfx_i2s_buffers_t const i2s_req_buffer[2] = {
    {
        .p_rx_buffer = i2s_rx_req_buffer[0],
        .p_tx_buffer = i2s_tx_req_buffer[0],
        .buffer_size = PDM_PCM_REQ_BUFFER_SIZE,
    },
    {
        .p_rx_buffer = i2s_rx_req_buffer[1],
        .p_tx_buffer = i2s_tx_req_buffer[1],
        .buffer_size = PDM_PCM_REQ_BUFFER_SIZE,
    },
};

static uint8_t current_buffer_index = 0;

typedef struct
{
    uint32_t words[PDM_PCM_REQ_BUFFER_SIZE];
} gx8002_raw_i2s_frame_t;

K_MSGQ_DEFINE(gx8002_raw_i2s_msgq, sizeof(gx8002_raw_i2s_frame_t), 8, 4);

static K_THREAD_STACK_DEFINE(gx8002_audio_worker_stack, 4096);
static struct k_thread gx8002_audio_worker_data;
static k_tid_t gx8002_audio_worker_tid;
static bool gx8002_audio_worker_started;
static bool gx8002_lc3_core_initialized;
static bool gx8002_lc3_encoder_ready;
static uint32_t gx8002_dropped_frames;
static bool s_first_frame_pending = false;
static bool s_first_ble_sent_pending = false;
static int64_t s_last_ble_send_tick = 0;
static bool s_fade_in_pending = false;
static uint32_t s_fade_in_samples_done = 0;
#define GX8002_AUDIO_WORKER_YIELD_MS 1U
/* Skip the first N I2S frames after VAD trigger: GX8002 analog mic path needs
 * settling time (~20 ms) after transitioning from idle to active. The initial
 * samples contain transients/steps that corrupt the LC3 encoder output and cause
 * audible noise at the receiver. Two 10 ms frames are discarded as a safe margin. */
#define GX8002_WARMUP_FRAMES 13
static uint8_t s_warmup_frames_remaining = 0;

#define GX8002_FADE_IN_MS 20U  // fade-in duration in milliseconds
#define GX8002_Q15_ONE 32767
#define GX8002_FADE_IN_SAMPLES ((uint32_t)((uint64_t)GX8002_FADE_IN_MS * GX8002_PDM_SAMPLE_RATE / 1000U))
#define GX8002_DC_BLOCK_SHIFT 8
static int32_t s_dc_block_prev_x = 0;
static int32_t s_dc_block_prev_y = 0;

static int gx8002_lc3_encoder_start(void)
{
    if (!gx8002_lc3_core_initialized)
    {
        int ret = sw_codec_lc3_init(NULL, NULL, GX8002_LC3_FRAME_DURATION_US);
        if (ret < 0)
        {
            LOG_ERR("GX8002 LC3 core init failed: %d", ret);
            return ret;
        }
        gx8002_lc3_core_initialized = true;
    }

    uint16_t pcm_bytes_req = 0;
    int ret = sw_codec_lc3_enc_init(GX8002_PDM_SAMPLE_RATE, GX8002_PDM_BIT_DEPTH, GX8002_LC3_FRAME_DURATION_US,
                                    GX8002_LC3_BITRATE_DEFAULT, GX8002_PDM_CHANNELS, &pcm_bytes_req);
    if (ret < 0)
    {
        LOG_ERR("GX8002 LC3 encoder init failed: %d", ret);
        return ret;
    }

    gx8002_lc3_encoder_ready = true;
    return 0;
}

static void gx8002_lc3_encoder_stop(void)
{
    if (!gx8002_lc3_encoder_ready)
    {
        return;
    }

    int ret = sw_codec_lc3_enc_uninit_all();
    if (ret < 0)
    {
        LOG_WRN("GX8002 LC3 encoder uninit failed: %d", ret);
        return;
    }

    gx8002_lc3_encoder_ready = false;
}
static int16_t gx8002_clip_i16(int32_t sample)
{
    if (sample > 32767)
    {
        return 32767;
    }
    if (sample < -32768)
    {
        return -32768;
    }
    return (int16_t)sample;
}
/**
 * @description : 对单声道音频应用直流阻塞滤波，去除直流分量。
 *                Apply a DC-blocking filter to mono audio to remove DC offset.
 * @param        {int16_t} *mono_frame: 单声道音频样本缓冲区。
 *                                      Pointer to the mono audio sample buffer.
 * @param        {size_t} sample_count: 音频样本数量。
 *                                      Number of audio samples in the buffer.
 */
static void gx8002_apply_dc_blocker(int16_t *mono_frame, size_t sample_count)
{
    if (mono_frame == NULL || sample_count == 0U)
    {
        return;
    }

    for (size_t i = 0; i < sample_count; ++i)
    {
        int32_t x = mono_frame[i];
        int32_t y = x - s_dc_block_prev_x + s_dc_block_prev_y - (s_dc_block_prev_y >> GX8002_DC_BLOCK_SHIFT);

        s_dc_block_prev_x = x;
        s_dc_block_prev_y = y;
        mono_frame[i] = gx8002_clip_i16(y);
    }
}

/*
 * Fade in across multiple 10 ms LC3 frames after VAD trigger. Startup pops are
 * often caused by an amplitude step, so limiting this to one frame is too short.
 * 在语音激活后，在多个10毫秒的LC3帧中逐渐淡入。启动弹出通常是由于幅度步骤，因此将其限制为一个帧太短。
 */
static void gx8002_apply_fade_in(int16_t *mono_frame, size_t sample_count)
{
    if (!s_fade_in_pending || mono_frame == NULL || sample_count == 0U)
    {
        return;
    }

    uint32_t fade_samples = GX8002_FADE_IN_SAMPLES;
    if (fade_samples == 0U)
    {
        s_fade_in_pending = false;
        return;
    }

    for (size_t i = 0; i < sample_count && s_fade_in_samples_done < fade_samples; ++i)
    {
        uint32_t gain_q15 = (uint32_t)(((uint64_t)(s_fade_in_samples_done + 1U) * GX8002_Q15_ONE) / fade_samples);
        int32_t scaled = ((int32_t)mono_frame[i] * (int32_t)gain_q15) >> 15;
        mono_frame[i] = gx8002_clip_i16(scaled);
        s_fade_in_samples_done++;
    }

    if (s_fade_in_samples_done >= fade_samples)
    {
        s_fade_in_pending = false;
    }
}

#define GX8002_DEBUG_MTU_SKIP_LOG_INTERVAL 50U

/* Batch buffer: 5 × 40-byte LC3 frames. Send as one 202-byte packet (2-byte header + 200). */
static uint8_t gx8002_lc3_batch[GX8002_PACKET_PAYLOAD_BYTES];
static uint8_t gx8002_batch_count;

static void gx8002_send_batched_packet(void)
{
    if (gx8002_batch_count != GX8002_LC3_FRAMES_PER_PACKET)
    {
        return;
    }
    uint16_t mtu = get_ble_payload_mtu();
    if (mtu < GX8002_PACKET_TOTAL_LEN)
    {
        static uint32_t mtu_skip_count;
        mtu_skip_count++;
        if ((mtu_skip_count % GX8002_DEBUG_MTU_SKIP_LOG_INTERVAL) == 1U)
        {
            LOG_WRN("GX8002 BLE skip: mtu=%u required=%u (skip_cnt=%u)", (unsigned int)mtu,
                    (unsigned int)GX8002_PACKET_TOTAL_LEN, (unsigned int)mtu_skip_count);
        }
        gx8002_batch_count = 0;
        return;
    }
    if (!get_ble_connected_status())
    {
        gx8002_batch_count = 0;
        return;
    }

    uint8_t pkt[GX8002_PACKET_TOTAL_LEN];
    pkt[0] = GX8002_BLE_AUDIO_HDR;
    pkt[1] = GX8002_AUDIO_STREAM_ID;
    memcpy(&pkt[GX8002_FRAME_HEADER_LEN], gx8002_lc3_batch, GX8002_PACKET_PAYLOAD_BYTES);

    int send_ret = ble_send_data(pkt, GX8002_PACKET_TOTAL_LEN);
    if (send_ret == 0)
    {
        int64_t now = k_uptime_get();
        if (s_first_ble_sent_pending)
        {
            int64_t trigger_tick = vad_get_trigger_tick();
            if (trigger_tick > 0)
            {
                LOG_INF("[TIMING] VAD->BLE first 202B packet: %lld ms "
                    "(includes %d ms warmup skip + %d ms batch accumulation)",
                    now - trigger_tick, GX8002_WARMUP_FRAMES * (GX8002_LC3_FRAME_DURATION_US / 1000),
                    GX8002_LC3_FRAMES_PER_PACKET * (GX8002_LC3_FRAME_DURATION_US / 1000));
            }
            s_first_ble_sent_pending = false;
        }
        else if (s_last_ble_send_tick > 0)
        {
            // LOG_INF("[TIMING] BLE packet interval: %lld ms", now - s_last_ble_send_tick);
        }
        s_last_ble_send_tick = now;
    }
    else
    {
        static uint32_t last_send_fail_log_ts;
        uint32_t now = k_uptime_get_32();
        if (now - last_send_fail_log_ts > 5000u)
        {
            last_send_fail_log_ts = now;
            LOG_WRN("GX8002 BLE send failed (err=%d): check BLE connected and app TX notify enabled", send_ret);
        }
    }
    gx8002_batch_count = 0;
}

static inline void gx8002_audio_worker_relax(void)
{
    k_sleep(K_MSEC(GX8002_AUDIO_WORKER_YIELD_MS));
}

static void gx8002_i2s_audio_worker(void *p1, void *p2, void *p3)
{
    ARG_UNUSED(p1);
    ARG_UNUSED(p2);
    ARG_UNUSED(p3);

    gx8002_raw_i2s_frame_t raw_frame;
    int16_t mono_frame[PDM_PCM_REQ_BUFFER_SIZE];
    uint8_t lc3_frame[GX8002_LC3_FRAME_LEN];
    uint16_t encoded_bytes_written = 0;

    while (1)
    {
        if (k_msgq_get(&gx8002_raw_i2s_msgq, &raw_frame, K_FOREVER) != 0)
        {
            continue;
        }

        if (state != GX8002_I2S_STARTED || !get_ble_connected_status() || !gx8002_lc3_encoder_ready)
        {
            gx8002_audio_worker_relax();
            continue;
        }

        for (size_t i = 0; i < PDM_PCM_REQ_BUFFER_SIZE; ++i)
        {
            int16_t left = ((int16_t *)&raw_frame.words[i])[0];
            int16_t right = ((int16_t *)&raw_frame.words[i])[1];
            mono_frame[i] = (int16_t)(((int32_t)left + (int32_t)right) / 2);
        }

        gx8002_apply_dc_blocker(mono_frame, PDM_PCM_REQ_BUFFER_SIZE);

        /* Feed discarded startup frames through the DC blocker so its state
         * settles before the first LC3 frame is encoded. */
        if (s_warmup_frames_remaining > 0)
        {
            s_warmup_frames_remaining--;
            if (s_warmup_frames_remaining == 0U)
            {
                s_fade_in_pending = true;
                s_fade_in_samples_done = 0;
            }
            gx8002_audio_worker_relax();
            continue;
        }

        gx8002_apply_fade_in(mono_frame, PDM_PCM_REQ_BUFFER_SIZE);

        int ret = sw_codec_lc3_enc_run(mono_frame, sizeof(mono_frame), LC3_USE_BITRATE_FROM_INIT, 0,
                                       GX8002_LC3_FRAME_LEN, lc3_frame, &encoded_bytes_written);
        if (ret < 0 || encoded_bytes_written == 0)
        {
            LOG_ERR("GX8002 LC3 encode failed: %d", ret);
            gx8002_audio_worker_relax();
            continue;
        }
        if (encoded_bytes_written != GX8002_LC3_FRAME_LEN)
        {
            LOG_WRN("GX8002 LC3 encoded frame size mismatch: expected %u, got %u", (unsigned int)GX8002_LC3_FRAME_LEN,
                    (unsigned int)encoded_bytes_written);
            gx8002_audio_worker_relax();
            continue;
        }

        /* Accumulate into batch: 5 × 40 bytes, then send as one 202-byte packet (2-byte header + 200) */
        memcpy(&gx8002_lc3_batch[gx8002_batch_count * GX8002_LC3_FRAME_LEN], lc3_frame, GX8002_LC3_FRAME_LEN);
        gx8002_batch_count++;
        gx8002_send_batched_packet();
        gx8002_audio_worker_relax();
    }
}

static void i2s_buffer_req_evt_handle(nrfx_i2s_buffers_t const *p_released, uint32_t status)
{
    if (state != GX8002_I2S_STARTED)
    {
        return;
    }

    if (!(status & NRFX_I2S_STATUS_NEXT_BUFFERS_NEEDED) && (p_released == NULL || p_released->p_rx_buffer == NULL))
    {
        return;
    }

    uint8_t next_buffer_index = (current_buffer_index + 1) % 2;

    /* I2S TX: output silence (no local PCM5102A playback; audio goes to phone via BLE only) */
    memset(i2s_tx_req_buffer[next_buffer_index], 0, PDM_PCM_REQ_BUFFER_SIZE * sizeof(uint32_t));

    nrfx_err_t ret = nrfx_i2s_next_buffers_set(&i2s_inst, &i2s_req_buffer[next_buffer_index]);
    if (ret == NRFX_SUCCESS)
    {
        current_buffer_index = next_buffer_index;
    }

    if (p_released != NULL && p_released->p_rx_buffer != NULL)
    {
        if (s_first_frame_pending)
        {
            int64_t trigger_tick = vad_get_trigger_tick();
            if (trigger_tick > 0)
            {
                int64_t now = k_uptime_get();
                LOG_INF("[TIMING] VAD->I2S first frame: %lld ms "
                    "(next %d frames discarded as warmup)",
                    now - trigger_tick, GX8002_WARMUP_FRAMES);
            }
            s_first_frame_pending = false;
        }

        gx8002_raw_i2s_frame_t frame;
        memcpy(frame.words, p_released->p_rx_buffer, sizeof(frame.words));
        if (k_msgq_put(&gx8002_raw_i2s_msgq, &frame, K_NO_WAIT) != 0)
        {
            gx8002_dropped_frames++;
            if ((gx8002_dropped_frames % 50U) == 1U)
            {
                LOG_WRN("GX8002 I2S audio queue full, dropped=%u", (unsigned int)gx8002_dropped_frames);
            }
        }
    }
}

int gx8002_i2s_init(void)
{
    if (state != GX8002_I2S_UNINIT)
    {
        return 0;
    }

    int ret = pinctrl_apply_state(PINCTRL_DT_DEV_CONFIG_GET(I2S_NL), PINCTRL_STATE_DEFAULT);
    if (ret != 0)
    {
        return ret;
    }

    IRQ_CONNECT(DT_IRQN(I2S_NL), DT_IRQ(I2S_NL, priority), nrfx_isr, nrfx_i2s_0_irq_handler, 0);
    irq_enable(DT_IRQN(I2S_NL));

    nrfx_err_t nret = nrfx_i2s_init(&i2s_inst, &cfg, i2s_buffer_req_evt_handle);
    if (nret != NRFX_SUCCESS)
    {
        return -EIO;
    }

    if (!gx8002_audio_worker_started)
    {
        gx8002_audio_worker_tid = k_thread_create(&gx8002_audio_worker_data,
                                                    gx8002_audio_worker_stack,
                                                    K_THREAD_STACK_SIZEOF(gx8002_audio_worker_stack),
                                                    gx8002_i2s_audio_worker, 
                                                    NULL, NULL, NULL, 
                                                    5, 0, K_NO_WAIT);
        if (gx8002_audio_worker_tid != NULL)
        {
            k_thread_name_set(gx8002_audio_worker_tid, "gx8k_i2s_audio");
            gx8002_audio_worker_started = true;
        }
    }

    state = GX8002_I2S_IDLE;
    return 0;
}

int gx8002_i2s_start(void)
{
    if (state == GX8002_I2S_UNINIT)
    {
        int ret = gx8002_i2s_init();
        if (ret != 0)
        {
            return ret;
        }
    }

    if (state == GX8002_I2S_STARTED)
    {
        return 0;
    }

    k_msgq_purge(&gx8002_raw_i2s_msgq);

    memset(i2s_rx_req_buffer, 0, sizeof(i2s_rx_req_buffer));
    memset(i2s_tx_req_buffer, 0, sizeof(i2s_tx_req_buffer));
    current_buffer_index = 0;
    gx8002_dropped_frames = 0;
    gx8002_batch_count = 0;
    s_first_frame_pending = true;
    s_first_ble_sent_pending = true;
    s_last_ble_send_tick = 0;
    s_warmup_frames_remaining = GX8002_WARMUP_FRAMES;
    s_fade_in_pending = false;
    s_fade_in_samples_done = 0;
    s_dc_block_prev_x = 0;
    s_dc_block_prev_y = 0;

    int enc_ret = gx8002_lc3_encoder_start();
    if (enc_ret < 0)
    {
        return enc_ret;
    }

    nrfx_err_t ret = nrfx_i2s_start(&i2s_inst, &i2s_req_buffer[0], 0);
    if (ret != NRFX_SUCCESS)
    {
        gx8002_lc3_encoder_stop();
        return -EIO;
    }

    state = GX8002_I2S_STARTED;
    LOG_INF("GX8002 I2S started (slave)");
    return 0;
}

int gx8002_i2s_stop(void)
{
    if (state != GX8002_I2S_STARTED)
    {
        return 0;
    }

    state = GX8002_I2S_IDLE;
    nrfx_i2s_stop(&i2s_inst);
    k_msgq_purge(&gx8002_raw_i2s_msgq);
    /* Clear batch buffer and count so no residual LC3 frames from this session
     * contaminate the next session's first packet. */
    gx8002_batch_count = 0;
    memset(gx8002_lc3_batch, 0, sizeof(gx8002_lc3_batch));
    s_warmup_frames_remaining = 0;
    s_fade_in_pending = false;
    s_fade_in_samples_done = 0;
    s_dc_block_prev_x = 0;
    s_dc_block_prev_y = 0;
    gx8002_lc3_encoder_stop();
    return 0;
}

bool gx8002_i2s_is_started(void)
{
    return state == GX8002_I2S_STARTED;
}

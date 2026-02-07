/*
 * @Author       : Cole
 * @Date         : 2026-02-05 19:59:41
 * @LastEditTime : 2026-02-07 15:00:59
 * @FilePath     : mos_xbf_font.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_xbf_font.h"

#if defined(CONFIG_LVGL)

#include <pm_config.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/flash_map.h>

LOG_MODULE_REGISTER(mos_xbf_font, LOG_LEVEL_INF);

#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif

#define XBF_BASE_ADDR (PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE_ADDRESS)

/* XBF header (Lvgl Font Tool) */
typedef struct
{
    uint16_t min;
    uint16_t max;
    uint8_t  bpp;
    uint8_t  reserved[3];
} x_header_t;

typedef struct
{
    uint32_t pos;
} x_table_t;

typedef struct
{
    uint8_t adv_w;
    uint8_t box_w;
    uint8_t box_h;
    int8_t  ofs_x;
    int8_t  ofs_y;
    uint8_t r;
} glyph_dsc_t;

static x_header_t s_xbf_header;
static bool       s_xbf_ready;
static const struct flash_area* s_fa;

#ifndef MOS_XBF_LINE_HEIGHT
/* Fallback line height if we can't derive metrics from glyphs */
#define MOS_XBF_LINE_HEIGHT 18
#endif

#define XBF_FALLBACK_BUF_SIZE 4096
static uint8_t s_xbf_fallback_buf[XBF_FALLBACK_BUF_SIZE];
static lv_draw_buf_t s_xbf_draw_buf;

#ifndef CONFIG_SRAM_BASE_ADDRESS
#define CONFIG_SRAM_BASE_ADDRESS 0x20000000u
#endif
#ifndef CONFIG_SRAM_SIZE
#define CONFIG_SRAM_SIZE 512
#endif

static bool xbf_ptr_is_sram(const void* p, size_t size)
{
    if (!p)
    {
        return false;
    }

    uintptr_t addr = (uintptr_t)p;
    uintptr_t base = (uintptr_t)CONFIG_SRAM_BASE_ADDRESS;
    /* Zephyr CONFIG_SRAM_SIZE is in KiB */
    uintptr_t end  = base + ((uintptr_t)CONFIG_SRAM_SIZE * 1024u);

    if (addr < base)
    {
        return false;
    }
    if (addr > (end - size))
    {
        return false;
    }
    return true;
}

#ifndef MOS_XBF_BASELINE
/* Fallback baseline if we can't derive metrics from glyphs */
#define MOS_XBF_BASELINE 0
#endif

#ifndef MOS_XBF_OUTPUT_A8
/* Convert A4 -> A8 so LVGL SW renderer can use an A8 mask buffer. */
#define MOS_XBF_OUTPUT_A8 1
#endif

#ifndef MOS_XBF_A4_LSN_FIRST
/* A4 nibble order in the file: 1 = low nibble is left pixel, 0 = high nibble is left pixel */
#define MOS_XBF_A4_LSN_FIRST 0
#endif

static inline bool xbf_bounds_ok(uint32_t offset, uint32_t size)
{
    size_t limit = (size_t)CONFIG_FONT_STORAGE_FILE_SIZE;
    if (limit > 0 && ((size_t)offset + size) > limit)
    {
        return false;
    }
    return true;
}

static inline int xbf_read(uint32_t offset, void* buf, size_t len)
{
    if (!xbf_bounds_ok(offset, (uint32_t)len))
    {
        return -EINVAL;
    }

    if (s_fa)
    {
        return flash_area_read(s_fa, offset, buf, len);
    }

    /* Fallback to direct XIP read if flash area not available */
    const uint8_t* base = (const uint8_t*)XBF_BASE_ADDR;
    memcpy(buf, base + offset, len);
    return 0;
}

static bool xbf_read_glyph_dsc(uint32_t unicode, glyph_dsc_t* gdsc_out)
{
    if (!gdsc_out)
    {
        return false;
    }
    if (unicode < s_xbf_header.min || unicode > s_xbf_header.max)
    {
        return false;
    }

    uint32_t index = unicode - s_xbf_header.min;
    uint32_t tbl_ofs = (uint32_t)sizeof(x_header_t) + (index * sizeof(x_table_t));

    uint32_t pos;
    if (xbf_read(tbl_ofs, &pos, sizeof(uint32_t)) != 0)
    {
        return false;
    }
    if (pos == 0)
    {
        return false;
    }

    if (xbf_read(pos, gdsc_out, sizeof(glyph_dsc_t)) != 0)
    {
        return false;
    }
    return true;
}

static void xbf_update_metrics(void)
{
    /* Derive line height and baseline from a small glyph sample */
    const uint32_t sample[] = {
        0x4E2D, /* 中 */
        0x4F60, /* 你 */
        0x597D, /* 好 */
        0x6B22, /* 欢 */
        0x8FCE, /* 迎 */
        0x8FDB, /* 进 */
        0x5165, /* 入 */
        0x5F00, /* 开 */
        0x53D1, /* 发 */
        0x8005, /* 者 */
        0x6A21, /* 模 */
        0x5F0F, /* 式 */
        0x56FD, /* 国 */
        0x4EBA, /* 人 */
        0x540D, /* 名 */
        0x5171, /* 共 */
        0x548C, /* 和 */
        0x4E16, /* 世 */
        0x754C, /* 界 */
        0x0041, /* A */
        0x0067, /* g */
        0x0021, /* ! */
        0x003F, /* ? */
    };

    int16_t min_top = 32767;
    int16_t max_bottom = -32768;
    bool found = false;

    for (size_t i = 0; i < sizeof(sample) / sizeof(sample[0]); i++)
    {
        glyph_dsc_t g;
        if (!xbf_read_glyph_dsc(sample[i], &g))
        {
            continue;
        }
        int16_t top = g.ofs_y;
        int16_t bottom = (int16_t)g.ofs_y + (int16_t)g.box_h;
        if (top < min_top) min_top = top;
        if (bottom > max_bottom) max_bottom = bottom;
        found = true;
    }

    if (found && max_bottom > min_top)
    {
        /* line_height = max_bottom - min_top; baseline = -min_top */
        uint16_t line_h = (uint16_t)(max_bottom - min_top);
        int16_t base = (int16_t)(-min_top);
        if (line_h < 1) line_h = MOS_XBF_LINE_HEIGHT;

        /* Update font metrics */
        extern lv_font_t s_xbf_font;
        s_xbf_font.line_height = line_h;
        s_xbf_font.base_line = base;
        LOG_INF("XBF metrics: line_height=%u base_line=%d (top=%d bottom=%d)",
                line_h, base, min_top, max_bottom);
    }
    else
    {
        extern lv_font_t s_xbf_font;
        s_xbf_font.line_height = MOS_XBF_LINE_HEIGHT;
        s_xbf_font.base_line = MOS_XBF_BASELINE;
        LOG_WRN("XBF metrics: using fallback line_height=%u base_line=%d",
                MOS_XBF_LINE_HEIGHT, MOS_XBF_BASELINE);
    }
}

static bool xbf_init(void)
{
    if (s_xbf_ready)
    {
        return true;
    }

#if DT_NODE_EXISTS(DT_CHOSEN(nordic_pm_ext_flash))
    const struct device* dev = DEVICE_DT_GET(DT_CHOSEN(nordic_pm_ext_flash));
    if (!device_is_ready(dev))
    {
        LOG_WRN("XBF: external flash not ready");
        return false;
    }
#endif

    if (!s_fa)
    {
        int ret = flash_area_open(PM_FONT_STORAGE_ID, &s_fa);
        if (ret != 0)
        {
            LOG_ERR("XBF: flash_area_open failed: %d", ret);
            s_fa = NULL;
        }
    }

    if (xbf_read(0, &s_xbf_header, sizeof(s_xbf_header)) != 0)
    {
        LOG_ERR("XBF: header read failed");
        return false;
    }
    if (s_xbf_header.bpp == 0 || s_xbf_header.bpp > 8)
    {
        LOG_ERR("XBF: invalid bpp=%u", s_xbf_header.bpp);
        return false;
    }

    s_xbf_ready = true;
    LOG_INF("XBF ready: min=0x%04X max=0x%04X bpp=%u", s_xbf_header.min, s_xbf_header.max, s_xbf_header.bpp);
    xbf_update_metrics();
    return true;
}

static int xbf_read_bitmap(uint32_t unicode, void* out_buf, size_t out_size)
{
    if (!xbf_init())
    {
        return -EIO;
    }
    if (unicode < s_xbf_header.min || unicode > s_xbf_header.max)
    {
        return -ENOENT;
    }

    uint32_t index = unicode - s_xbf_header.min;
    uint32_t tbl_ofs = (uint32_t)sizeof(x_header_t) + (index * sizeof(x_table_t));

    uint32_t pos = 0;
    if (xbf_read(tbl_ofs, &pos, sizeof(uint32_t)) != 0)
    {
        return -EIO;
    }
    if (pos == 0)
    {
        return -ENOENT;
    }

    glyph_dsc_t gdsc;
    if (xbf_read(pos, &gdsc, sizeof(glyph_dsc_t)) != 0)
    {
        return -EIO;
    }

    uint32_t row_bits = (uint32_t)gdsc.box_w * (uint32_t)s_xbf_header.bpp;
    uint32_t row_bytes = (row_bits + 7u) / 8u;
    uint32_t size = row_bytes * (uint32_t)gdsc.box_h;
    if (size == 0 || size > out_size)
    {
        LOG_WRN("XBF: bitmap too large (size=%u, out=%zu)", size, out_size);
        return -ENOMEM;
    }

    if (xbf_read(pos + sizeof(glyph_dsc_t), out_buf, size) != 0)
    {
        return -EIO;
    }
    return (int)size;
}

static bool xbf_get_glyph_dsc(const lv_font_t* font, lv_font_glyph_dsc_t* dsc_out, uint32_t unicode,
                              uint32_t unicode_next)
{
    ARG_UNUSED(font);
    ARG_UNUSED(unicode_next);

    if (!dsc_out)
    {
        return false;
    }

    if (!xbf_init())
    {
        return false;
    }
    if (unicode < s_xbf_header.min || unicode > s_xbf_header.max)
    {
        return false;
    }

    glyph_dsc_t gdsc;
    if (!xbf_read_glyph_dsc(unicode, &gdsc))
    {
        return false;
    }

    /* LVGL v9 adv_w is in 1/16th pixels */
    dsc_out->adv_w = (uint16_t)gdsc.adv_w * 16u;
    dsc_out->box_w = gdsc.box_w;
    dsc_out->box_h = gdsc.box_h;
    dsc_out->ofs_x = gdsc.ofs_x;
    dsc_out->ofs_y = gdsc.ofs_y;

    switch (s_xbf_header.bpp)
    {
        case 1:
            dsc_out->format = LV_FONT_GLYPH_FORMAT_A1;
            break;
        case 2:
            dsc_out->format = LV_FONT_GLYPH_FORMAT_A2;
            break;
        case 4:
            dsc_out->format = MOS_XBF_OUTPUT_A8 ? LV_FONT_GLYPH_FORMAT_A8 : LV_FONT_GLYPH_FORMAT_A4;
            break;
        case 8:
            dsc_out->format = LV_FONT_GLYPH_FORMAT_A8;
            break;
        default:
            dsc_out->format = LV_FONT_GLYPH_FORMAT_A1;
            break;
    }

    dsc_out->is_placeholder = 0;
    /* We return raw glyph bitmap (A1/A2/A8 depending on bpp/conversion) */
    dsc_out->req_raw_bitmap = 0;
    dsc_out->gid.index      = unicode;
    dsc_out->resolved_font  = font;
    return true;
}

static const void* xbf_get_glyph_bitmap(lv_font_glyph_dsc_t* dsc, lv_draw_buf_t* draw_buf)
{
    if (!dsc)
    {
        return NULL;
    }

    uint32_t w = dsc->box_w;
    uint32_t h = dsc->box_h;
    if (w == 0 || h == 0)
    {
        return NULL;
    }

    uint32_t row_bits = w * (uint32_t)s_xbf_header.bpp;
    uint32_t row_bytes = (row_bits + 7u) / 8u;
    uint32_t raw_size = row_bytes * h;
    uint32_t out_size = raw_size;
    void* out_buf = NULL;
    uint32_t out_buf_size = 0;

    lv_draw_buf_t* safe_draw_buf = NULL;
    if (draw_buf && xbf_ptr_is_sram(draw_buf, sizeof(*draw_buf)))
    {
        safe_draw_buf = draw_buf;
    }

    if (s_xbf_header.bpp == 4 && MOS_XBF_OUTPUT_A8)
    {
        out_size = w * h; /* A8 output */
    }

    if (safe_draw_buf && safe_draw_buf->data &&
        xbf_ptr_is_sram(safe_draw_buf->data, out_size) &&
        out_size <= safe_draw_buf->data_size)
    {
        out_buf = safe_draw_buf->data;
        out_buf_size = safe_draw_buf->data_size;
    }
    else if (out_size <= XBF_FALLBACK_BUF_SIZE)
    {
        out_buf = s_xbf_fallback_buf;
        out_buf_size = XBF_FALLBACK_BUF_SIZE;
    }
    else
    {
        if (safe_draw_buf)
        {
            LOG_WRN("XBF: draw_buf too small need=%u have=%u", out_size, safe_draw_buf->data_size);
        }
        return NULL;
    }

    lv_color_format_t cf;
    switch (s_xbf_header.bpp)
    {
        case 1:
            cf = LV_COLOR_FORMAT_A1;
            break;
        case 2:
            cf = LV_COLOR_FORMAT_A2;
            break;
        case 4:
            cf = MOS_XBF_OUTPUT_A8 ? LV_COLOR_FORMAT_A8 : LV_COLOR_FORMAT_A4;
            break;
        case 8:
            cf = LV_COLOR_FORMAT_A8;
            break;
        default:
            cf = LV_COLOR_FORMAT_A1;
            break;
    }

    /* Initialize draw buffer for LVGL internal bookkeeping (optional) */
    lv_draw_buf_t* ret_buf = safe_draw_buf ? safe_draw_buf : &s_xbf_draw_buf;
    if (lv_draw_buf_init(ret_buf, w, h, cf, 0, out_buf, out_buf_size) != LV_RESULT_OK)
    {
        return NULL;
    }

    if (s_xbf_header.bpp == 4 && MOS_XBF_OUTPUT_A8)
    {
        static uint8_t s_xbf_raw_buf[XBF_FALLBACK_BUF_SIZE];
        if (raw_size > sizeof(s_xbf_raw_buf))
        {
            LOG_WRN("XBF: raw glyph too large %u (need %u)", (unsigned int)dsc->gid.index, (unsigned int)raw_size);
            memset(out_buf, 0, out_size);
            return ret_buf;
        }

        int read_sz = xbf_read_bitmap(dsc->gid.index, s_xbf_raw_buf, raw_size);
        if (read_sz <= 0)
        {
            memset(out_buf, 0, out_size);
            LOG_WRN("XBF: glyph read failed (u=0x%04X), returning blank", (unsigned int)dsc->gid.index);
            return ret_buf;
        }

        /* Convert A4 -> A8 */
        static const uint8_t s_opa4_table[16] = {
            0, 17, 34, 51, 68, 85, 102, 119,
            136, 153, 170, 187, 204, 221, 238, 255
        };
        uint8_t* out = (uint8_t*)out_buf;
        uint32_t px = 0;
        for (uint32_t i = 0; i < raw_size; i++)
        {
            uint8_t b = s_xbf_raw_buf[i];
            uint8_t hi = (uint8_t)(b >> 4);
            uint8_t lo = (uint8_t)(b & 0x0F);
            if (MOS_XBF_A4_LSN_FIRST)
            {
                if (px < out_size) { out[px++] = s_opa4_table[lo]; }
                if (px < out_size) { out[px++] = s_opa4_table[hi]; }
            }
            else
            {
                if (px < out_size) { out[px++] = s_opa4_table[hi]; }
                if (px < out_size) { out[px++] = s_opa4_table[lo]; }
            }
        }
    }
    else
    {
        int read_sz = xbf_read_bitmap(dsc->gid.index, out_buf, raw_size);
        if (read_sz <= 0)
        {
            /* Avoid LVGL NULL deref: return a blank glyph buffer */
            memset(out_buf, 0, out_size);
            LOG_WRN("XBF: glyph read failed (u=0x%04X), returning blank", (unsigned int)dsc->gid.index);
        }
        else if (s_xbf_header.bpp == 4 && MOS_XBF_A4_LSN_FIRST)
        {
            /* Swap nibbles so LVGL (MSN-left) interprets correctly */
            uint8_t* p = (uint8_t*)out_buf;
            for (uint32_t i = 0; i < raw_size; i++)
            {
                uint8_t b = p[i];
                p[i] = (uint8_t)((b << 4) | (b >> 4));
            }
        }
    }

    /* LVGL expects a draw buffer with mask data for SW renderer */
    return ret_buf;
}

static const lv_font_fmt_txt_dsc_t s_xbf_dsc = {
    .glyph_bitmap  = NULL,
    .glyph_dsc     = NULL,
    .cmaps         = NULL,
    .kern_dsc      = NULL,
    .kern_scale    = 0,
    .cmap_num      = 0,
    .bpp           = 4,
    .kern_classes  = 0,
    .bitmap_format = LV_FONT_FMT_TXT_PLAIN,
};

lv_font_t s_xbf_font = {
    .get_glyph_dsc    = xbf_get_glyph_dsc,
    .get_glyph_bitmap = xbf_get_glyph_bitmap,
    .line_height      = MOS_XBF_LINE_HEIGHT,
    .base_line        = MOS_XBF_BASELINE,
    .subpx            = LV_FONT_SUBPX_NONE,
    .kerning          = LV_FONT_KERNING_NONE,
    .dsc              = &s_xbf_dsc,
    .fallback         = &lv_font_montserrat_14,
    .user_data        = NULL,
};

const lv_font_t* mos_xbf_get_font(void)
{
    if (!xbf_init())
    {
        return NULL;
    }
    return &s_xbf_font;
}

#endif /* CONFIG_LVGL */

/*
 * @Author       : Cole
 * @Date         : 2026-02-05 14:53:31
 * @LastEditTime : 2026-02-26 11:34:39
 * @FilePath     : mos_binfont_lvgl.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2026
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_binfont_lvgl.h"

#if defined(CONFIG_LVGL)

#include <lvgl.h>
#include <pm_config.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/util.h>

LOG_MODULE_REGISTER(mos_binfont_lvgl, LOG_LEVEL_WRN); /* Reduce log spam from glyph callbacks */

#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif

#if defined(CONFIG_FONT_STORAGE_USE_PARTITION_2) && defined(PM_FONT_STORAGE2_ADDRESS)
#define FONT_STORAGE_XIP_ADDR (PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE2_ADDRESS)
#else
#define FONT_STORAGE_XIP_ADDR (PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE_ADDRESS)
#endif

/* Binfont头部结构（LVGL v9格式） */
typedef struct __packed
{
    uint32_t version;
    uint16_t tables_count;
    uint16_t font_size;
    uint16_t ascent;
    int16_t descent;
    uint16_t typo_ascent;
    int16_t typo_descent;
    uint16_t typo_line_gap;
    int16_t min_y;
    int16_t max_y;
    uint16_t default_advance_width;
    uint16_t kerning_scale;
    uint8_t index_to_loc_format;
    uint8_t glyph_id_format;
    uint8_t advance_width_format;
    uint8_t bits_per_pixel;
    uint8_t xy_bits;
    uint8_t wh_bits;
    uint8_t advance_width_bits;
    uint8_t compression_id;
    uint8_t subpixels_mode;
    uint8_t padding;
    int16_t underline_position;
    uint16_t underline_thickness;
} font_header_bin_t;

typedef struct __packed
{
    uint32_t data_offset;
    uint32_t range_start;
    uint16_t range_length;
    uint16_t glyph_id_start;
    uint16_t data_entries_count;
    uint8_t format_type;
    uint8_t padding;
} cmap_table_bin_t;

/* Binfont glyph描述符（简化版，从glyf表读取） */
typedef struct
{
    uint16_t adv_w;
    uint8_t box_w;
    uint8_t box_h;
    int8_t ofs_x;
    int8_t ofs_y;
} binfont_glyph_dsc_t;

/* 静态资源 */
static font_header_bin_t s_font_header;
static cmap_table_bin_t *s_cmap_tables;
static uint32_t s_cmap_count;
static uint32_t s_cmap_start_offset;
static uint32_t s_glyf_start_offset; /* glyf section 起始偏移（含 8 字节 label） */
static uint32_t s_glyf_data_offset; /* glyf section 数据起始偏移（仅 init 日志用） */
static uint32_t s_loca_start_offset; /* loca section 起始偏移 */
static uint32_t s_glyf_length; /* glyf section 总长（含 8 字节 label）= loca 边界 */
static uint32_t s_glyf_data_length; /* = s_glyf_length - 8，仅日志用 */
static uint32_t s_loca_count;
static off_t s_loca_offsets_start;
static const struct flash_area *s_fa;
static bool s_initialized = false;
static size_t s_font_size_limit;
static bool s_use_xip;

/* Glyph bitmap缓存（静态buffer） */
#define MAX_GLYPH_BITMAP_SIZE 4096 /* 64x64 @ 4bpp = 2048字节，留余量 */
static uint8_t s_glyph_bitmap_buf[MAX_GLYPH_BITMAP_SIZE];
static lv_draw_buf_t s_glyph_draw_buf;
/* Safety limits to avoid pathological glyph sizes blocking the system */
#define MAX_GLYPH_BOX_W 64
#define MAX_GLYPH_BOX_H 64

static inline int read_bytes(off_t offset, void *buf, size_t len)
{
    if (s_font_size_limit > 0 && ((size_t)offset + len) > s_font_size_limit)
    {
        return -EINVAL;
    }

    if (s_use_xip)
    {
        const uint8_t *base = (const uint8_t *)FONT_STORAGE_XIP_ADDR;
        memcpy(buf, base + offset, len);
        return 0;
    }

    return flash_area_read(s_fa, offset, buf, len);
}

/* 辅助函数：安全读取little-endian数据 */
static inline uint32_t sys_get_le32(const uint8_t *buf)
{
    return (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) | ((uint32_t)buf[2] << 16) | ((uint32_t)buf[3] << 24);
}

static inline uint16_t sys_get_le16(const uint8_t *buf)
{
    return (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
}

static int read_loca_offset(uint32_t index, uint32_t *out_offset)
{
    if (!out_offset || index >= s_loca_count)
    {
        return -EINVAL;
    }

    if (s_font_header.index_to_loc_format == 0)
    {
        uint8_t buf[2];
        if (read_bytes(s_loca_offsets_start + (off_t)(index * 2), buf, 2) != 0)
        {
            return -EIO;
        }
        /* LVGL binfont format: short loca offsets are direct byte offsets (NOT *2 like TrueType) */
        *out_offset = (uint32_t)sys_get_le16(buf);
        return 0;
    }
    else if (s_font_header.index_to_loc_format == 1)
    {
        uint8_t buf[4];
        if (read_bytes(s_loca_offsets_start + (off_t)(index * 4), buf, 4) != 0)
        {
            return -EIO;
        }
        *out_offset = sys_get_le32(buf);
        return 0;
    }

    return -EINVAL;
}

typedef struct
{
    off_t offset;
    int8_t bit_pos;
    uint8_t byte_value;
} bit_iterator_t;

static bit_iterator_t init_bit_iterator(off_t offset)
{
    bit_iterator_t it;
    it.offset = offset;
    it.bit_pos = -1;
    it.byte_value = 0;
    return it;
}

static unsigned int read_bits(bit_iterator_t *it, int n_bits, int *err)
{
    unsigned int value = 0;
    int safety_counter = 0;
    const int MAX_BITS_READ = 32; /* 防止读取异常大的位数 */

    if (n_bits > MAX_BITS_READ || n_bits < 0)
    {
        if (err)
        {
            *err = -EINVAL;
        }
        return 0;
    }

    while (n_bits--)
    {
        if (++safety_counter > MAX_BITS_READ)
        {
            if (err)
            {
                *err = -EINVAL;
            }
            return 0;
        }

        if (it->bit_pos < 0)
        {
            it->bit_pos = 7;
            if (s_use_xip)
            {
                if (s_font_size_limit > 0 && (size_t)it->offset >= s_font_size_limit)
                {
                    if (err)
                    {
                        *err = -EINVAL;
                    }
                    return 0;
                }
                it->byte_value = *((const uint8_t *)FONT_STORAGE_XIP_ADDR + it->offset);
                it->offset++;
            }
            else
            {
                if (flash_area_read(s_fa, it->offset, &it->byte_value, 1) != 0)
                {
                    if (err)
                    {
                        *err = -EIO;
                    }
                    return 0;
                }
                it->offset++;
            }
        }

        int8_t bit = (int8_t)((it->byte_value >> it->bit_pos) & 0x01);
        it->bit_pos--;
        value = (value << 1) | (unsigned int)bit;
    }
    if (err)
    {
        *err = 0;
    }
    return value;
}

static int read_bits_signed(bit_iterator_t *it, int n_bits, int *err)
{
    if (n_bits <= 0)
    {
        if (err)
        {
            *err = 0;
        }
        return 0;
    }
    unsigned int value = read_bits(it, n_bits, err);
    if (err && *err != 0)
    {
        return 0;
    }
    if (value & (1u << (n_bits - 1)))
    {
        value |= ~0u << n_bits;
    }
    return (int)value;
}

/* 读取binfont section label (8字节: 4B长度 + 4B标签) */
static bool read_section_label(off_t offset, uint32_t *out_len, char label_out[5])
{
    if (s_font_size_limit > 0 && ((size_t)offset + 8) > s_font_size_limit)
    {
        return false;
    }
    uint8_t buf[8];
    if (read_bytes(offset, buf, 8) != 0)
    {
        return false;
    }
    *out_len = sys_get_le32(buf);
    memcpy(label_out, buf + 4, 4);
    label_out[4] = '\0';

    /* 打印原始字节用于调试 */
    LOG_INF("Section@0x%X: [%02X %02X %02X %02X | %02X %02X %02X %02X] len=%u label='%s'", (unsigned int)offset, buf[0],
            buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7], *out_len, label_out);

    return true;
}

/* 在cmap表中查找Unicode对应的glyph ID */
static int find_glyph_id_in_cmap(uint32_t unicode, uint32_t *out_glyph_id)
{
    LOG_DBG("find_glyph_id: U+%04X, searching %u cmap tables", unicode, s_cmap_count);

    for (uint32_t t = 0; t < s_cmap_count; t++)
    {
        const cmap_table_bin_t *tbl = &s_cmap_tables[t];

        if (unicode < tbl->range_start || unicode >= tbl->range_start + tbl->range_length)
        {
            continue;
        }

        LOG_DBG("  Range match: table[%u] range[0x%X-0x%X], format=%u", t, tbl->range_start,
                tbl->range_start + tbl->range_length - 1, tbl->format_type);

        uint32_t rcp = unicode - tbl->range_start;
        uint32_t data_start = s_cmap_start_offset + tbl->data_offset;

        /* 根据cmap格式查找（使用LVGL枚举：FORMAT0_FULL=0, SPARSE_FULL=1, FORMAT0_TINY=2, SPARSE_TINY=3） */
        if (tbl->format_type == LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY) /* 2 */
        {
            if (rcp < tbl->data_entries_count)
            {
                *out_glyph_id = tbl->glyph_id_start + rcp;
                LOG_DBG("  FORMAT0_TINY: glyph_id=%u", *out_glyph_id);
                return 0;
            }
        }
        else if (tbl->format_type == LV_FONT_FMT_TXT_CMAP_FORMAT0_FULL) /* 0 */
        {
            if (rcp < tbl->data_entries_count)
            {
                uint8_t ofs;
                if (read_bytes(data_start + rcp, &ofs, 1) == 0)
                {
                    *out_glyph_id = tbl->glyph_id_start + ofs;
                    LOG_DBG("  FORMAT0_FULL: glyph_id=%u", *out_glyph_id);
                    return 0;
                }
            }
        }
        else if (tbl->format_type == LV_FONT_FMT_TXT_CMAP_SPARSE_TINY || /* 3 */
                 tbl->format_type == LV_FONT_FMT_TXT_CMAP_SPARSE_FULL) /* 1 */
        {
            size_t list_len = tbl->data_entries_count;
            int left = 0, right = (int)list_len - 1;

            while (left <= right)
            {
                int mid = (left + right) / 2;
                uint8_t buf[2];
                if (read_bytes(data_start + (mid * 2), buf, 2) != 0)
                {
                    break;
                }
                uint16_t val = sys_get_le16(buf);

                if (val == rcp)
                {
                    if (tbl->format_type == LV_FONT_FMT_TXT_CMAP_SPARSE_FULL) /* 1 */
                    {
                        size_t ofs_start = data_start + (list_len * 2);
                        uint8_t ofs_buf[2];
                        if (read_bytes(ofs_start + (mid * 2), ofs_buf, 2) == 0)
                        {
                            uint16_t ofs = sys_get_le16(ofs_buf);
                            *out_glyph_id = tbl->glyph_id_start + ofs;
                            LOG_DBG("  SPARSE_FULL: glyph_id=%u", *out_glyph_id);
                            return 0;
                        }
                    }
                    else /* SPARSE_TINY (3) */
                    {
                        *out_glyph_id = tbl->glyph_id_start + mid;
                        LOG_DBG("  SPARSE_TINY: glyph_id=%u", *out_glyph_id);
                        return 0;
                    }
                }
                else if (val < rcp)
                {
                    left = mid + 1;
                }
                else
                {
                    right = mid - 1;
                }
            }
        }
    }

    return -ENOENT; /* 未找到 */
}

/* LVGL回调：获取字形描述符 */
static bool mos_binfont_get_glyph_dsc(const lv_font_t *font, lv_font_glyph_dsc_t *dsc_out, uint32_t unicode,
                                      uint32_t unicode_next)
{
    ARG_UNUSED(unicode_next);

    if (!s_initialized || !dsc_out)
    {
        return false;
    }

    memset(dsc_out, 0, sizeof(*dsc_out));

    uint32_t glyph_id = 0;
    if (find_glyph_id_in_cmap(unicode, &glyph_id) != 0)
    {
        return false;
    }

    if (glyph_id >= s_loca_count)
    {
        return false;
    }

    uint32_t glyph_offset = 0;
    uint32_t next_offset = s_glyf_length; /* section length, not data length – matches official loader */

    if (read_loca_offset(glyph_id, &glyph_offset) != 0)
    {
        return false;
    }

    if (glyph_id + 1 < s_loca_count)
    {
        if (read_loca_offset(glyph_id + 1, &next_offset) != 0)
        {
            return false;
        }
    }

    if (glyph_offset > next_offset || next_offset > s_glyf_length)
    {
        return false;
    }

    if (glyph_offset == next_offset)
    {
        dsc_out->gid.index = glyph_id;
        dsc_out->resolved_font = font;
        dsc_out->format = LV_FONT_GLYPH_FORMAT_NONE;
        dsc_out->is_placeholder = 1;
        dsc_out->req_raw_bitmap = 0;
        return true;
    }

    /* loca offsets are relative to glyf SECTION start (including 8-byte label),
     * matching the official LVGL binfont loader (lv_binfont_loader.c line 334). */
    const off_t start = (off_t)(s_glyf_start_offset + glyph_offset);
    bit_iterator_t bit_it = init_bit_iterator(start);
    int err = 0;

    uint16_t adv_w;
    if (s_font_header.advance_width_bits == 0)
    {
        adv_w = s_font_header.default_advance_width;
    }
    else
    {
        adv_w = (uint16_t)read_bits(&bit_it, s_font_header.advance_width_bits, &err);
        if (err)
            return false;
    }

    if (s_font_header.advance_width_format == 0)
    {
        adv_w = (uint16_t)(adv_w * 16U);
    }

    /* 固定顺序：adv -> ofs_x -> ofs_y -> box_w -> box_h */
    int16_t ofs_x = (int16_t)read_bits_signed(&bit_it, s_font_header.xy_bits, &err);
    if (err)
        return false;
    int16_t ofs_y = (int16_t)read_bits_signed(&bit_it, s_font_header.xy_bits, &err);
    if (err)
        return false;
    uint16_t box_w = (uint16_t)read_bits(&bit_it, s_font_header.wh_bits, &err);
    if (err)
        return false;
    uint16_t box_h = (uint16_t)read_bits(&bit_it, s_font_header.wh_bits, &err);
    if (err)
        return false;

    if (box_w > MAX_GLYPH_BOX_W || box_h > MAX_GLYPH_BOX_H)
    {
        LOG_WRN("U+%04X gid=%u REJECTED: box=%ux%u exceeds max", unicode, glyph_id, box_w, box_h);
        return false;
    }

    LOG_DBG("U+%04X gid=%u adv_w=%u box=%ux%u ofs=(%d,%d)", unicode, glyph_id, adv_w, box_w, box_h, ofs_x, ofs_y);

    dsc_out->adv_w = adv_w;
    dsc_out->box_w = box_w;
    dsc_out->box_h = box_h;
    dsc_out->ofs_x = ofs_x;
    dsc_out->ofs_y = ofs_y;
    dsc_out->gid.index = glyph_id;
    dsc_out->resolved_font = font;
    dsc_out->entry = NULL;
    dsc_out->is_placeholder = 0;

    /* Match official lv_font_fmt_txt.c: format = bpp value.
     * We provide A8-converted data in get_glyph_bitmap (req_raw_bitmap=0),
     * matching the official lv_font_get_bitmap_fmt_txt behavior. */
    dsc_out->format = (uint8_t)s_font_header.bits_per_pixel;

    dsc_out->req_raw_bitmap = 0;
    return true;
}

static uint8_t s_fallback_pixel[1] = {0};

static lv_draw_buf_t *binfont_set_fallback_buf(lv_draw_buf_t *buf)
{
    buf->data = s_fallback_pixel;
    buf->data_size = sizeof(s_fallback_pixel);
    buf->header.w = 1;
    buf->header.h = 1;
    buf->header.cf = LV_COLOR_FORMAT_A4;
    buf->header.stride = (uint32_t)lv_draw_buf_width_to_stride(1, LV_COLOR_FORMAT_A4);
    return buf;
}

/* LVGL回调：获取字形位图数据（LVGL v9实际接口） */
static const void *mos_binfont_get_glyph_bitmap(lv_font_glyph_dsc_t *dsc, lv_draw_buf_t *draw_buf)
{
    if (!s_initialized || !dsc)
    {
        if (!draw_buf)
            draw_buf = &s_glyph_draw_buf;
        return binfont_set_fallback_buf(draw_buf);
    }

    if (!draw_buf)
    {
        draw_buf = &s_glyph_draw_buf;
    }

    const uint32_t glyph_id = dsc->gid.index;
    if (glyph_id >= s_loca_count || dsc->box_w == 0 || dsc->box_h == 0)
    {
        return binfont_set_fallback_buf(draw_buf);
    }

    if (s_font_header.compression_id != 0)
    {
        LOG_WRN("compressed binfont not supported, compression_id=%u", s_font_header.compression_id);
        return binfont_set_fallback_buf(draw_buf);
    }

    uint32_t glyph_offset = 0;
    uint32_t next_offset = s_glyf_length; /* section length – matches official loader */

    if (read_loca_offset(glyph_id, &glyph_offset) != 0)
    {
        return binfont_set_fallback_buf(draw_buf);
    }

    if (glyph_id + 1 < s_loca_count)
    {
        if (read_loca_offset(glyph_id + 1, &next_offset) != 0)
        {
            return binfont_set_fallback_buf(draw_buf);
        }
    }

    if (glyph_offset > next_offset || next_offset > s_glyf_length)
    {
        return binfont_set_fallback_buf(draw_buf);
    }

    const uint32_t record_bytes = next_offset - glyph_offset;
    if (record_bytes == 0)
    {
        return binfont_set_fallback_buf(draw_buf);
    }

    const uint8_t bpp = s_font_header.bits_per_pixel;
    if (!(bpp == 1 || bpp == 2 || bpp == 4 || bpp == 8))
    {
        return binfont_set_fallback_buf(draw_buf);
    }

    const uint32_t w = dsc->box_w;
    const uint32_t h = dsc->box_h;

    /*
     * Output format: A8 (1 byte per pixel), stride-aligned.
     * Matching official lv_font_fmt_txt.c behavior (lines 96-125):
     * each bpp-packed pixel is expanded to a full A8 byte (0xFF or 0x00 for 1bpp).
     */
    const uint32_t row_stride = (uint32_t)lv_draw_buf_width_to_stride((int32_t)w, LV_COLOR_FORMAT_A8);
    const uint32_t out_size = row_stride * h;
    if (out_size == 0 || out_size > MAX_GLYPH_BITMAP_SIZE)
    {
        return binfont_set_fallback_buf(draw_buf);
    }

    memset(s_glyph_bitmap_buf, 0, out_size);

    /* loca offsets are section-relative (see get_glyph_dsc comment) */
    const off_t start = (off_t)(s_glyf_start_offset + glyph_offset);
    bit_iterator_t bit_it = init_bit_iterator(start);
    int err = 0;

    /* 跳过 header bits（顺序与 get_glyph_dsc 一致） */
    if (s_font_header.advance_width_bits != 0)
    {
        (void)read_bits(&bit_it, s_font_header.advance_width_bits, &err);
        if (err)
            return binfont_set_fallback_buf(draw_buf);
    }

    (void)read_bits_signed(&bit_it, s_font_header.xy_bits, &err);
    if (err)
        return binfont_set_fallback_buf(draw_buf);
    (void)read_bits_signed(&bit_it, s_font_header.xy_bits, &err);
    if (err)
        return binfont_set_fallback_buf(draw_buf);
    (void)read_bits(&bit_it, s_font_header.wh_bits, &err);
    if (err)
        return binfont_set_fallback_buf(draw_buf);
    (void)read_bits(&bit_it, s_font_header.wh_bits, &err);
    if (err)
        return binfont_set_fallback_buf(draw_buf);

    /* A8 opacity lookup tables (matching official lv_font_fmt_txt.c) */
    static const uint8_t opa2_table[4] = {0, 85, 170, 255};
    static const uint8_t opa4_table[16] = {0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255};

    /* Read pixels from flash bitstream and convert to A8, row by row.
     * This matches the official lv_font_get_bitmap_fmt_txt non-aligned path. */
    for (uint32_t y = 0; y < h; y++)
    {
        uint8_t *row = &s_glyph_bitmap_buf[y * row_stride];
        for (uint32_t x = 0; x < w; x++)
        {
            uint32_t px = read_bits(&bit_it, bpp, &err);
            if (err)
                return binfont_set_fallback_buf(draw_buf);

            if (bpp == 1)
            {
                row[x] = px ? 0xFF : 0x00;
            }
            else if (bpp == 2)
            {
                row[x] = opa2_table[px & 0x3];
            }
            else if (bpp == 4)
            {
                row[x] = opa4_table[px & 0xF];
            }
            else /* bpp == 8 */
            {
                row[x] = (uint8_t)(px & 0xFF);
            }
        }
    }

    draw_buf->data = s_glyph_bitmap_buf;
    draw_buf->data_size = out_size;
    draw_buf->header.w = (lv_coord_t)w;
    draw_buf->header.h = (lv_coord_t)h;
    draw_buf->header.stride = row_stride;
    draw_buf->header.cf = LV_COLOR_FORMAT_A8;

    return draw_buf;
}

/* LVGL回调：释放字形资源（我们用静态缓存，无需释放） */
static void mos_binfont_release_glyph(const lv_font_t *font, lv_font_glyph_dsc_t *dsc)
{
    ARG_UNUSED(font);
    ARG_UNUSED(dsc);
    /* 无需操作 - 使用静态buffer */
}

/* 静态LVGL字体实例 */
static lv_font_t s_binfont_lvgl = {
    .get_glyph_dsc = mos_binfont_get_glyph_dsc,
    .get_glyph_bitmap = mos_binfont_get_glyph_bitmap,
    .release_glyph = mos_binfont_release_glyph,
    .line_height = 18,
    .base_line = 16,
    .subpx = LV_FONT_SUBPX_NONE,
    .kerning = LV_FONT_KERNING_NONE,
    .underline_position = -2,
    .underline_thickness = 1,
    .dsc = NULL,
    .fallback = &lv_font_montserrat_18,
    .user_data = NULL,
};

/* 公共API实现 */
int mos_binfont_lvgl_init(void)
{
    if (s_initialized)
    {
        return 0;
    }

#if defined(CONFIG_FONT_STORAGE_USE_PARTITION_2) && defined(PM_FONT_STORAGE2_ID)
    int ret = flash_area_open(PM_FONT_STORAGE2_ID, &s_fa);
#else
    int ret = flash_area_open(PM_FONT_STORAGE_ID, &s_fa);
#endif
    if (ret != 0)
    {
        LOG_ERR("flash_area_open failed: %d", ret);
        return ret;
    }

    size_t part_size = s_fa->fa_size;
    size_t configured = (size_t)CONFIG_FONT_STORAGE_FILE_SIZE;
    size_t size = configured ? configured : part_size;
    if (size > part_size)
    {
        LOG_WRN("Font size (%zu) > partition size (%zu); clamp", size, part_size);
        size = part_size;
    }
    s_font_size_limit = size;

    /* 强制关闭XIP：NS侧读取XIP会触发TF-M安全错误，改为flash_area_read流式读取 */
    s_use_xip = false;

    /* 读取binfont header */
    uint8_t label_buf[8];
    if (read_bytes(0, label_buf, 8) != 0)
    {
        flash_area_close(s_fa);
        return -EIO;
    }

    uint32_t head_len = sys_get_le32(label_buf);
    /* Erased partition (0xFF) or invalid: no valid binfont */
    if (head_len == 0 || head_len == 0xFFFFFFFF || label_buf[4] != 'h' || label_buf[5] != 'e' || label_buf[6] != 'a'
        || label_buf[7] != 'd')
    {
        LOG_ERR("font_storage2: no valid binfont (erased or wrong format). Program font .hex to partition.");
        flash_area_close(s_fa);
        return -ENODEV;
    }
    LOG_INF("Head section: offset=0x0, len=%u, label='%c%c%c%c'", head_len, label_buf[4], label_buf[5], label_buf[6],
            label_buf[7]);

    if (read_bytes(8, &s_font_header, sizeof(s_font_header)) != 0)
    {
        LOG_ERR("Failed to read font header");
        flash_area_close(s_fa);
        return -EIO;
    }

    /* 读取cmap表 */
    uint32_t cmap_len;
    char cmap_label[5];
    s_cmap_start_offset = head_len;

    if (s_font_size_limit > 0 && s_cmap_start_offset >= s_font_size_limit)
    {
        LOG_ERR("Font size (%zu) > partition size (%zu); clamp", s_font_size_limit, part_size);
        flash_area_close(s_fa);
        return -EINVAL;
    }

    if (!read_section_label(s_cmap_start_offset, &cmap_len, cmap_label) || strcmp(cmap_label, "cmap") != 0)
    {
        LOG_ERR("cmap section not found at offset 0x%X", s_cmap_start_offset);
        flash_area_close(s_fa);
        return -EINVAL;
    }

    LOG_INF("Cmap section: offset=0x%X, len=%u", s_cmap_start_offset, cmap_len);

    uint8_t cmap_cnt_buf[4];
    if (read_bytes(s_cmap_start_offset + 8, cmap_cnt_buf, 4) != 0)
    {
        LOG_ERR("Failed to read cmap length");
        flash_area_close(s_fa);
        return -EIO;
    }
    s_cmap_count = sys_get_le32(cmap_cnt_buf);

    size_t tables_bytes = s_cmap_count * sizeof(cmap_table_bin_t);
    s_cmap_tables = k_malloc(tables_bytes);
    if (!s_cmap_tables)
    {
        LOG_ERR("Failed to allocate memory for cmap tables");
        flash_area_close(s_fa);
        return -ENOMEM;
    }

    if (read_bytes(s_cmap_start_offset + 12, s_cmap_tables, tables_bytes) != 0)
    {
        k_free(s_cmap_tables);
        flash_area_close(s_fa);
        LOG_ERR("Failed to read cmap tables");
        return -EIO;
    }

    /* 解析loca section（glyph位置索引） */
    s_loca_start_offset = s_cmap_start_offset + cmap_len; /* LVGL格式：下一节从当前节起始 + length */
    if (s_font_size_limit > 0 && s_loca_start_offset >= s_font_size_limit)
    {
        LOG_ERR("Font size (%zu) > partition size (%zu); clamp", s_font_size_limit, part_size);
        flash_area_close(s_fa);
        return -EINVAL;
    }

    uint32_t loca_len;
    char loca_label[5];
    if (!read_section_label(s_loca_start_offset, &loca_len, loca_label) || strcmp(loca_label, "loca") != 0)
    {
        LOG_ERR("loca section not found at offset 0x%X", s_loca_start_offset);
        flash_area_close(s_fa);
        return -EINVAL;
    }

    uint8_t loca_cnt_buf[4];
    if (read_bytes(s_loca_start_offset + 8, loca_cnt_buf, 4) != 0)
    {
        LOG_ERR("Failed to read loca count");
        flash_area_close(s_fa);
        return -EIO;
    }
    s_loca_count = sys_get_le32(loca_cnt_buf);
    if (s_loca_count == 0)
    {
        LOG_ERR("loca count is 0");
        flash_area_close(s_fa);
        return -EINVAL;
    }

    LOG_INF("Loca count=%u, index_to_loc_format=%u", s_loca_count, s_font_header.index_to_loc_format);

    s_loca_offsets_start = s_loca_start_offset + 12; /* 8字节label + 4字节count */
    size_t offsets_bytes = (s_font_header.index_to_loc_format == 0) ? (size_t)s_loca_count * sizeof(uint16_t)
                                                                    : (size_t)s_loca_count * sizeof(uint32_t);
    if (s_font_header.index_to_loc_format != 0 && s_font_header.index_to_loc_format != 1)
    {
        LOG_ERR("Unknown index_to_loc_format: %u", s_font_header.index_to_loc_format);
        flash_area_close(s_fa);
        return -EINVAL;
    }
    if (loca_len < (12 + offsets_bytes))
    {
        LOG_ERR("loca length too small: len=%u expected>= %u", loca_len, (uint32_t)(12 + offsets_bytes));
        flash_area_close(s_fa);
        return -EINVAL;
    }

    /* 解析glyf section（存储bitmap数据） */
    s_glyf_start_offset = s_loca_start_offset + loca_len;
    if (s_font_size_limit > 0 && s_glyf_start_offset >= s_font_size_limit)
    {
        LOG_ERR("Font size (%zu) > partition size (%zu); clamp", s_font_size_limit, part_size);
        flash_area_close(s_fa);
        return -EINVAL;
    }
    LOG_INF("Glyf expected at offset 0x%X (loca_start=0x%X + loca_len=%u)", 
            s_glyf_start_offset, s_loca_start_offset, loca_len);
    uint32_t glyf_len;
    char glyf_label[5];
    if (!read_section_label(s_glyf_start_offset, &glyf_len, glyf_label) || strcmp(glyf_label, "glyf") != 0)
    {
        LOG_ERR("glyf section not found at offset 0x%X", s_glyf_start_offset);
        flash_area_close(s_fa);
        return -EINVAL;
    }

    s_glyf_length = glyf_len;
    if (s_glyf_length < 8)
    {
        LOG_ERR("glyf length too small: %u", s_glyf_length);
        flash_area_close(s_fa);
        return -EINVAL;
    }
    s_glyf_data_offset = s_glyf_start_offset + 8;
    s_glyf_data_length = s_glyf_length - 8;
    if (s_font_size_limit > 0 && (s_glyf_data_offset + s_glyf_data_length) > s_font_size_limit)
    {
        flash_area_close(s_fa);
        return -EINVAL;
    }
    /* Loca offsets are always section-relative in LVGL binfont format
     * (matching lv_binfont_loader.c: seek to glyf_section_start + loca_value). */
    LOG_INF("Glyf section: offset=0x%X, len=%u (data_off=0x%X data_len=%u)", s_glyf_start_offset, s_glyf_length,
            s_glyf_data_offset, s_glyf_data_length);

    /* 更新LVGL字体参数（优先用min/max，避免基线/行高偏差导致重影） */
    int32_t min_y = (int32_t)s_font_header.min_y;
    int32_t max_y = (int32_t)s_font_header.max_y;
    int32_t line_height = max_y - min_y;
    int32_t base_line = -min_y;

    if (line_height <= 0)
    {
        line_height = (int32_t)s_font_header.font_size;
    }
    if (line_height <= 0)
    {
        line_height = (int32_t)s_font_header.ascent - (int32_t)s_font_header.descent;
    }
    if (line_height <= 0)
    {
        line_height = 18; /* 最终兜底，避免异常值 */
    }

    if (base_line < 0 || base_line > line_height)
    {
        base_line = (int32_t)s_font_header.ascent;
        if (base_line < 0 || base_line > line_height)
        {
            base_line = 0;
        }
    }

    s_binfont_lvgl.line_height = line_height;
    s_binfont_lvgl.base_line = base_line;

    s_initialized = true;
    LOG_WRN("========================================");
    LOG_WRN("Binfont LVGL init SUCCESS!");
    LOG_WRN("Font: size=%u, cmap_tables=%u", s_font_header.font_size, s_cmap_count);
    LOG_WRN("Header: adv_w_bits=%u, xy_bits=%u, wh_bits=%u, bpp=%u, compression_id=%u (0=raw)",
            s_font_header.advance_width_bits, s_font_header.xy_bits, s_font_header.wh_bits,
            s_font_header.bits_per_pixel, s_font_header.compression_id);
    LOG_WRN("Loca: count=%u, format=%u", s_loca_count, s_font_header.index_to_loc_format);
    LOG_WRN("Glyf: offset=0x%X, len=%u (data_off=0x%X data_len=%u)", s_glyf_start_offset, s_glyf_length,
            s_glyf_data_offset, s_glyf_data_length);
    LOG_WRN("========================================");

    return 0;
}

void mos_binfont_lvgl_deinit(void)
{
    if (!s_initialized)
    {
        return;
    }

    if (s_cmap_tables)
    {
        k_free(s_cmap_tables);
        s_cmap_tables = NULL;
    }

    if (s_fa)
    {
        flash_area_close(s_fa);
        s_fa = NULL;
    }

    s_initialized = false;
    s_glyf_start_offset = 0;
    s_glyf_data_offset = 0;
    s_glyf_length = 0;
    s_glyf_data_length = 0;
    s_loca_start_offset = 0;
    s_loca_count = 0;
    s_loca_offsets_start = 0;
    s_font_size_limit = 0;
    s_use_xip = false;
}

const lv_font_t *mos_binfont_get_lvgl_font(void)
{
    LOG_WRN("mos_binfont_get_lvgl_font called, s_initialized=%d", s_initialized);

    if (!s_initialized)
    {
        LOG_WRN("Initializing binfont...");
        if (mos_binfont_lvgl_init() != 0)
        {
            LOG_ERR("mos_binfont_lvgl_init FAILED!");
            return NULL;
        }
        LOG_WRN("Binfont init completed");
    }

    LOG_WRN("Returning binfont @%p", &s_binfont_lvgl);
    return &s_binfont_lvgl;
}

int mos_binfont_debug_glyph_region(uint32_t unicode, uint32_t *out_glyph_id, uint32_t *out_start, uint32_t *out_len)
{
    if (!s_initialized || !out_glyph_id || !out_start || !out_len)
    {
        return -EINVAL;
    }

    uint32_t glyph_id = 0;
    if (find_glyph_id_in_cmap(unicode, &glyph_id) != 0)
    {
        return -ENOENT;
    }

    if (glyph_id >= s_loca_count)
    {
        return -EINVAL;
    }

    uint32_t glyph_offset = 0;
    uint32_t next_offset = s_glyf_length; /* section length – matches official loader */

    if (read_loca_offset(glyph_id, &glyph_offset) != 0)
    {
        return -EIO;
    }
    if (glyph_id + 1 < s_loca_count)
    {
        if (read_loca_offset(glyph_id + 1, &next_offset) != 0)
        {
            return -EIO;
        }
    }

    if (glyph_offset > next_offset || next_offset > s_glyf_length)
    {
        return -EINVAL;
    }

    *out_glyph_id = glyph_id;
    /* loca offsets are section-relative (include 8-byte glyf label) */
    *out_start = s_glyf_start_offset + glyph_offset;
    *out_len = next_offset - glyph_offset;
    return 0;
}

#endif /* CONFIG_LVGL */

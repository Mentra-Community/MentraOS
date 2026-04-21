#include "mos_binfont_lvgl.h"

#if defined(CONFIG_LVGL)

#include <lvgl.h>
#include <pm_config.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/util.h>

#include "mos_font_storage.h"

LOG_MODULE_REGISTER(mos_binfont_lvgl, LOG_LEVEL_INF);

/* XIP base address for external flash (QSPI) */
#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif

/* Binfont header structure (LVGL v9 format)
 * Binfont头部结构（LVGL v9格式） */
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
/* Note: cmap and glyf are flattened in binfont, unlike the more complex ttf/otf structures.
 * This simplifies parsing: cmap maps Unicode directly to glyph_id, and glyf stores glyph bitmap/descriptor data
 * directly. 注意：cmap表和glyf表在binfont中是扁平结构，读取逻辑更简单。 */
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

/* Binfont glyph descriptor (simplified, read from glyf table)
 * Binfont glyph描述符（简化版，从glyf表读取） */
typedef struct
{
    uint16_t adv_w;
    uint8_t box_w;
    uint8_t box_h;
    int8_t ofs_x;
    int8_t ofs_y;
} binfont_glyph_dsc_t;

/* Static resources
 * 静态资源 */
static font_header_bin_t s_font_header;
static cmap_table_bin_t *s_cmap_tables;
static uint32_t s_cmap_count;
static uint32_t s_cmap_start_offset;
static uint32_t s_glyf_start_offset; /* glyf section start offset (includes 8-byte label) / 起始偏移（含8字节label） */
static uint32_t s_glyf_data_offset; /* glyf section data start offset (init log only) / 数据起始偏移（仅日志） */
static uint32_t s_loca_start_offset; /* loca section start offset / 起始偏移 */
static uint32_t s_glyf_length; /* total glyf section length (includes 8-byte label), equals loca boundary / 总长 */
static uint32_t s_glyf_data_length; /* s_glyf_length - 8, log only / 仅日志用 */
static uint32_t s_loca_count;
static off_t s_loca_offsets_start;
static const struct flash_area *s_fa;
static bool s_initialized = false;
static size_t s_font_size_limit;
static bool s_use_xip;
/* Suppress duplicate "adv_w < box_w" warnings for the same glyph after one report.
 * 抑制同一字形的重复 "adv_w < box_w" 告警，避免日志刷屏。 */
#define ADV_W_GUARD_WARN_CACHE_SIZE 32
typedef struct
{
    uint32_t unicode;
    uint16_t glyph_id;
    uint16_t adv_w;
    uint16_t min_adv_w;
    bool valid;
} adv_guard_warn_cache_t;
static adv_guard_warn_cache_t s_adv_guard_warn_cache[ADV_W_GUARD_WARN_CACHE_SIZE];
static uint8_t s_adv_guard_warn_cache_next = 0;

static void adv_guard_warn_cache_reset(void)
{
    memset(s_adv_guard_warn_cache, 0, sizeof(s_adv_guard_warn_cache));
    s_adv_guard_warn_cache_next = 0;
}

static bool adv_guard_warn_should_log(uint32_t unicode, uint16_t glyph_id, uint16_t adv_w, uint16_t min_adv_w)
{
    for (size_t i = 0; i < ARRAY_SIZE(s_adv_guard_warn_cache); i++)
    {
        if (s_adv_guard_warn_cache[i].valid && s_adv_guard_warn_cache[i].unicode == unicode
            && s_adv_guard_warn_cache[i].glyph_id == glyph_id && s_adv_guard_warn_cache[i].adv_w == adv_w
            && s_adv_guard_warn_cache[i].min_adv_w == min_adv_w)
        {
            return false;
        }
    }

    adv_guard_warn_cache_t *slot = &s_adv_guard_warn_cache[s_adv_guard_warn_cache_next];
    slot->unicode = unicode;
    slot->glyph_id = glyph_id;
    slot->adv_w = adv_w;
    slot->min_adv_w = min_adv_w;
    slot->valid = true;
    s_adv_guard_warn_cache_next = (uint8_t)((s_adv_guard_warn_cache_next + 1U) % ADV_W_GUARD_WARN_CACHE_SIZE);
    return true;
}

/* Boot default language/size comes from Kconfig (prj.conf); runtime changes only via mos_binfont_switch_language().
 * Welcome screen and other UI share one active font; refresh will not force-reset to Kconfig defaults.
 * 上电默认语言/字号由Kconfig决定，运行时通过switch接口变更；欢迎屏与其它UI共用当前字库。 */
#if IS_ENABLED(CONFIG_MOS_WELCOME_LANG_ZH_CN)
static uint8_t s_current_language = MOS_FONT_LANG_ZH_CN;
static uint8_t s_current_font_size = MOS_FONT_SIZE_18;
#elif IS_ENABLED(CONFIG_MOS_WELCOME_LANG_EN)
static uint8_t s_current_language = MOS_FONT_LANG_EN_US;
static uint8_t s_current_font_size = (uint8_t)CONFIG_MOS_WELCOME_BINFONT_PT_SIZE;
#else
#error "Enable CONFIG_MOS_WELCOME_LANG_EN or CONFIG_MOS_WELCOME_LANG_ZH_CN (boot default external binfont)"
#endif

/* Clamp invalid EN boot point size only once during first init, to avoid overriding user-switched runtime state.
 * 仅首次初始化时校正英文点数误配，避免覆盖用户运行时切换状态。 */
static void binfont_clamp_boot_en_size_once(void)
{
    static bool done;

    if (done)
    {
        return;
    }
    done = true;
    if (s_current_language != MOS_FONT_LANG_EN_US)
    {
        return;
    }
    if (s_current_font_size < 16u || s_current_font_size > 26u || (s_current_font_size & 1u) != 0u)
    {
        LOG_WRN("Boot default EN font size %u invalid, using 18", s_current_font_size);
        s_current_font_size = 18u;
    }
}

/* Language-to-partition mapping table
 * 语言到分区的映射表 */
struct font_partition_mapping
{
    uint8_t language;
    uint8_t font_size;
    uint8_t partition_id; /* Flash partition ID / Flash分区ID */
};

/* Language + font size -> partition ID mapping
 * 语言+字号到分区ID映射 */
static const struct font_partition_mapping s_partition_map[] = {
    /* Simplified Chinese - 18pt only / 简体中文仅18pt */
    {1, 18, FIXED_PARTITION_ID(font_storage_zh_cn_18)},
    /* English - multiple font sizes (128KB each) / 英语多字号（每个128KB） */
    {2, 16, FIXED_PARTITION_ID(font_storage_en_16)},
    {2, 18, FIXED_PARTITION_ID(font_storage_en_18)},
    {2, 20, FIXED_PARTITION_ID(font_storage_en_20)},
    {2, 22, FIXED_PARTITION_ID(font_storage_en_22)},
    {2, 24, FIXED_PARTITION_ID(font_storage_en_24)},
    {2, 26, FIXED_PARTITION_ID(font_storage_en_26)},
};

static const size_t s_partition_map_count = sizeof(s_partition_map) / sizeof(s_partition_map[0]);

/* Glyph bitmap cache (static buffer)
 * Glyph bitmap缓存（静态buffer） */
#define MAX_GLYPH_BITMAP_SIZE 4096 /* 64x64 @ 4bpp = 2048 bytes, with margin / 2048字节并留余量 */
static uint8_t s_glyph_bitmap_buf[MAX_GLYPH_BITMAP_SIZE];
static lv_draw_buf_t s_glyph_draw_buf;
/* Safety limits to avoid pathological glyph sizes blocking the system */
#define MAX_GLYPH_BOX_W 64
#define MAX_GLYPH_BOX_H 64

/* =============================================================
 * Optimization 1: Batch glyph record read buffer
 * Read the entire glyph record in ONE flash_area_read() call.
 * Replaces ~165 per-byte SPI transactions with a single call.
 * ============================================================= */
#define MAX_GLYPH_RECORD_BYTES 2056 /* 4-byte header + 64×64 @ 4bpp = 2048 B */
static uint8_t s_glyph_raw_buf[MAX_GLYPH_RECORD_BYTES];

/* In-memory bit iterator — same bit ordering as read_bits() but from RAM */
typedef struct
{
    const uint8_t *data;
    uint32_t size;
    uint32_t byte_pos;
    int8_t bit_pos;
    uint8_t byte_val;
} mem_bit_iter_t;

static mem_bit_iter_t mem_bit_iter_init(const uint8_t *data, uint32_t size)
{
    mem_bit_iter_t it;
    it.data = data;
    it.size = size;
    it.byte_pos = 0;
    it.bit_pos = -1;
    it.byte_val = 0;
    return it;
}

static unsigned int mem_read_bits(mem_bit_iter_t *it, int n_bits, int *err)
{
    unsigned int value = 0;
    if (n_bits <= 0 || n_bits > 32)
    {
        if (err)
            *err = -EINVAL;
        return 0;
    }
    for (int i = 0; i < n_bits; i++)
    {
        if (it->bit_pos < 0)
        {
            if (it->byte_pos >= it->size)
            {
                if (err)
                    *err = -EIO;
                return 0;
            }
            it->byte_val = it->data[it->byte_pos++];
            it->bit_pos = 7;
        }
        value = (value << 1) | ((it->byte_val >> it->bit_pos) & 1u);
        it->bit_pos--;
    }
    if (err)
        *err = 0;
    return value;
}

static int mem_read_bits_signed(mem_bit_iter_t *it, int n_bits, int *err)
{
    if (n_bits <= 0)
    {
        if (err)
            *err = 0;
        return 0;
    }
    unsigned int v = mem_read_bits(it, n_bits, err);
    if (err && *err)
        return 0;
    if (v & (1u << (n_bits - 1)))
        v |= ~0u << n_bits;
    return (int)v;
}

/* =============================================================
 * Optimization 2: LRU glyph bitmap cache
 * Caches decoded A8 bitmaps for recently used glyphs.
 * Repeated characters (labels, status strings) require zero
 * flash reads after their first render.
 * ============================================================= */
#ifndef GLYPH_CACHE_SLOTS
#define GLYPH_CACHE_SLOTS 12 /* ~6.5 KB total RAM */
#endif
/* 512 B covers A8 bitmaps up to ~22×23 px; 18 px CJK uses ~324 B */
#define GLYPH_CACHE_BMP_BYTES 512
typedef struct
{
    bool valid;
    uint8_t lru_age; /* relative to s_gcache_lru; lower = older */
    uint32_t unicode;
    uint32_t glyph_id;
    uint16_t adv_w;
    uint8_t box_w;
    uint8_t box_h;
    int16_t ofs_x;
    int16_t ofs_y;
    uint32_t bmp_size; /* 0 = dsc cached but bitmap not yet decoded */
    uint32_t bmp_stride;
    uint8_t bmp[GLYPH_CACHE_BMP_BYTES];
} glyph_cache_t;

static glyph_cache_t s_gcache[GLYPH_CACHE_SLOTS]; /* LRU cache of decoded glyphs */
static uint8_t s_gcache_lru; /* monotonic 8-bit counter; wraps are fine */
static int s_pinned_slot = -1; /* slot in use by the current draw call */
/* forward declaration: callbacks above need address comparison */
static lv_font_t s_binfont_lvgl;

static int gcache_find(uint32_t unicode)
{
    for (int i = 0; i < GLYPH_CACHE_SLOTS; i++)
    {
        if (s_gcache[i].valid && s_gcache[i].unicode == unicode)
            return i;
    }
    return -1;
}

static int gcache_find_by_gid(uint32_t glyph_id)
{
    for (int i = 0; i < GLYPH_CACHE_SLOTS; i++)
    {
        if (s_gcache[i].valid && s_gcache[i].glyph_id == glyph_id)
            return i;
    }
    return -1;
}

/* Returns a free slot, or the LRU non-pinned slot to evict. */
static int gcache_evict(void)
{
    for (int i = 0; i < GLYPH_CACHE_SLOTS; i++)
    {
        if (!s_gcache[i].valid)
            return i;
    }
    int oldest = -1;
    uint8_t oldest_diff = 0;
    for (int i = 0; i < GLYPH_CACHE_SLOTS; i++)
    {
        if (i == s_pinned_slot)
            continue;
        uint8_t diff = (uint8_t)(s_gcache_lru - s_gcache[i].lru_age);
        if (diff >= oldest_diff)
        {
            oldest_diff = diff;
            oldest = i;
        }
    }
    return oldest;
}

static inline int read_bytes(off_t offset, void *buf, size_t len)
{
    if (s_font_size_limit > 0 && ((size_t)offset + len) > s_font_size_limit)
    {
        return -EINVAL;
    }

    if (s_use_xip && s_fa)
    {
        const uint8_t *base = (const uint8_t *)(PM_QSPI_NOR_BASE_ADDRESS + s_fa->fa_off);
        memcpy(buf, base + offset, len);
        return 0;
    }

    return flash_area_read(s_fa, offset, buf, len);
}

/* Helper: safe little-endian reads
 * 辅助函数：安全读取little-endian数据 */
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

/* Read binfont section label (8 bytes: 4B length + 4B tag)
 * 读取binfont section label (8字节: 4B长度 + 4B标签) */
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

    /* Print raw bytes for debugging / 打印原始字节用于调试 */
    LOG_INF("Section@0x%X: [%02X %02X %02X %02X | %02X %02X %02X %02X] len=%u label='%s'", (unsigned int)offset, buf[0],
            buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7], *out_len, label_out);

    return true;
}

/* Find glyph ID for a Unicode code point in cmap tables
 * 在cmap表中查找Unicode对应的glyph ID */
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

        /* Parse by cmap format (LVGL enums: FORMAT0_FULL=0, SPARSE_FULL=1, FORMAT0_TINY=2, SPARSE_TINY=3)
         * 按cmap格式查找 */
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

    return -ENOENT; /* Not found / 未找到 */
}

/* Field order after advance: default parse is ofs_x, ofs_y, box_w, box_h (LVGL font spec).
 * If export order is adv, box_w, box_h, ofs_x, ofs_y, enable CONFIG_BINFONT_GLYPH_ORDER_WHXY.
 * advance后字段默认按ofs_x/ofs_y/box_w/box_h解析；导出顺序不同可开WHXY开关。 */
static void binfont_read_bbox_after_adv(mem_bit_iter_t *bit_it, int *err, int16_t *ofs_x, int16_t *ofs_y,
                                        uint16_t *box_w, uint16_t *box_h)
{
#if IS_ENABLED(CONFIG_BINFONT_GLYPH_ORDER_WHXY)
    *box_w = (uint16_t)mem_read_bits(bit_it, s_font_header.wh_bits, err);
    if (err && *err)
    {
        return;
    }
    *box_h = (uint16_t)mem_read_bits(bit_it, s_font_header.wh_bits, err);
    if (err && *err)
    {
        return;
    }
    *ofs_x = (int16_t)mem_read_bits_signed(bit_it, s_font_header.xy_bits, err);
    if (err && *err)
    {
        return;
    }
    *ofs_y = (int16_t)mem_read_bits_signed(bit_it, s_font_header.xy_bits, err);
#else
    *ofs_x = (int16_t)mem_read_bits_signed(bit_it, s_font_header.xy_bits, err);
    if (err && *err)
    {
        return;
    }
    *ofs_y = (int16_t)mem_read_bits_signed(bit_it, s_font_header.xy_bits, err);
    if (err && *err)
    {
        return;
    }
    *box_w = (uint16_t)mem_read_bits(bit_it, s_font_header.wh_bits, err);
    if (err && *err)
    {
        return;
    }
    *box_h = (uint16_t)mem_read_bits(bit_it, s_font_header.wh_bits, err);
#endif
}

/* LVGL callback: get glyph descriptor
 * LVGL回调：获取字形描述符 */
static bool mos_binfont_get_glyph_dsc(const lv_font_t *font, lv_font_glyph_dsc_t *dsc_out, uint32_t unicode,
                                      uint32_t unicode_next)
{
    ARG_UNUSED(unicode_next);

    if (!s_initialized || !dsc_out)
    {
        return false;
    }

    memset(dsc_out, 0, sizeof(*dsc_out));

    /* === Cache hit: zero flash reads === */
    int cslot = gcache_find(unicode);  // Search by Unicode first to avoid cache miss when one glyph ID maps to multiple Unicode points.
    if (cslot >= 0)
    {
        glyph_cache_t *e = &s_gcache[cslot];
        e->lru_age = ++s_gcache_lru;
        dsc_out->adv_w = e->adv_w;
        dsc_out->box_w = e->box_w;
        dsc_out->box_h = e->box_h;
        dsc_out->ofs_x = e->ofs_x;
        dsc_out->ofs_y = e->ofs_y;
        dsc_out->gid.index = e->glyph_id;
        dsc_out->resolved_font = font;
        dsc_out->entry = NULL;
        dsc_out->is_placeholder = 0;
        dsc_out->format = (uint8_t)s_font_header.bits_per_pixel;
        dsc_out->req_raw_bitmap = 0;
        return true;
    }

    uint32_t glyph_id = 0;
    if (find_glyph_id_in_cmap(unicode, &glyph_id) != 0)
    {
        /* For LVGL symbol range (0xF000-0xF8FF), delegate directly to fallback font.
         * 对于LVGL符号范围，直接委托fallback字体。 */
        if (unicode >= 0xF000 && unicode <= 0xF8FF && font->fallback != NULL)
        {
            LOG_DBG("U+%04X: LVGL symbol, fallback get_glyph_dsc @%p", unicode, (void *)font->fallback);
            bool ok = font->fallback->get_glyph_dsc(font->fallback, dsc_out, unicode, unicode_next);
            if (ok)
            {
                /* Some fallback fonts don't fill resolved_font consistently; force it for bitmap dispatch. */
                dsc_out->resolved_font = font->fallback;
            }
            return ok;
        }

        /* For other missing Flash glyphs, return false to trigger LVGL fallback.
         * LVGL v9 should call fallback->get_glyph_dsc() automatically.
         * Flash字库缺字时返回false触发fallback机制。 */
        LOG_DBG("U+%04X: glyph not found in Flash binfont, returning false (fallback=%p)", unicode,
                (void *)font->fallback);
        return false;
    }

#if IS_ENABLED(CONFIG_BINFONT_GLYPH_DEBUG)
    static int cmap_debug_count = 0;
    if (cmap_debug_count < 10)
    {
        char c = (unicode >= 32 && unicode <= 126) ? (char)unicode : '?';
        LOG_INF("Cmap debug [%d]: U+%04X ('%c') -> glyph_id=%u", cmap_debug_count, unicode, c, glyph_id);
        cmap_debug_count++;
    }
#endif

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
        /* Empty character (e.g. space), no rendering / 空字符（如空格）不渲染 */
        LOG_DBG("U+%04X gid=%u: empty glyph (offset==next)", unicode, glyph_id);
        dsc_out->gid.index = glyph_id;
        dsc_out->resolved_font = font;
        dsc_out->format = LV_FONT_GLYPH_FORMAT_NONE;
        dsc_out->is_placeholder = 1;
        dsc_out->req_raw_bitmap = 0;
        return true;
    }

    /* === Batch-read entire glyph record in one flash call, parse from RAM === */
    const off_t start = (off_t)(s_glyf_start_offset + glyph_offset);
    uint32_t record_bytes = next_offset - glyph_offset;
    if (record_bytes > MAX_GLYPH_RECORD_BYTES)
    {
        record_bytes = MAX_GLYPH_RECORD_BYTES;
    }
    if (read_bytes(start, s_glyph_raw_buf, record_bytes) != 0)
    {
        return false;
    }
    mem_bit_iter_t bit_it = mem_bit_iter_init(s_glyph_raw_buf, record_bytes);
    int err = 0;

    uint16_t adv_w;
    if (s_font_header.advance_width_bits == 0)
    {
        adv_w = s_font_header.default_advance_width;
        LOG_DBG("U+%04X gid=%u: using default_adv_w=%u (advance_width_bits=0)", unicode, glyph_id, adv_w);
    }
    else
    {
        uint16_t adv_w_from_glyph = (uint16_t)mem_read_bits(&bit_it, s_font_header.advance_width_bits, &err);
        if (err) return false;
        LOG_DBG("U+%04X gid=%u: read adv_w_from_glyph=%u from %u bits", unicode, glyph_id, adv_w_from_glyph,
                s_font_header.advance_width_bits);

        /* If glyph advance is 0, fallback to default_advance_width / glyph中advance为0时回退默认值 */
        if (adv_w_from_glyph == 0 && s_font_header.default_advance_width > 0)
        {
            LOG_WRN("U+%04X gid=%u: adv_w_from_glyph=0, using default_adv_w=%u", unicode, glyph_id,
                    s_font_header.default_advance_width);
            adv_w = s_font_header.default_advance_width;
        }
        else
        {
            adv_w = adv_w_from_glyph;
        }
    }

    int16_t ofs_x;
    int16_t ofs_y;
    uint16_t box_w;
    uint16_t box_h;
    binfont_read_bbox_after_adv(&bit_it, &err, &ofs_x, &ofs_y, &box_w, &box_h);
    if (err)
    {
        return false;
    }

    if (s_font_header.advance_width_format == 1)
    {
        const uint16_t raw_fp4 = adv_w;
        adv_w = (uint16_t)((uint32_t)raw_fp4 + 8U) / 16U;
        if (adv_w == 0U && raw_fp4 != 0U)
        {
            adv_w = 1U;
        }
        LOG_DBG("U+%04X gid=%u: adv FP4 raw=%u -> px=%u", unicode, glyph_id, (unsigned)raw_fp4, (unsigned)adv_w);
    }

     /* Maximum guard: advance_width should not be unreasonably larger than font_size (e.g. due to corrupted data)
      * 最大值防护：advance_width不应远大于font_size（如数据异常导致） */
    {
        const uint16_t max_adv = (uint16_t)(s_font_header.font_size * 6U);
        if (max_adv > 0U && adv_w > max_adv)
        {
            LOG_WRN("U+%04X gid=%u: adv_w %u > cap %u (font_size=%u), clamping", unicode, glyph_id, adv_w, max_adv,
                    s_font_header.font_size);
            adv_w = max_adv;
        }
    }

    /* Minimum guard: advance_width should not be smaller than box_w / 最小值防护 */
    uint16_t min_adv_w = box_w;
    if (adv_w < min_adv_w)/* 如果adv_w小于min_adv_w，则设置为min_adv_w*/
    {
        if (adv_guard_warn_should_log(unicode, glyph_id, adv_w, min_adv_w))
        {
            LOG_WRN("U+%04X gid=%u: adv_w %u < min %u (box_w=%u), setting to %u", unicode, glyph_id, adv_w, min_adv_w,
                    box_w, min_adv_w);
        }
        adv_w = min_adv_w;
    }

    if (box_w > MAX_GLYPH_BOX_W || box_h > MAX_GLYPH_BOX_H)
    {
        LOG_WRN("U+%04X gid=%u REJECTED: box=%ux%u exceeds max", unicode, glyph_id, box_w, box_h);
        return false;
    }

    /* === Store descriptor in LRU cache (bitmap filled by get_glyph_bitmap) === */
    int cs = gcache_evict();
    if (cs >= 0)
    {
        glyph_cache_t *e = &s_gcache[cs];
        e->valid = true;
        e->lru_age = ++s_gcache_lru;
        e->unicode = unicode;
        e->glyph_id = glyph_id;
        e->adv_w = adv_w;
        e->box_w = (uint8_t)box_w;
        e->box_h = (uint8_t)box_h;
        e->ofs_x = ofs_x;
        e->ofs_y = ofs_y;
        e->bmp_size = 0; /* bitmap stored on demand in get_glyph_bitmap */
    }

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

/* Placeholder bitmap for missing glyphs / 缺字占位位图（方框） */
#define PLACEHOLDER_SIZE 16
static uint8_t s_placeholder_buf[PLACEHOLDER_SIZE * PLACEHOLDER_SIZE];

static lv_draw_buf_t *binfont_set_fallback_buf(lv_draw_buf_t *buf)
{
    buf->data = s_placeholder_buf;
    buf->data_size = sizeof(s_placeholder_buf);
    buf->header.w = PLACEHOLDER_SIZE;
    buf->header.h = PLACEHOLDER_SIZE;
    buf->header.cf = LV_COLOR_FORMAT_A8;
    buf->header.stride = PLACEHOLDER_SIZE;

    /* Generate square placeholder: draw a white border box / 生成白色边框方框占位 */
    memset(s_placeholder_buf, 0, sizeof(s_placeholder_buf));
    for (int y = 0; y < PLACEHOLDER_SIZE; y++)
    {
        for (int x = 0; x < PLACEHOLDER_SIZE; x++)
        {
            /* White on edges / 边缘显示白色 */
            if (y == 0 || y == PLACEHOLDER_SIZE - 1 || x == 0 || x == PLACEHOLDER_SIZE - 1)
            {
                s_placeholder_buf[y * PLACEHOLDER_SIZE + x] = 0xFF;
            }
        }
    }
    return buf;
}

/* LVGL callback: get glyph bitmap data (LVGL v9 interface)
 * LVGL回调：获取字形位图数据（LVGL v9接口） */
static const void *mos_binfont_get_glyph_bitmap(lv_font_glyph_dsc_t *dsc, lv_draw_buf_t *draw_buf)
{
    if (!dsc)
    {
        LOG_WRN("get_glyph_bitmap: dsc=NULL");
        if (!draw_buf)
        {
            draw_buf = &s_glyph_draw_buf;
        }
        return binfont_set_fallback_buf(draw_buf);
    }

    /* After LV_SYMBOL_* is resolved by Montserrat, dsc->gid.index belongs to fallback font space.
     * LVGL may still call main-font get_glyph_bitmap; interpreting that gid with Flash loca can overflow.
     * LV_SYMBOL委托后gid属于fallback索引空间，按Flash loca解释会越界。 */
    if (dsc->resolved_font != NULL && dsc->resolved_font != &s_binfont_lvgl)
    {
        const lv_font_t *rf = dsc->resolved_font;
        if (rf->get_glyph_bitmap != NULL)
        {
            return rf->get_glyph_bitmap(dsc, draw_buf);
        }
    }

    if (!s_initialized)
    {
        LOG_WRN("get_glyph_bitmap: s_initialized=0, dsc=%p", (void *)dsc);
        if (!draw_buf)
        {
            draw_buf = &s_glyph_draw_buf;
        }
        return binfont_set_fallback_buf(draw_buf);
    }

    if (!draw_buf)
    {
        draw_buf = &s_glyph_draw_buf;
    }

    const uint32_t glyph_id = dsc->gid.index;

    if (glyph_id >= s_loca_count || dsc->box_w == 0 || dsc->box_h == 0)
    {
        /* Fallback glyphs (e.g. LV_SYMBOL) may still arrive here:
         * gid is from fallback-font index space and appears out-of-range for current Flash loca.
         * Safely forward after draw_buf is ready to avoid placeholder rendering.
         * fallback字形可能误入主字体回调，这里安全转发避免占位框。 */
        if (s_binfont_lvgl.fallback != NULL && s_binfont_lvgl.fallback->get_glyph_bitmap != NULL)
        {
            lv_font_glyph_dsc_t fb_dsc = *dsc;
            fb_dsc.resolved_font = s_binfont_lvgl.fallback;
            LOG_DBG("get_glyph_bitmap: delegate gid=%u to fallback @%p", glyph_id, (void *)s_binfont_lvgl.fallback);
            return s_binfont_lvgl.fallback->get_glyph_bitmap(&fb_dsc, draw_buf);
        }

        LOG_ERR("get_glyph_bitmap: glyph_id=%u out of range or zero size, returning placeholder", glyph_id);
        return binfont_set_fallback_buf(draw_buf);
    }

    if (s_font_header.compression_id != 0)
    {
        LOG_WRN("compressed binfont not supported, compression_id=%u", s_font_header.compression_id);
        return binfont_set_fallback_buf(draw_buf);
    }

    /* === Cache hit: return previously decoded A8 bitmap, zero flash reads === */
    int cslot = gcache_find_by_gid(glyph_id);
    if (cslot >= 0 && s_gcache[cslot].bmp_size > 0)
    {
        glyph_cache_t *e = &s_gcache[cslot];
        e->lru_age = ++s_gcache_lru;
        s_pinned_slot = cslot;
        draw_buf->data = e->bmp;
        draw_buf->data_size = e->bmp_size;
        draw_buf->header.w = (lv_coord_t)e->box_w;
        draw_buf->header.h = (lv_coord_t)e->box_h;
        draw_buf->header.stride = e->bmp_stride;
        draw_buf->header.cf = LV_COLOR_FORMAT_A8;
        return draw_buf;
    }

    uint32_t glyph_offset = 0;
    uint32_t next_offset = s_glyf_length;

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

    const uint32_t record_bytes_full = next_offset - glyph_offset;
    if (record_bytes_full == 0)
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

    /* === Batch-read entire glyph record in one flash call, parse from RAM === */
    const off_t start = (off_t)(s_glyf_start_offset + glyph_offset);
    uint32_t record_bytes = record_bytes_full;
    if (record_bytes > MAX_GLYPH_RECORD_BYTES)
    {
        record_bytes = MAX_GLYPH_RECORD_BYTES;
    }
    if (read_bytes(start, s_glyph_raw_buf, record_bytes) != 0)
    {
        return binfont_set_fallback_buf(draw_buf);
    }

    memset(s_glyph_bitmap_buf, 0, out_size);
    mem_bit_iter_t bit_it = mem_bit_iter_init(s_glyph_raw_buf, record_bytes);
    int err = 0;

    /* Skip header bits (same parse order as get_glyph_dsc) / 跳过header位（顺序一致） */
    if (s_font_header.advance_width_bits != 0)
    {
        (void)mem_read_bits(&bit_it, s_font_header.advance_width_bits, &err);
        if (err)
            return binfont_set_fallback_buf(draw_buf);
    }

    {
        int16_t skip_ox, skip_oy;
        uint16_t skip_w, skip_h;
        binfont_read_bbox_after_adv(&bit_it, &err, &skip_ox, &skip_oy, &skip_w, &skip_h);
    }
    if (err)
    {
        return binfont_set_fallback_buf(draw_buf);
    }

#if IS_ENABLED(CONFIG_BINFONT_GLYPH_DEBUG)
    static int font_header_debug_count = 0;
    if (font_header_debug_count < 1)
    {
        LOG_INF("Font header debug: bpp=%u, compression_id=%u", s_font_header.bits_per_pixel,
                s_font_header.compression_id);
        font_header_debug_count++;
    }
#endif

    /* A8 opacity lookup tables (matching official lv_font_fmt_txt.c) */
    static const uint8_t opa2_table[4] = {0, 85, 170, 255};
    static const uint8_t opa4_table[16] = {0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255};

    /* Read pixels from RAM bitstream, ROW-MAJOR (LVGL). */
#if IS_ENABLED(CONFIG_BINFONT_GLYPH_DEBUG)
    static int raw_data_debug_count = 0;
    if (raw_data_debug_count < 2 && w <= 16 && h <= 16)
    {
        LOG_INF("Raw bitstream debug [%d]: glyph_id=%u, w=%u, h=%u, bpp=%u", raw_data_debug_count, glyph_id, w, h, bpp);
        LOG_INF("  First %u bytes from Flash:", record_bytes > 32 ? 32 : record_bytes);
        for (uint32_t i = 0; i < 32 && i < record_bytes; i += 16)
        {
            char hex_str[64] = {0};
            int idx = 0;
            for (uint32_t j = 0; j < 16 && i + j < record_bytes && i + j < 32; j++)
            {
                idx += snprintf(&hex_str[idx], 64 - idx, "%02X ", s_glyph_raw_buf[i + j]);
            }
            LOG_INF("    0x%02X: %s", i, hex_str);
        }
        raw_data_debug_count++;
    }
    static int raw_viz_debug_count = 0;
    if (raw_viz_debug_count < 1 && w <= 16 && h <= 16 && bpp == 1)
    {
        LOG_INF("Raw Flash bytes visualization [%d]: glyph_id=%u, w=%u, h=%u", raw_viz_debug_count, glyph_id, w, h);
        uint32_t header_bits = s_font_header.advance_width_bits + 2 * s_font_header.xy_bits + 2 * s_font_header.wh_bits;
        uint32_t bits_per_row = w * bpp;
        for (uint32_t y = 0; y < h && y < 16; y++)
        {
            char vis_str[32] = {0};
            uint32_t row_start_bit = header_bits + y * bits_per_row;
            uint32_t row_start_byte = row_start_bit / 8;
            uint32_t row_start_bit_offset = row_start_bit % 8;
            for (uint32_t x = 0; x < w && x < 31; x++)
            {
                uint32_t bit_pos = row_start_bit_offset + x;
                uint32_t byte_idx = row_start_byte + bit_pos / 8;
                if (byte_idx < record_bytes)
                {
                    uint8_t bit_val = (s_glyph_raw_buf[byte_idx] >> (7 - (bit_pos % 8))) & 1;
                    vis_str[x] = bit_val ? '#' : '.';
                }
            }
            LOG_INF("  Row %2u (raw): %s", y, vis_str);
        }
        raw_viz_debug_count++;
    }
#endif

    for (uint32_t y = 0; y < h; y++)
    {
        uint8_t *row = &s_glyph_bitmap_buf[y * row_stride];
        for (uint32_t x = 0; x < w; x++)
        {
            uint32_t px = mem_read_bits(&bit_it, bpp, &err);
            if (err)
                return binfont_set_fallback_buf(draw_buf);

            if (bpp == 1)
            {
#if IS_ENABLED(CONFIG_BINFONT_A1_INVERT)
                row[x] = px ? 0x00 : 0xFF;
#else
                row[x] = px ? 0xFF : 0x00;
#endif
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

#if IS_ENABLED(CONFIG_BINFONT_GLYPH_DEBUG)
    static int glyph_bitmap_stat_count = 0;
    if (glyph_bitmap_stat_count < 3)
    {
        uint32_t non_zero_count = 0;
        for (uint32_t i = 0; i < out_size; i++)
        {
            if (s_glyph_bitmap_buf[i] != 0)
            {
                non_zero_count++;
            }
        }
        LOG_INF("Glyph bitmap stat [%d]: glyph_id=%u, size=%u, non_zero=%u/%u (%u%%)", glyph_bitmap_stat_count,
                glyph_id, out_size, non_zero_count, out_size, out_size ? (non_zero_count * 100 / out_size) : 0);
        glyph_bitmap_stat_count++;
    }
    static int glyph_bitmap_debug_count = 0;
    if (glyph_bitmap_debug_count < 3 && w <= 16 && h <= 16)
    {
        LOG_INF("Glyph bitmap debug [%d]: glyph_id=%u, w=%u, h=%u, bpp=%u, row_stride=%u", glyph_bitmap_debug_count,
                glyph_id, w, h, bpp, row_stride);
        for (uint32_t y = 0; y < h; y++)
        {
            uint8_t *rowb = &s_glyph_bitmap_buf[y * row_stride];
            char vis_str[32] = {0};
            for (uint32_t x = 0; x < w && x < 31; x++)
            {
                vis_str[x] = rowb[x] ? '#' : '.';
            }
            LOG_INF("  Row %2u: %s", y, vis_str);
        }
        glyph_bitmap_debug_count++;
    }
#endif

    draw_buf->data = s_glyph_bitmap_buf;
    draw_buf->data_size = out_size;
    draw_buf->header.w = (lv_coord_t)w;
    draw_buf->header.h = (lv_coord_t)h;
    draw_buf->header.stride = row_stride;
    draw_buf->header.cf = LV_COLOR_FORMAT_A8;

    /* === Store decoded bitmap in LRU cache if it fits === */
    if (out_size <= GLYPH_CACHE_BMP_BYTES)
    {
        int cs = gcache_find_by_gid(glyph_id);
        if (cs < 0)
        {
            /* get_glyph_dsc may not have cached this (e.g. cache was full); evict now */
            cs = gcache_evict();
            if (cs >= 0)
            {
                s_gcache[cs].valid = true;
                s_gcache[cs].glyph_id = glyph_id;
                s_gcache[cs].unicode = 0;
                s_gcache[cs].adv_w = dsc->adv_w;
                s_gcache[cs].box_w = (uint8_t)w;
                s_gcache[cs].box_h = (uint8_t)h;
                s_gcache[cs].ofs_x = dsc->ofs_x;
                s_gcache[cs].ofs_y = dsc->ofs_y;
            }
        }
        if (cs >= 0)
        {
            glyph_cache_t *e = &s_gcache[cs];
            memcpy(e->bmp, s_glyph_bitmap_buf, out_size);
            e->bmp_size = out_size;
            e->bmp_stride = row_stride;
            e->lru_age = ++s_gcache_lru;
            s_pinned_slot = cs;
        }
    }

    return draw_buf;
}

/* LVGL callback: release glyph resource (static cache, so no local free)
 * LVGL回调：释放字形资源（静态缓存无需释放） */
static void mos_binfont_release_glyph(const lv_font_t *font, lv_font_glyph_dsc_t *dsc)
{
    ARG_UNUSED(font);
    if (dsc != NULL && dsc->resolved_font != NULL && dsc->resolved_font != &s_binfont_lvgl)
    {
        const lv_font_t *rf = dsc->resolved_font;
        if (rf->release_glyph != NULL)
        {
            rf->release_glyph(rf, dsc);
        }
    }
    s_pinned_slot = -1; /* Allow slot to be evicted by later glyphs / 允许后续回收缓存槽 */
}

/* Static LVGL font instance
 * 静态LVGL字体实例 */
static lv_font_t s_binfont_lvgl = {
    .get_glyph_dsc = mos_binfont_get_glyph_dsc,
    .get_glyph_bitmap = mos_binfont_get_glyph_bitmap,
    .release_glyph = mos_binfont_release_glyph,
    .line_height = 0, /* Read and update from font header at runtime / 运行时从字体头读取 */
    .base_line = 0, /* Read and update from font header at runtime / 运行时从字体头读取 */
    .subpx = LV_FONT_SUBPX_NONE,
    .kerning = LV_FONT_KERNING_NONE,
    .underline_position = -2,
    .underline_thickness = 1,
    .dsc = NULL,
    .fallback = NULL, /* Set during runtime initialization / 运行时初始化时设置 */
    .user_data = NULL,
};

/* =============================================================
 * Multilingual support: internal implementation
 * 多语言支持：内部实现
 * ============================================================= */

/* Find partition ID by language and font size
 * 根据语言和字体大小查找分区ID */
static int find_partition_id(uint8_t language, uint8_t font_size)
{
    for (size_t i = 0; i < s_partition_map_count; i++)
    {
        if (s_partition_map[i].language == language && s_partition_map[i].font_size == font_size)
        {
            return s_partition_map[i].partition_id;
        }
    }
    return -ENODEV;
}

/* Internal init with specified partition ID
 * 内部初始化函数：指定分区ID */
static int mos_binfont_lvgl_init_with_partition(uint8_t partition_id)
{
    int ret;

    /* If already initialized with the same partition, return directly / 同分区已初始化则直接返回 */
    if (s_initialized && s_fa && s_fa->fa_id == partition_id)
    {
        LOG_DBG("Already initialized with partition %d", partition_id);
        return 0;
    }

    /* Switching partitions changes metrics; clear per-glyph warning cache. */
    adv_guard_warn_cache_reset();

    /* If initialized with different partition, clean up first / 不同分区先清理 */
    if (s_initialized)
    {
        LOG_INF("Switching from old partition to %d", partition_id);
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
    }

    /* Open target partition / 打开目标分区 */
    ret = flash_area_open(partition_id, &s_fa);
    if (ret != 0)
    {
        LOG_ERR("flash_area_open(partition %d) failed: %d", partition_id, ret);
        return ret;
    }

    size_t part_size = s_fa->fa_size;
    s_font_size_limit = part_size;

    /* Force-disable XIP: NS-side XIP read may trigger TF-M security faults; use flash_area_read streaming instead.
     * 强制关闭XIP，改用flash_area_read流式读取。 */
    s_use_xip = false;

    /* Read binfont header / 读取binfont header */
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
        LOG_ERR("Partition %d: no valid binfont (erased or wrong format). Program font .hex to partition.",
                partition_id);
        flash_area_close(s_fa);
        return -ENODEV;
    }
    LOG_INF("Partition %d - Head section: offset=0x0, len=%u, label='%c%c%c%c'", partition_id, head_len, label_buf[4],
            label_buf[5], label_buf[6], label_buf[7]);

    if (read_bytes(8, &s_font_header, sizeof(s_font_header)) != 0)
    {
        LOG_ERR("Failed to read font header");
        flash_area_close(s_fa);
        return -EIO;
    }

    /* Read cmap section / 读取cmap表 */
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

    LOG_INF("Partition %d - Cmap section: offset=0x%X, len=%u", partition_id, s_cmap_start_offset, cmap_len);

    uint8_t cmap_cnt_buf[4];
    if (read_bytes(s_cmap_start_offset + 8, cmap_cnt_buf, 4) != 0)
    {
        LOG_ERR("Failed to read cmap length");
        flash_area_close(s_fa);
        return -EIO;
    }
    s_cmap_count = sys_get_le32(cmap_cnt_buf);

    size_t tables_bytes = s_cmap_count * sizeof(cmap_table_bin_t);
    LOG_INF("Partition %d - Cmap tables: count=%u, total_bytes=%zu, bin_size=%u", partition_id, s_cmap_count,
            tables_bytes, sizeof(cmap_table_bin_t));
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

    /* Parse loca section (glyph position index) / 解析loca section（glyph位置索引） */
    s_loca_start_offset =
        s_cmap_start_offset
        + cmap_len; /* LVGL format: next section starts at current section start + length / LVGL格式规则 */
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

    LOG_INF("Partition %d - Loca count=%u, index_to_loc_format=%u", partition_id, s_loca_count,
            s_font_header.index_to_loc_format);

    s_loca_offsets_start = s_loca_start_offset + 12; /* 8-byte label + 4-byte count / 8字节label+4字节count */
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

    /* Parse glyf section (stores bitmap data) / 解析glyf section（存储bitmap数据） */
    s_glyf_start_offset = s_loca_start_offset + loca_len;
    if (s_font_size_limit > 0 && s_glyf_start_offset >= s_font_size_limit)
    {
        LOG_ERR("Font size (%zu) > partition size (%zu); clamp", s_font_size_limit, part_size);
        flash_area_close(s_fa);
        return -EINVAL;
    }
    LOG_INF("Partition %d - Glyf expected at offset 0x%X (loca_start=0x%X + loca_len=%u)", partition_id,
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
    LOG_INF("Partition %d - Glyf section: offset=0x%X, len=%u (data_off=0x%X data_len=%u)", partition_id,
            s_glyf_start_offset, s_glyf_length, s_glyf_data_offset, s_glyf_data_length);

    /* Update LVGL font metrics (prefer min/max to avoid baseline/line-height artifacts)
     * 更新LVGL字体参数（优先用min/max，避免基线/行高偏差导致重影） */
    int32_t min_y = (int32_t)s_font_header.min_y;
    int32_t max_y = (int32_t)s_font_header.max_y;
    int32_t line_height = max_y - min_y;
    int32_t base_line = -min_y;

    LOG_INF("Metrics from font header: min_y=%d, max_y=%d, ascent=%d, descent=%d, typo_ascent=%d, typo_descent=%d",
            s_font_header.min_y, s_font_header.max_y, s_font_header.ascent, s_font_header.descent,
            s_font_header.typo_ascent, s_font_header.typo_descent);
    LOG_INF("Advance: default=%u, format=%u, adv_w_bits=%u", s_font_header.default_advance_width,
            s_font_header.advance_width_format, s_font_header.advance_width_bits);
    LOG_INF("Initial calc: line_height=%d, base_line=%d", line_height, base_line);

    if (line_height <= 0)
    {
        line_height = (int32_t)s_font_header.font_size;
        LOG_INF("line_height invalid, using font_size=%d", line_height);
    }
    if (line_height <= 0)
    {
        line_height = (int32_t)s_font_header.ascent - (int32_t)s_font_header.descent;
        LOG_INF("line_height still invalid, using ascent-descent=%d", line_height);
    }
    if (line_height <= 0)
    {
        line_height = 18; /* Final fallback to avoid abnormal values / 最终兜底 */
        LOG_INF("line_height still invalid, using fallback=18");
    }

    if (base_line < 0 || base_line > line_height)
    {
        LOG_INF("base_line invalid (%d), trying ascent=%d", base_line, s_font_header.ascent);
        base_line = (int32_t)s_font_header.ascent;
        if (base_line < 0 || base_line > line_height)
        {
            LOG_INF("base_line still invalid, setting to 0");
            base_line = 0;
        }
    }

    s_binfont_lvgl.line_height = line_height;
    s_binfont_lvgl.base_line = base_line;
    LOG_INF("Final font metrics: line_height=%d, base_line=%d (ascent=%d, descent=%d)", line_height, base_line,
            s_font_header.ascent, s_font_header.descent);

#if defined(CONFIG_LV_FONT_MONTSERRAT_18)
    /* Fallback icons/missing glyphs to Montserrat 18 (aligned with prj.conf)
     * 图标/缺字回退到Montserrat 18 */
    s_binfont_lvgl.fallback = &lv_font_montserrat_18;
    /* Default to binfont header line_height/base_line.
     * Forcing Montserrat metrics can break glyf ofs_y vs line-box relation and cause overlap.
     * Enable CONFIG_BINFONT_SYNC_LINE_METRICS_MONTSERRAT18 only when symbol mixing requires it.
     * 默认用binfont行高/基线；强行对齐Montserrat可能导致重叠，仅在符号混排确需时启用。 */
#if IS_ENABLED(CONFIG_BINFONT_SYNC_LINE_METRICS_MONTSERRAT18)
    if (s_font_header.font_size == 18)
    {
        s_binfont_lvgl.line_height = lv_font_montserrat_18.line_height;
        s_binfont_lvgl.base_line = lv_font_montserrat_18.base_line;
        LOG_INF("BINFONT_SYNC_LINE_METRICS: line_height=%d base_line=%d", (int)s_binfont_lvgl.line_height,
                (int)s_binfont_lvgl.base_line);
    }
#endif
#endif

    s_initialized = true;
    memset(s_gcache, 0, sizeof(s_gcache));
    s_gcache_lru = 0;
    s_pinned_slot = -1;
    LOG_INF("========================================");
    LOG_INF("Partition %d - Binfont LVGL init SUCCESS!", partition_id);
    LOG_INF("Font: size=%u, cmap_tables=%u", s_font_header.font_size, s_cmap_count);
    LOG_INF("Header: adv_w_bits=%u, xy_bits=%u, wh_bits=%u, bpp=%u, compression_id=%u (0=raw)",
            s_font_header.advance_width_bits, s_font_header.xy_bits, s_font_header.wh_bits,
            s_font_header.bits_per_pixel, s_font_header.compression_id);
    LOG_INF("Metrics: font_size=%u, ascent=%d, descent=%d, line_height=%d, base_line=%d", s_font_header.font_size,
            s_font_header.ascent, s_font_header.descent, line_height, base_line);
    LOG_INF("Loca: count=%u, format=%u", s_loca_count, s_font_header.index_to_loc_format);
    LOG_INF("Glyf: offset=0x%X, len=%u (data_off=0x%X data_len=%u)", s_glyf_start_offset, s_glyf_length,
            s_glyf_data_offset, s_glyf_data_length);
    LOG_INF("========================================");

    return 0;
}

int mos_binfont_lvgl_init(void)
{
    binfont_clamp_boot_en_size_once();
    /* Default init: use current language and font size (boot defaults come from Kconfig)
     * 默认初始化使用当前语言和字号（上电初值来自Kconfig） */
    return mos_binfont_lvgl_init_with_partition(find_partition_id(s_current_language, s_current_font_size));
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
    memset(s_gcache, 0, sizeof(s_gcache));
    s_pinned_slot = -1;
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
    LOG_DBG("mos_binfont_get_lvgl_font: s_initialized=%d", s_initialized);

    if (!s_initialized)
    {
        if (mos_binfont_lvgl_init() != 0)
        {
            LOG_ERR("mos_binfont_lvgl_init FAILED!");
            return NULL;
        }
    }

    LOG_DBG("mos_binfont_get_lvgl_font: return @%p fallback=%p", (void *)&s_binfont_lvgl,
            (void *)s_binfont_lvgl.fallback);
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

/* =============================================================
 * Multilingual public API implementation
 * 多语言公共API实现
 * ============================================================= */

int mos_binfont_switch_language(uint8_t language, uint8_t font_size)
{
    int ret;

    LOG_INF("Switching font: language=%u, font_size=%u", language, font_size);

    /* Align with external partitions: only Simplified Chinese and English are supported.
     * 与外置分区一致：仅简体中文、英语 */
    if (language != MOS_FONT_LANG_ZH_CN && language != MOS_FONT_LANG_EN_US)
    {
        LOG_ERR("Invalid language: %u (only zh_cn=%u, en_us=%u)", language, MOS_FONT_LANG_ZH_CN, MOS_FONT_LANG_EN_US);
        return -EINVAL;
    }

    /* Supported font sizes: 16, 18, 20, 22, 24, 26 / 支持的字体大小 */
    if (font_size != 16 && font_size != 18 && font_size != 20 && font_size != 22 && font_size != 24 && font_size != 26)
    {
        LOG_ERR("Invalid font size: %u", font_size);
        return -EINVAL;
    }

    /* Find matching partition ID / 查找对应分区ID */
    int partition_id = find_partition_id(language, font_size);
    if (partition_id < 0)
    {
        LOG_ERR("Font not found for language=%u, size=%u", language, font_size);
        return partition_id;
    }

    /* Switch partition and reload font / 切换分区并重新加载字体 */
    ret = mos_binfont_lvgl_init_with_partition((uint8_t)partition_id);
    if (ret != 0)
    {
        LOG_ERR("Failed to init font for language=%u, size=%u: %d", language, font_size, ret);
        return ret;
    }

    /* Update current runtime state / 更新当前状态 */
    s_current_language = language;
    s_current_font_size = font_size;

    LOG_INF("Font switched successfully to language=%u, size=%u", language, font_size);
    return 0;
}

uint8_t mos_binfont_get_current_language(void)
{
    return s_current_language;
}

uint8_t mos_binfont_get_current_size(void)
{
    return s_current_font_size;
}

int mos_binfont_get_current_partition_data(off_t offset, void *buf, size_t len)
{
    if (!s_initialized || !s_fa || !buf || len == 0)
    {
        return -EINVAL;
    }

    int ret = flash_area_read(s_fa, offset, buf, len);
    if (ret != 0)
    {
        LOG_ERR("flash_area_read failed: offset=%ld len=%zu ret=%d", (long)offset, len, ret);
        return ret;
    }

    return 0;
}

int mos_binfont_get_current_partition_id(void)
{
    for (size_t i = 0; i < s_partition_map_count; i++)
    {
        if (s_partition_map[i].language == s_current_language && s_partition_map[i].font_size == s_current_font_size)
        {
            return s_partition_map[i].partition_id;
        }
    }
    return -ENOENT;
}

bool mos_binfont_is_initialized(void)
{
    return s_initialized;
}

uint16_t mos_binfont_get_font_size(void)
{
    return s_initialized ? s_font_header.font_size : 0;
}

int16_t mos_binfont_get_ascent(void)
{
    return s_initialized ? s_font_header.ascent : 0;
}

int16_t mos_binfont_get_descent(void)
{
    return s_initialized ? s_font_header.descent : 0;
}

uint8_t mos_binfont_get_glyph_id_format(void)
{
    return s_initialized ? s_font_header.glyph_id_format : 0;
}

uint8_t mos_binfont_get_bits_per_pixel(void)
{
    return s_initialized ? s_font_header.bits_per_pixel : 0;
}

#endif /* CONFIG_LVGL */

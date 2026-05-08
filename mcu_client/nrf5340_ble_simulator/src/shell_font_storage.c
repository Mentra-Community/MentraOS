#include <pm_config.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>
#include <zephyr/storage/flash_map.h>
#if defined(CONFIG_LVGL)
#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"
#include "mos_display.h"
#endif

LOG_MODULE_REGISTER(shell_font_storage, LOG_LEVEL_INF);

#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif

#define FONT_READ_MAX 256
#define GLYPH_DUMP_MAX 512

static int cmd_font_storage_info(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

#if defined(CONFIG_LVGL)
    /* 获取当前使用的字体信息 */
    mos_font_language_t lang = mos_font_get_current_language();
    mos_font_size_t size = mos_font_get_current_size();

    shell_print(shell, "Current font configuration:");
    shell_print(shell, "  Language: %d", lang);
    shell_print(shell, "  Font Size: %dpt", size);

    /* 查找当前分区 ID ; find current partition ID */
    int partition_id = mos_binfont_get_current_partition_id();
    if (partition_id < 0)
    {
        shell_print(shell, "  Error: failed to get partition ID: %d", partition_id);
        return -ENODEV;
    }

    /* 打开当前分区获取详细信息 ; open current partition for detailed info */
    const struct flash_area *fa;
    int ret = flash_area_open(partition_id, &fa);
    if (ret != 0)
    {
        shell_print(shell, "  Error: failed to open partition %d: %d", partition_id, ret);
        return ret;
    }

    shell_print(shell, "  Partition ID: %d", partition_id);
    shell_print(shell, "  Partition Address: 0x%08lX", (unsigned long)fa->fa_off);
    shell_print(shell, "  XIP Address: 0x%08lX", PM_QSPI_NOR_BASE_ADDRESS + fa->fa_off);
    shell_print(shell, "  Partition Size: %u bytes (%.1f KB)", (unsigned int)fa->fa_size, fa->fa_size / 1024.0);
    shell_print(shell, "  Partition End: 0x%08lX", fa->fa_off + fa->fa_size);

    flash_area_close(fa);

    /* 如果字库已初始化,显示字库头信息 ; if the font library is initialized, display the font header information */
    if (mos_binfont_is_initialized())
    {
        shell_print(shell, "");
        shell_print(shell, "Font binfont header:");
        shell_print(shell, "  Font Size: %dpt", mos_binfont_get_font_size());
        shell_print(shell, "  Ascent: %d, Descent: %d", mos_binfont_get_ascent(), mos_binfont_get_descent());
        shell_print(shell, "  Glyph ID Format: %d-bit", mos_binfont_get_glyph_id_format());
        shell_print(shell, "  Bits Per Pixel: %d", mos_binfont_get_bits_per_pixel());
    }
#else
    /* 非 LVGL 环境，显示默认分区信息 ; in non-LVGL environment, display default partition info */
    const struct flash_area *fa;
    int ret = flash_area_open(FIXED_PARTITION_ID(font_storage_zh_cn_18), &fa);
    if (ret != 0)
    {
        shell_print(shell, "❌ flash_area_open(font_storage_zh_cn_18) failed: %d", ret);
        return ret;
    }

    size_t size = fa->fa_size;
    const struct device *dev = flash_area_get_device(fa);
    const struct flash_parameters *params = dev ? flash_get_parameters(dev) : NULL;
    flash_area_close(fa);

    shell_print(shell, "font_storage_zh_cn_18 partition size: %u bytes", (unsigned int)size);
    if (dev && params)
    {
        shell_print(shell, "flash device write block: %u bytes", (unsigned int)params->write_block_size);
    }
#endif
    return 0;
}

static int cmd_font_storage_read(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 3)
    {
        shell_print(shell, "Usage: font_storage read <len> <offset>");
        return -EINVAL;
    }

    unsigned long len = strtoul(argv[1], NULL, 0);
    unsigned long off = strtoul(argv[2], NULL, 0);

    if (len == 0)
    {
        shell_print(shell, "len must be > 0");
        return -EINVAL;
    }

    if (len > FONT_READ_MAX)
    {
        shell_print(shell, "len too large, clamp to %u", FONT_READ_MAX);
        len = FONT_READ_MAX;
    }

    uint8_t buf[FONT_READ_MAX];

#if defined(CONFIG_LVGL)
    /* 使用当前激活的字体分区读取 ; use the currently active font partition */
    int ret = mos_binfont_get_current_partition_data((off_t)off, buf, (size_t)len);
    if (ret != 0)
    {
        shell_print(shell, "❌ Read failed: %d", ret);
        return ret;
    }
#else
    /* 非 LVGL 环境，使用默认分区 ; in non-LVGL environment, use the default partition */
    const struct flash_area *fa;
    int ret = flash_area_open(FIXED_PARTITION_ID(font_storage_zh_cn_18), &fa);
    if (ret != 0)
    {
        shell_print(shell, "❌ flash_area_open failed: %d", ret);
        return ret;
    }

    ret = flash_area_read(fa, (off_t)off, buf, len);
    flash_area_close(fa);
    if (ret != 0)
    {
        shell_print(shell, "❌ flash_area_read failed: %d", ret);
        return ret;
    }
#endif

    shell_print(shell, "Read %lu bytes from offset 0x%lX:", len, off);
    shell_hexdump(shell, buf, len);
    return 0;
}

#if defined(CONFIG_LVGL)

static const char *lang_code_to_str(mos_font_language_t lang)
{
    switch (lang)
    {
        case MOS_FONT_LANG_ZH_CN:
            return "zh_cn (简体中文, 18pt)";
        case MOS_FONT_LANG_EN_US:
            return "en_us (English)";
        default:
            return "unknown";
    }
}

static const char *biz_lang_to_str(display_biz_lang_t lang)
{
    switch (lang)
    {
        case DISPLAY_BIZ_LANG_ZH:
            return "zh";
        case DISPLAY_BIZ_LANG_EN:
            return "en";
        case DISPLAY_BIZ_LANG_KO:
            return "ko";
        case DISPLAY_BIZ_LANG_JA:
            return "ja";
        default:
            return "unknown";
    }
}

static display_biz_lang_t str_to_biz_lang(const char *str)
{
    if (strcmp(str, "zh") == 0 || strcmp(str, "zh_cn") == 0)
        return DISPLAY_BIZ_LANG_ZH;
    if (strcmp(str, "en") == 0 || strcmp(str, "en_us") == 0)
        return DISPLAY_BIZ_LANG_EN;
    if (strcmp(str, "ko") == 0 || strcmp(str, "ko_kr") == 0)
        return DISPLAY_BIZ_LANG_KO;
    if (strcmp(str, "ja") == 0 || strcmp(str, "ja_jp") == 0)
        return DISPLAY_BIZ_LANG_JA;
    return DISPLAY_BIZ_LANG_UNKNOWN;
}

static mos_font_language_t str_to_lang_code(const char *str)
{
    if (strcmp(str, "zh_cn") == 0 || strcmp(str, "zh") == 0)
        return MOS_FONT_LANG_ZH_CN;
    if (strcmp(str, "en_us") == 0 || strcmp(str, "en") == 0)
        return MOS_FONT_LANG_EN_US;
    return (mos_font_language_t)0;
}

static int cmd_font_storage_glyph(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_print(shell, "Usage: font_storage glyph <unicode_hex>  (e.g. glyph 0x4E2D for 中)");
        return -EINVAL;
    }

    unsigned long unicode = strtoul(argv[1], NULL, 0);
    if (unicode > 0x10FFFF)
    {
        shell_print(shell, "Invalid Unicode: 0x%lX", unicode);
        return -EINVAL;
    }

    if (mos_binfont_lvgl_init() != 0)
    {
        shell_print(shell, "Binfont init failed");
        return -ENODEV;
    }

    uint32_t glyph_id = 0;
    uint32_t start = 0;
    uint32_t len = 0;
    int ret = mos_binfont_debug_glyph_region((uint32_t)unicode, &glyph_id, &start, &len);
    if (ret != 0)
    {
        shell_print(shell, "U+%04lX not in font (ret=%d)", unicode, ret);
        return ret;
    }

    shell_print(shell, "U+%04lX glyph_id=%u offset=0x%X len=%u", unicode, glyph_id, start, len);
    if (len == 0)
    {
        shell_print(shell, "(empty glyph)");
        return 0;
    }

    size_t to_read = (len > GLYPH_DUMP_MAX) ? GLYPH_DUMP_MAX : len;
    uint8_t buf[GLYPH_DUMP_MAX];

    /* 使用当前激活的字体分区读取 */
    ret = mos_binfont_get_current_partition_data((off_t)start, buf, to_read);
    if (ret != 0)
    {
        shell_print(shell, "Read failed: %d", ret);
        return ret;
    }

    if (to_read < len)
    {
        shell_print(shell, "First %zu bytes (total %u):", to_read, len);
    }
    shell_hexdump(shell, buf, to_read);
    return 0;
}

static int cmd_font_storage_lang(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_print(shell, "Usage: font_storage lang <lang_code>");
        shell_print(shell, "  lang_code: zh_cn (18pt only), en_us (保留当前字号 16–26)");
        return -EINVAL;
    }

    mos_font_language_t lang = str_to_lang_code(argv[1]);
    if (lang == 0)
    {
        shell_print(shell, "Invalid language code: %s", argv[1]);
        shell_print(shell, "Available: zh_cn, en_us");
        return -EINVAL;
    }

    mos_font_size_t current_size = mos_font_get_current_size();
    mos_font_size_t size_for_switch = current_size;
    if (lang == MOS_FONT_LANG_ZH_CN)
    {
        size_for_switch = MOS_FONT_SIZE_18;
        if (current_size != MOS_FONT_SIZE_18)
        {
            shell_print(shell, "(简体中文仅外置 18pt，字号将使用 18)");
        }
    }

    int ret = mos_font_switch_language(lang, size_for_switch);
    if (ret != 0)
    {
        shell_print(shell, "❌ Failed to switch language: %d", ret);
        return ret;
    }

    shell_print(shell, "✓ Language switched to %s", lang_code_to_str(lang));
    return 0;
}

static int cmd_font_storage_size(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_print(shell, "Usage: font_storage size <font_size>");
        shell_print(shell, "  font_size: 16, 18, 20, 22, 24, 26");
        return -EINVAL;
    }

    unsigned long size = strtoul(argv[1], NULL, 10);
    if (size < 16 || size > 26 || (size % 2 != 0))
    {
        shell_print(shell, "Invalid font size: %lu", size);
        shell_print(shell, "Available: 16, 18, 20, 22, 24, 26");
        return -EINVAL;
    }

    mos_font_language_t current_lang = mos_font_get_current_language();
    if (current_lang == MOS_FONT_LANG_ZH_CN && size != 18UL)
    {
        shell_print(shell, "简体中文仅支持 18pt；请先 font_storage lang en_us 再调字号");
        return -EINVAL;
    }

    int ret = mos_font_switch_language(current_lang, (mos_font_size_t)size);
    if (ret != 0)
    {
        shell_print(shell, "❌ Failed to switch font size: %d", ret);
        return ret;
    }

    shell_print(shell, "✓ Font size switched to %lupt", size);
    return 0;
}

static int cmd_font_storage_status(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    mos_font_language_t lang = mos_font_get_current_language();
    mos_font_size_t size = mos_font_get_current_size();
    display_biz_lang_t src = DISPLAY_BIZ_LANG_UNKNOWN;
    display_biz_lang_t dst = DISPLAY_BIZ_LANG_UNKNOWN;
    display_get_translation_pair(&src, &dst);

    shell_print(shell, "Current font configuration:");
    shell_print(shell, "  Language: %s", lang_code_to_str(lang));
    shell_print(shell, "  Font Size: %dpt", size);
    shell_print(shell, "  Translation pair: %s -> %s", biz_lang_to_str(src), biz_lang_to_str(dst));
    return 0;
}

static int cmd_font_storage_pair(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 3)
    {
        shell_print(shell, "Usage: font_storage pair <src_lang> <dst_lang>");
        shell_print(shell, "  src/dst: zh, en, ko, ja");
        return -EINVAL;
    }

    display_biz_lang_t src = str_to_biz_lang(argv[1]);
    display_biz_lang_t dst = str_to_biz_lang(argv[2]);
    if (src == DISPLAY_BIZ_LANG_UNKNOWN || dst == DISPLAY_BIZ_LANG_UNKNOWN)
    {
        shell_print(shell, "Invalid pair: %s -> %s", argv[1], argv[2]);
        shell_print(shell, "Available: zh, en, ko, ja");
        return -EINVAL;
    }

    int ret = display_set_translation_pair(src, dst);
    if (ret != 0)
    {
        shell_print(shell, "❌ Failed to set translation pair: %d", ret);
        return ret;
    }

    shell_print(shell, "✓ Translation pair set: %s -> %s", biz_lang_to_str(src), biz_lang_to_str(dst));
    shell_print(shell, "  Note: font switching still depends on installed flash fonts.");
    return 0;
}


extern int run_font_switch_tests(void);

static int cmd_font_storage_test(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    shell_print(shell, "Running font switch tests...");
    int ret = run_font_switch_tests();

    if (ret == 0) {
        shell_print(shell, "✓ All tests passed!");
    } else {
        shell_print(shell, "❌ Tests failed: %d", ret);
    }

    return ret;
}
#endif

SHELL_STATIC_SUBCMD_SET_CREATE(
    font_storage_cmds, SHELL_CMD(info, NULL, "Show font_storage partition info", cmd_font_storage_info),
    SHELL_CMD(read, NULL, "Read bytes from font_storage: read <len> <offset>", cmd_font_storage_read),
#if defined(CONFIG_LVGL)
    SHELL_CMD(glyph, NULL, "Read glyph by Unicode: glyph <0xXXXX>", cmd_font_storage_glyph),
    SHELL_CMD(lang, NULL, "Switch language: lang <zh_cn|en_us> (zh uses 18pt)", cmd_font_storage_lang),
    SHELL_CMD(size, NULL, "Switch font size: size <16|18|20|22|24|26>", cmd_font_storage_size),
    SHELL_CMD(status, NULL, "Show current language and font size", cmd_font_storage_status),
    SHELL_CMD(pair, NULL, "Set translation pair: pair <zh|en|ko|ja> <zh|en|ko|ja>", cmd_font_storage_pair),
    SHELL_CMD(test, NULL, "Run font switch tests", cmd_font_storage_test),
#endif
    SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(font_storage, &font_storage_cmds, "Font storage commands", NULL);

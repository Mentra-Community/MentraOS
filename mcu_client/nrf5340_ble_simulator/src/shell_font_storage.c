/*
 * Shell Font Storage Module
 *
 * Commands:
 *   font_storage info
 *   font_storage read <len> <offset>
 *   font_storage glyph <unicode_hex>   (e.g. glyph 0x4E2D for 中, requires CONFIG_LVGL)
 */

#include <pm_config.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/drivers/flash.h>
#include <stdlib.h>
#if defined(CONFIG_LVGL)
#include "mos_binfont_lvgl.h"
#endif

LOG_MODULE_REGISTER(shell_font_storage, LOG_LEVEL_INF);

#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif

#define FONT_READ_MAX      256
#define GLYPH_DUMP_MAX     512

static int cmd_font_storage_info(const struct shell* shell, size_t argc, char** argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    const struct flash_area* fa;
#if defined(CONFIG_FONT_STORAGE_USE_PARTITION_2) && defined(PM_FONT_STORAGE2_ID)
    int                      ret = flash_area_open(PM_FONT_STORAGE2_ID, &fa);
#else
    int                      ret = flash_area_open(PM_FONT_STORAGE_ID, &fa);
#endif
    if (ret != 0)
    {
        shell_print(shell, "❌ flash_area_open(font_storage) failed: %d", ret);
        return ret;
    }

    size_t size = fa->fa_size;
    const struct device* dev = flash_area_get_device(fa);
    const struct flash_parameters* params = dev ? flash_get_parameters(dev) : NULL;
    flash_area_close(fa);

    shell_print(shell, "font_storage partition size: %u bytes", (unsigned int)size);
#if defined(CONFIG_FONT_STORAGE_USE_PARTITION_2) && defined(PM_FONT_STORAGE2_ADDRESS)
    shell_print(shell, "font_storage offset: 0x%X", (unsigned int)PM_FONT_STORAGE2_ADDRESS);
    shell_print(shell, "font_storage XIP addr: 0x%X",
                (unsigned int)(PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE2_ADDRESS));
#else
    shell_print(shell, "font_storage offset: 0x%X", (unsigned int)PM_FONT_STORAGE_ADDRESS);
    shell_print(shell, "font_storage XIP addr: 0x%X",
                (unsigned int)(PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE_ADDRESS));
#endif
    if (dev && params)
    {
        // shell_print(shell, "flash device size: %u bytes", (unsigned int)flash_get_size(dev));
        shell_print(shell, "flash device write block: %u bytes", (unsigned int)params->write_block_size);
    }
    else
    {
        shell_print(shell, "flash device size: (unavailable)");
    }
    return 0;
}

static int cmd_font_storage_read(const struct shell* shell, size_t argc, char** argv)
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

    const struct flash_area* fa;
#if defined(CONFIG_FONT_STORAGE_USE_PARTITION_2) && defined(PM_FONT_STORAGE2_ID)
    int                      ret = flash_area_open(PM_FONT_STORAGE2_ID, &fa);
#else
    int                      ret = flash_area_open(PM_FONT_STORAGE_ID, &fa);
#endif
    if (ret != 0)
    {
        shell_print(shell, "❌ flash_area_open(font_storage) failed: %d", ret);
        return ret;
    }

    ret = flash_area_read(fa, (off_t)off, buf, len);
    flash_area_close(fa);
    if (ret != 0)
    {
        shell_print(shell, "❌ flash_area_read failed: %d", ret);
        return ret;
    }

    shell_print(shell, "Read %lu bytes from offset 0x%lX:", len, off);
    shell_hexdump(shell, buf, len);
    return 0;
}

#if defined(CONFIG_LVGL)
static int cmd_font_storage_glyph(const struct shell* shell, size_t argc, char** argv)
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
    uint32_t start   = 0;
    uint32_t len     = 0;
    int      ret     = mos_binfont_debug_glyph_region((uint32_t)unicode, &glyph_id, &start, &len);
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

    const struct flash_area* fa;
#if defined(CONFIG_FONT_STORAGE_USE_PARTITION_2) && defined(PM_FONT_STORAGE2_ID)
    ret = flash_area_open(PM_FONT_STORAGE2_ID, &fa);
#else
    ret = flash_area_open(PM_FONT_STORAGE_ID, &fa);
#endif
    if (ret != 0)
    {
        shell_print(shell, "flash_area_open failed: %d", ret);
        return ret;
    }

    size_t to_read = (len > GLYPH_DUMP_MAX) ? GLYPH_DUMP_MAX : len;
    uint8_t buf[GLYPH_DUMP_MAX];
    ret = flash_area_read(fa, (off_t)start, buf, to_read);
    flash_area_close(fa);
    if (ret != 0)
    {
        shell_print(shell, "flash_area_read failed: %d", ret);
        return ret;
    }

    if (to_read < len)
    {
        shell_print(shell, "First %zu bytes (total %u):", to_read, len);
    }
    shell_hexdump(shell, buf, to_read);
    return 0;
}
#endif

SHELL_STATIC_SUBCMD_SET_CREATE(font_storage_cmds,
                               SHELL_CMD(info, NULL, "Show font_storage partition info", cmd_font_storage_info),
                               SHELL_CMD(read, NULL, "Read bytes from font_storage: read <len> <offset>",
                                         cmd_font_storage_read),
#if defined(CONFIG_LVGL)
                               SHELL_CMD(glyph, NULL, "Read glyph by Unicode: glyph <0xXXXX>", cmd_font_storage_glyph),
#endif
                               SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(font_storage, &font_storage_cmds, "Font storage commands", NULL);

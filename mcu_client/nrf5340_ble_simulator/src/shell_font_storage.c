/*
 * Shell Font Storage Module
 *
 * Commands:
 *   font_storage info
 *   font_storage read <len> <offset>
 */

#include <pm_config.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/drivers/flash.h>
#include <stdlib.h>

LOG_MODULE_REGISTER(shell_font_storage, LOG_LEVEL_INF);

#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif

#define FONT_READ_MAX 256

static int cmd_font_storage_info(const struct shell* shell, size_t argc, char** argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    const struct flash_area* fa;
    int                      ret = flash_area_open(PM_FONT_STORAGE_ID, &fa);
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
    shell_print(shell, "font_storage offset: 0x%X", (unsigned int)PM_FONT_STORAGE_ADDRESS);
    shell_print(shell, "font_storage XIP addr: 0x%X",
                (unsigned int)(PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE_ADDRESS));
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
    int                      ret = flash_area_open(PM_FONT_STORAGE_ID, &fa);
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

SHELL_STATIC_SUBCMD_SET_CREATE(font_storage_cmds,
                               SHELL_CMD(info, NULL, "Show font_storage partition info", cmd_font_storage_info),
                               SHELL_CMD(read, NULL, "Read bytes from font_storage: read <len> <offset>",
                                         cmd_font_storage_read),
                               SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(font_storage, &font_storage_cmds, "Font storage commands", NULL);

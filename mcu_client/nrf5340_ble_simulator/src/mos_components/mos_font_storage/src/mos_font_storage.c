/*
 * @Author       : Cole
 * @Date         : 2026-02-05 14:53:31
 * @LastEditTime : 2026-02-07 14:59:43
 * @FilePath     : mos_font_storage.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_font_storage.h"

#include <pm_config.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/flash_map.h>

// #include <lv_binfont_loader.h>

LOG_MODULE_REGISTER(mos_font_storage, LOG_LEVEL_INF);

#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif

#define FONT_STORAGE_XIP_ADDR (PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE_ADDRESS)

static lv_font_t *font_handle;
static void *font_buf;
static size_t font_size;
static bool font_loaded;

static bool font_storage_ready(void)
{
#if DT_NODE_EXISTS(DT_CHOSEN(nordic_pm_ext_flash))
    const struct device* dev = DEVICE_DT_GET(DT_CHOSEN(nordic_pm_ext_flash));
    return device_is_ready(dev);
#else
    return false;
#endif
}

int mos_font_storage_load(void)
{
    if (font_loaded)
    {
        return 0;
    }

#if defined(CONFIG_FONT_STORAGE_LOAD_AT_RUNTIME)
    if (!font_storage_ready())
    {
        LOG_WRN("font_storage not ready yet (QSPI not initialized)");
        return -EAGAIN;
    }
#endif

#if !LV_USE_FS_MEMFS
    LOG_ERR("LV_USE_FS_MEMFS disabled; enable CONFIG_LV_USE_FS_MEMFS");
    return -ENOTSUP;
#endif

    const struct flash_area* fa;
    int ret = flash_area_open(PM_FONT_STORAGE_ID, &fa);
    if (ret != 0)
    {
        LOG_ERR("flash_area_open(font_storage) failed: %d", ret);
        return ret;
    }

    size_t part_size  = fa->fa_size;
    size_t configured = (size_t)CONFIG_FONT_STORAGE_FILE_SIZE;
    size_t size       = configured ? configured : part_size;

    if (size > part_size)
    {
        LOG_WRN("Font size (%zu) > partition size (%zu); clamp", size, part_size);
        size = part_size;
    }

#if defined(CONFIG_FONT_STORAGE_USE_XIP)
    font_buf    = (void*)FONT_STORAGE_XIP_ADDR;
    font_size   = size;
    font_handle = lv_binfont_create_from_buffer(font_buf, (uint32_t)font_size);
    flash_area_close(fa);
    if (!font_handle)
    {
        LOG_ERR("lv_binfont_create_from_buffer failed (XIP)");
        return -EIO;
    }
    font_loaded = true;
    LOG_INF("font_storage loaded via XIP: addr=0x%08x size=%zu", (unsigned int)FONT_STORAGE_XIP_ADDR, font_size);
    return 0;
#else
    if (configured == 0)
    {
        flash_area_close(fa);
        LOG_ERR("CONFIG_FONT_STORAGE_FILE_SIZE not set for RAM load");
        return -EINVAL;
    }
    font_buf = k_malloc(size);
    if (!font_buf)
    {
        flash_area_close(fa);
        LOG_ERR("k_malloc failed for font size %zu", size);
        return -ENOMEM;
    }
    ret = flash_area_read(fa, 0, font_buf, size);
    flash_area_close(fa);
    if (ret != 0)
    {
        LOG_ERR("flash_area_read failed: %d", ret);
        k_free(font_buf);
        font_buf = NULL;
        return ret;
    }
    font_size   = size;
    font_handle = lv_binfont_create_from_buffer(font_buf, (uint32_t)font_size);
    if (!font_handle)
    {
        LOG_ERR("lv_binfont_create_from_buffer failed (RAM)");
        k_free(font_buf);
        font_buf = NULL;
        return -EIO;
    }
    font_loaded = true;
    LOG_INF("font_storage loaded into RAM: size=%zu", font_size);
    return 0;
#endif
}

bool mos_font_storage_is_loaded(void)
{
    return font_loaded;
}

void mos_font_storage_unload(void)
{
    if (font_handle)
    {
        lv_binfont_destroy(font_handle);
        font_handle = NULL;
    }

#if !defined(CONFIG_FONT_STORAGE_USE_XIP)
    if (font_buf)
    {
        k_free(font_buf);
        font_buf = NULL;
    }
#endif
	font_loaded = false;
	font_size = 0;
}

#if defined(CONFIG_LVGL)
const lv_font_t* mos_font_storage_get_lv_font(void)
{
    return font_loaded ? font_handle : NULL;
}
#endif

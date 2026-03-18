/*
 * @Author       : XK
 * @Date         : 2025-06-24 19:43:31
 * @LastEditTime : 2025-07-04 13:57:50
 * @FilePath     : protocol_image_cache.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include "bal_os.h"
#include "bsp_log.h"
#include "protocol_image_cache.h"

#define TAG "IMAGE_CACHE"

static struct k_mutex cache_mutex;
// 内部图片缓存区
static image_cache_slot_t g_slots[IMAGE_CACHE_SLOTS];

void image_cache_mutex_init(void)
{
    xyzn_os_mutex_create_init(&cache_mutex);
}

// 初始化缓存池
void image_cache_init(void)
{
    memset(g_slots, 0, sizeof(g_slots));
    image_cache_mutex_init();
}
// 插入或替换一张图片（如已存在同 stream_id 则覆盖，否则找空位）
bool image_cache_insert(uint16_t stream_id, const uint8_t *data, size_t len, const display_image_metadata_t *meta)
{
    if (!data || !meta || len == 0)
    {
        BSP_LOGW(TAG, "Invalid data or meta error");
        return false;
    }
    xyzn_os_mutex_lock(&cache_mutex, XYZN_OS_WAIT_FOREVER);
    int slot_idx = -1;

    // 查找是否已有该stream_id，优先覆盖旧图
    for (int i = 0; i < IMAGE_CACHE_SLOTS; ++i)
    {
        if (g_slots[i].used && g_slots[i].stream_id == stream_id)
        {
            slot_idx = i;
            break;
        }
    }
    // 没有则找一个空闲slot
    if (slot_idx < 0)
    {
        for (int i = 0; i < IMAGE_CACHE_SLOTS; ++i)
        {
            if (!g_slots[i].used)
            {
                slot_idx = i;
                break;
            }
        }
    }
    // 缓存满：直接覆盖第0张
    if (slot_idx < 0)
    {
        slot_idx = 0;
    }

    // 写入数据
    g_slots[slot_idx].used = true;
    g_slots[slot_idx].stream_id = stream_id;
    if (len > IMAGE_CACHE_IMAGE_MAX_SIZE)
    {
        BSP_LOGW(TAG, "[%s] Image size %u exceeds max size %u", (unsigned)len, IMAGE_CACHE_IMAGE_MAX_SIZE);
        len = IMAGE_CACHE_IMAGE_MAX_SIZE;
    }
    memcpy(g_slots[slot_idx].buffer, data, len);
    memcpy(&g_slots[slot_idx].meta, meta, sizeof(*meta));
    g_slots[slot_idx].length = len;
    BSP_LOGI(TAG, "插入图片缓冲成功 stream_id:0x%04X in slot %d", stream_id, slot_idx);
    xyzn_os_mutex_unlock(&cache_mutex);
}

// 查询某张图片（返回const指针，不可修改，没找到返回NULL）
const image_cache_slot_t *image_cache_get(uint16_t stream_id)
{
    xyzn_os_mutex_lock(&cache_mutex, XYZN_OS_WAIT_FOREVER);
    for (int i = 0; i < IMAGE_CACHE_SLOTS; ++i)
    {
        if (g_slots[i].used && g_slots[i].stream_id == stream_id)
        {
            BSP_LOGI(TAG, "找到图片缓冲 stream_id:0x%04X in slot %d", stream_id, i);
            xyzn_os_mutex_unlock(&cache_mutex);
            return &g_slots[i];
        }
    }
    BSP_LOGI(TAG, "没有找到 stream_id:0x%04X 图片", stream_id);
    xyzn_os_mutex_unlock(&cache_mutex);
    return NULL;
}

// 删除一张图片
bool image_cache_remove(uint16_t stream_id)
{
    for (int i = 0; i < IMAGE_CACHE_SLOTS; ++i)
    {
        if (g_slots[i].used && g_slots[i].stream_id == stream_id)
        {

            memset(&g_slots[i], 0, sizeof(image_cache_slot_t));
            BSP_LOGI(TAG, "删除图片缓冲 stream_id:0x%04X in slot %d", stream_id, i);
            return true;
        }
    }
    BSP_LOGI(TAG, "没有找到 stream_id:0x%04X 图片", stream_id);
    return false;
}

// 清空所有图片
void image_cache_clear_all(void)
{
    memset(g_slots, 0, sizeof(g_slots));
    // BSP_LOGI(TAG,"[%s] Cleared all cached images\n", TAG);
}

// 获取当前缓存张数
uint32_t image_cache_count(void)
{
    uint32_t cnt = 0;
    for (int i = 0; i < IMAGE_CACHE_SLOTS; ++i)
    {
        if (g_slots[i].used)
            cnt++;
    }
    return cnt;
}

// 获取slot直接指针地址
const image_cache_slot_t *image_cache_get_slot(int idx)
{
    if (idx < 0 || idx >= IMAGE_CACHE_SLOTS)
    {
        BSP_LOGW(TAG, "Invalid slot index %d", idx);
        return NULL;
    }
    if (g_slots[idx].used)
        return &g_slots[idx];
    return NULL;
}
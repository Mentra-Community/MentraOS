/*
 * @Author       : XK
 * @Date         : 2025-06-24 20:46:42
 * @LastEditTime : 2025-06-24 20:48:04
 * @FilePath     : protocol_image_flash.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include <zephyr/fs/fs.h>
#include "bsp_log.h"
#include "protocol_image_flash.h"

#define TAG "IMAGE_FLASH"

// 仅伪代码，实际需用LittleFS之类接口
void image_flash_save(const preload_image_metadata_t *meta, const uint8_t *data, size_t len)
{
    char path[64];
    snprintf(path, sizeof(path), "/lfs/img_%d.dat", meta->image_id);
    struct fs_file_t file;
    fs_file_t_init(&file);
    if (fs_open(&file, path, FS_O_CREATE | FS_O_WRITE) == 0)
    {
        fs_write(&file, data, len);
        fs_close(&file);
    }
}
bool image_flash_load(int image_id, uint8_t *buf, size_t buf_size, size_t *out_len)
{
    char path[64];
    snprintf(path, sizeof(path), "/lfs/img_%d.dat", image_id);
    struct fs_file_t file;
    fs_file_t_init(&file);
    if (fs_open(&file, path, FS_O_READ) != 0)
        return false;
    ssize_t read = fs_read(&file, buf, buf_size);
    fs_close(&file);
    if (read > 0)
    {
        *out_len = (size_t)read;
        return true;
    }
    return false;
}
void image_flash_remove(int image_id)
{
    char path[64];
    snprintf(path, sizeof(path), "/lfs/img_%d.dat", image_id);
    fs_unlink(path);
}
void image_flash_clear_all(void)
{
    // 遍历删除，略
}
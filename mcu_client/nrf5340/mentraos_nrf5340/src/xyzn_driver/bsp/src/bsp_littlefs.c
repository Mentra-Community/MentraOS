/*
 * @Author       : XK
 * @Date         : 2025-06-21 11:14:28
 * @LastEditTime : 2025-06-21 16:16:27
 * @FilePath     : bsp_littlefs.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include <stdio.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/fs/fs.h>
#include <zephyr/fs/littlefs.h>
#include <zephyr/storage/flash_map.h>

#include "bsp_littlefs.h"
#include "bsp_log.h"

#define TAG "BSP_LITTELFSLFS"

#define IMAGE_MOUNT_POINT "/lfs_img"
#define IMAGE_MAX_PATH_LEN 64

#define PARTITION_NODE DT_NODELABEL(lfs1)

#if DT_NODE_EXISTS(PARTITION_NODE)
FS_FSTAB_DECLARE_ENTRY(PARTITION_NODE);
#else  /* PARTITION_NODE */
FS_LITTLEFS_DECLARE_DEFAULT_CONFIG(storage);
static struct fs_mount_t lfs_storage_mnt = {
    .type = FS_LITTLEFS,
    .fs_data = &storage,
    .storage_dev = (void *)FIXED_PARTITION_ID(storage_partition),
    .mnt_point = "/lfs",
};
#endif /* PARTITION_NODE */

struct fs_mount_t *mountpoint =
#if DT_NODE_EXISTS(PARTITION_NODE)
    &FS_FSTAB_ENTRY(PARTITION_NODE)
#else
    &lfs_storage_mnt
#endif
    ;

// 从stream_id生成图像文件名（例如，“ img_002a.webp”）
static void image_build_filename1(uint16_t stream_id, char *out, size_t out_size)
{
    if (!out || out_size < sizeof(IMAGE_MOUNT_POINT) + 12)
    {
        BSP_LOGE(TAG, "Invalid buffer or size too small: out=%p, size=%zu err!", out, out_size);
        if (out && out_size > 0)
        {
            out[0] = 0; // 保守输出空字符串
        }
        return;
    }

    int written = snprintf(out, out_size, IMAGE_MOUNT_POINT "/img_%04X.webp", stream_id);
    if (written < 0 || (size_t)written >= out_size)
    {
        BSP_LOGE(TAG, "Filename truncated or snprintf err!");
        out[0] = 0;
    }
}
// Save complete image to LittleFS
int image_save_to_file(uint16_t stream_id, const uint8_t *data, size_t len)
{
    struct fs_file_t file;
    char path[IMAGE_MAX_PATH_LEN];
    fs_file_t_init(&file);

    // 构建文件名
    image_build_filename(stream_id, path, sizeof(path));

    // 打开文件，以创建和写入模式
    int ret = fs_open(&file, path, FS_O_CREATE | FS_O_WRITE);
    if (ret < 0)
    {
        BSP_LOGI(TAG, "[image_save] open failed: %d", ret);
        return ret;
    }
    ret = fs_write(&file, data, len);
    if (ret < 0)
    {
        BSP_LOGI(TAG, "[image_save] write failed: %d", ret);
    }
    else
    {
        BSP_LOGI(TAG, "[image_save] saved stream_id=%04X, size=%zu", stream_id, len);
    }

    fs_close(&file);
    return ret;
}

int image_read_from_file(uint16_t stream_id, uint8_t *buffer, size_t buffer_size)
{
    struct fs_file_t file;
    char path[IMAGE_MAX_PATH_LEN] = {0};
    fs_file_t_init(&file);

    // 构建文件路径
    image_build_filename(stream_id, path, sizeof(path));

    int ret = fs_open(&file, path, FS_O_READ);

    if (ret < 0)
    {
        BSP_LOGI(TAG, "[image_read] open failed: %d", ret);
        return ret;
    }

    // 从文件中读取数据
    ssize_t read = fs_read(&file, buffer, buffer_size);
    fs_close(&file);

    if (read < 0)
    {
        BSP_LOGI(TAG, "[image_read] read failed: %zd", read);
        return read;
    }

    BSP_LOGI(TAG, "[image_read] read %zd bytes from stream_id=%04X", read, stream_id);
    return read;
}

int image_delete_file(uint16_t stream_id)
{
    // 定义一个字符数组，用于存储路径
    char path[IMAGE_MAX_PATH_LEN] = {0};
    // 调用image_build_filename函数，将stream_id转换为路径，并存储在path中
    image_build_filename(stream_id, path, sizeof(path));

    // 调用fs_unlink函数，删除path中的文件
    int ret = fs_unlink(path);
    if (ret < 0)
    {
        BSP_LOGI(TAG, "[image_delete] failed: %d", ret);
    }
    else
    {
        BSP_LOGI(TAG, "[image_delete] deleted stream_id=%04X", stream_id);
    }
    return ret;
}

// List all stored images
void image_list_files(void)
{
    // 定义目录结构体和目录项结构体
    struct fs_dir_t dir;
    struct fs_dirent entry;
    // 初始化目录结构体
    fs_dir_t_init(&dir);

    if (fs_opendir(&dir, IMAGE_MOUNT_POINT) != 0)
    {
        BSP_LOGI(TAG, "[image_list] Failed to open dir");
        return;
    }

    // 读取目录中的文件
    while (fs_readdir(&dir, &entry) == 0 && entry.name[0] != 0)
    {
        // 如果文件名以"img_"开头
        if (strstr(entry.name, "img_") == entry.name)
        {
            // 打印文件名和文件大小
            BSP_LOGI(TAG, "[image_list] Found image: %s (%u bytes)", entry.name, entry.size);
        }
    }
    fs_closedir(&dir);
}

// Delete all image files
// 删除所有图片
void image_delete_all(void)
{
    // 定义目录结构体和目录项结构体
    struct fs_dir_t dir;
    struct fs_dirent entry;
    fs_dir_t_init(&dir);

    if (fs_opendir(&dir, IMAGE_MOUNT_POINT) != 0)
    {
        BSP_LOGI(TAG, "[image_delete_all] Failed to open dir");
        return;
    }

    // 遍历目录中的所有文件
    while (fs_readdir(&dir, &entry) == 0 && entry.name[0] != 0)
    {
        // 如果文件名以"img_"开头
        if (strstr(entry.name, "img_") == entry.name)
        {
            // 构造文件路径
            char path[IMAGE_MAX_PATH_LEN];
            snprintf(path, sizeof(path), IMAGE_MOUNT_POINT "/%s", entry.name);
            // 删除文件
            fs_unlink(path);
            BSP_LOGI(TAG, "[image_delete_all] Deleted: %s", entry.name);
        }
    }
    fs_closedir(&dir);
}

static int littlefs_flash_erase(unsigned int id)
{
    // 定义一个指向flash_area结构体的指针
    const struct flash_area *pfa;
    int rc;
    // 打开指定的flash区域
    rc = flash_area_open(id, &pfa);
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: unable to find flash area %u: %d", id, rc);
        return rc;
    }

    // 打印flash区域的详细信息
    BSP_LOGI(TAG, "Area %u at 0x%x on %s for %u bytes",
             id,
             (unsigned int)pfa->fa_off,
             pfa->fa_dev->name,
             (unsigned int)pfa->fa_size);

    /* Optional wipe flash contents */
    if (IS_ENABLED(CONFIG_APP_WIPE_STORAGE))
    {
        rc = flash_area_flatten(pfa, 0, pfa->fa_size);
        BSP_LOGE(TAG, "Erasing flash area ... %d", rc);
    }

    flash_area_close(pfa);
    return rc;
}
static int littlefs_mount(struct fs_mount_t *mp)
{
    int rc;

    rc = littlefs_flash_erase((uintptr_t)mp->storage_dev);
    if (rc < 0)
    {
        return rc;
    }

    /* Do not mount if auto-mount has been enabled */
#if !DT_NODE_EXISTS(PARTITION_NODE) || \
    !(FSTAB_ENTRY_DT_MOUNT_FLAGS(PARTITION_NODE) & FS_MOUNT_FLAG_AUTOMOUNT)
    rc = fs_mount(mp);
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: mount id %" PRIuPTR " at %s: %d\n",
                 (uintptr_t)mp->storage_dev, mp->mnt_point, rc);
        return rc;
    }
    BSP_LOGI(TAG, "%s mount: %d", mp->mnt_point, rc);
#else
    BSP_LOGI(TAG, "%s automounted", mp->mnt_point);
#endif

    return 0;
}

int bsp_littlefs_init(void)
{
    int rc = littlefs_mount(mountpoint);
    return rc;
}

/***************************TEST DEMO************************************ */
#if 1
#define TEST_FILE_SIZE 547
static uint8_t file_test_pattern[TEST_FILE_SIZE];
// 静态函数，用于列出指定路径下的文件和目录
static int lsdir(const char *path)
{
    // 定义返回值
    int res;
    // 定义目录结构体
    struct fs_dir_t dirp;
    // 定义目录项结构体
    static struct fs_dirent entry;

    // 初始化目录结构体
    fs_dir_t_init(&dirp);

    // 打开指定路径的目录
    res = fs_opendir(&dirp, path);
    if (res)
    {
        // 打开目录失败，打印错误信息
        BSP_LOGE(TAG, "Error opening dir %s [%d]", path, res);
        return res;
    }

    // 打印开始列出目录的信息
    BSP_LOGI(TAG, "Listing dir [%s] ...", path);
    // 循环读取目录项
    for (;;)
    {
        // 读取目录项
        res = fs_readdir(&dirp, &entry);

        // 如果读取目录项失败或者目录项为空，则退出循环
        if (res || entry.name[0] == 0)
        {
            // 如果读取目录项失败，打印错误信息
            if (res < 0)
            {
                BSP_LOGE(TAG, "Error reading dir [%d]", res);
            }
            break;
        }

        // 如果目录项是目录，则打印目录信息
        if (entry.type == FS_DIR_ENTRY_DIR)
        {
            BSP_LOGI(TAG, "[DIR ] %s", entry.name);
        }
        // 如果目录项是文件，则打印文件信息
        else
        {
            BSP_LOGI(TAG, "[FILE] %s (size = %zu)",
                     entry.name, entry.size);
        }
    }

    // 关闭目录
    fs_closedir(&dirp);

    // 返回结果
    return res;
}

// 函数：littlefs_increase_infile_value
// 功能：增加文件中的值
// 参数：fname - 文件名
// 返回值：0 - 成功，其他 - 失败
static int littlefs_increase_infile_value(char *fname)
{
    // 定义一个uint8_t类型的变量boot_count，用于存储文件中的值
    uint8_t boot_count = 0;
    // 定义一个fs_file_t类型的变量file，用于操作文件
    struct fs_file_t file;
    // 定义两个int类型的变量rc和ret，用于存储返回值
    int rc, ret;

    // 初始化file变量
    fs_file_t_init(&file);
    // 打开文件，以创建和读写模式
    rc = fs_open(&file, fname, FS_O_CREATE | FS_O_RDWR);
    // 如果打开文件失败，打印错误信息并返回错误码
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: open %s: %d", fname, rc);
        return rc;
    }

    // 从文件中读取boot_count的值
    rc = fs_read(&file, &boot_count, sizeof(boot_count));
    // 如果读取失败，打印错误信息并跳转到out标签
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: read %s: [rd:%d]", fname, rc);
        goto out;
    }
    // 打印读取到的boot_count的值
    BSP_LOGI(TAG, "%s read count:%u (bytes: %d)", fname, boot_count, rc);

    // 将文件指针移动到文件开头
    rc = fs_seek(&file, 0, FS_SEEK_SET);
    // 如果移动失败，打印错误信息并跳转到out标签
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: seek %s: %d", fname, rc);
        goto out;
    }

    // 将boot_count的值加1
    boot_count += 1;
    // 将新的boot_count的值写入文件
    rc = fs_write(&file, &boot_count, sizeof(boot_count));
    // 如果写入失败，打印错误信息并跳转到out标签
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: write %s: %d", fname, rc);
        goto out;
    }

    // 打印写入的新boot_count的值
    BSP_LOGI(TAG, "%s write new boot count %u: [wr:%d]", fname,
             boot_count, rc);

out:
    // 关闭文件
    ret = fs_close(&file);
    // 如果关闭文件失败，打印错误信息并返回错误码
    if (ret < 0)
    {
        BSP_LOGE(TAG, "FAIL: close %s: %d", fname, ret);
        return ret;
    }

    // 返回rc的值，如果rc小于0，则返回rc，否则返回0
    return (rc < 0 ? rc : 0);
}

// 静态函数，用于增加模式
static void incr_pattern(uint8_t *p, uint16_t size, uint8_t inc)
{
    // 填充值，默认为0x55
    uint8_t fill = 0x55;

    // 如果第一个字节为偶数，则填充值为0xAA
    if (p[0] % 2 == 0)
    {
        fill = 0xAA;
    }

    // 遍历模式数组，从第一个字节开始
    for (int i = 0; i < (size - 1); i++)
    {
        // 如果当前字节为8的倍数，则增加inc
        if (i % 8 == 0)
        {
            p[i] += inc;
        }
        // 否则，填充为fill
        else
        {
            p[i] = fill;
        }
    }

    // 最后一个字节增加inc
    p[size - 1] += inc;
}

static void init_pattern(uint8_t *p, uint16_t size)
{
    uint8_t v = 0x1;

    memset(p, 0x55, size);

    for (int i = 0; i < size; i += 8)
    {
        p[i] = v++;
    }

    p[size - 1] = 0xAA;
}

// 静态函数，用于调整LittleFS二进制文件
static int littlefs_binary_file_adj(char *fname)
{
    // 定义目录项结构体
    struct fs_dirent dirent;
    // 定义文件结构体
    struct fs_file_t file;
    // 定义返回值和错误码
    int rc, ret;

    // 初始化文件结构体
    fs_file_t_init(&file);

    // 打开文件，如果失败，则返回错误码
    rc = fs_open(&file, fname, FS_O_CREATE | FS_O_RDWR);
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: open %s: %d", fname, rc);
        return rc;
    }

    // 获取文件状态，如果失败，则返回错误码
    rc = fs_stat(fname, &dirent);
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: stat %s: %d", fname, rc);
        goto out;
    }

    // 如果文件不存在，则创建一个新文件
    if (rc == 0 && dirent.type == FS_DIR_ENTRY_FILE && dirent.size == 0)
    {
        BSP_LOGI(TAG, "Test file: %s not found, create one!", fname);

        init_pattern(file_test_pattern, sizeof(file_test_pattern)); // 默认
    }
    // 如果文件存在，则读取文件内容
    else
    {
        rc = fs_read(&file, file_test_pattern, sizeof(file_test_pattern));
        if (rc < 0)
        {
            BSP_LOGE(TAG, "FAIL: read %s: [rd:%d]", fname, rc);
            goto out;
        }
        // 增加文件内容
        incr_pattern(file_test_pattern, sizeof(file_test_pattern), 0x1);
    }

    // 打印文件内容
    BSP_LOGI(TAG, "------ FILE: %s ------", fname);
    BSP_LOG_BUFFER_HEXDUMP(TAG, file_test_pattern, sizeof(file_test_pattern), 0);
    // 将文件指针移动到文件开头
    rc = fs_seek(&file, 0, FS_SEEK_SET);
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: seek %s: %d", fname, rc);
        goto out;
    }

    // 将文件内容写回文件
    rc = fs_write(&file, file_test_pattern, sizeof(file_test_pattern));
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: write %s: %d", fname, rc);
    }

out:
    // 关闭文件
    ret = fs_close(&file);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "FAIL: close %s: %d", fname, ret);
        return ret;
    }

    // 返回错误码
    return (rc < 0 ? rc : 0);
}

void littlefs_test(void)
{
    /*************TEST******************** */
    struct fs_statvfs sbuf;
    char fname1[255];
    char fname2[255];
    snprintf(fname1, sizeof(fname1), "%s/boot_count", mountpoint->mnt_point);
    snprintf(fname2, sizeof(fname2), "%s/pattern.bin", mountpoint->mnt_point);

    int rc = fs_statvfs(mountpoint->mnt_point, &sbuf);
    if (rc < 0)
    {
        BSP_LOGE(TAG, "FAIL: statvfs: %d", rc);
        goto out;
    }

    BSP_LOGI(TAG, "%s: bsize = %lu ; frsize = %lu ; blocks = %lu ; bfree = %lu",
             mountpoint->mnt_point,
             sbuf.f_bsize,  // 最佳传输块大小
             sbuf.f_frsize, // 每块的大小
             sbuf.f_blocks, // 总块数
             sbuf.f_bfree); // 空闲块的数量

    rc = lsdir(mountpoint->mnt_point); // 列出指定路径下的文件和目录
    if (rc < 0)
    {
        BSP_LOGI(TAG, "FAIL: lsdir %s: %d", mountpoint->mnt_point, rc);
        goto out;
    }

    rc = littlefs_increase_infile_value(fname1); // 增加文件中的值
    if (rc)
    {
        goto out;
    }

    rc = littlefs_binary_file_adj(fname2); // 调整二进制文件
    if (rc)
    {
        goto out;
    }
out:
    // rc = fs_unmount(mountpoint);
    // BSP_LOGI(TAG, "%s unmount: %d", mountpoint->mnt_point, rc);
    return rc;
}

#endif
/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-20 09:30:32
 * @FilePath     : bsp_littlefs.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "bsp_littlefs.h"

#include <stdio.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/fs/fs.h>
#include <zephyr/fs/littlefs.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/flash_map.h>
#define LOG_MODULE_NAME BSP_LITTELFSLFS
LOG_MODULE_REGISTER(LOG_MODULE_NAME);


#define IMAGE_MOUNT_POINT  "/lfs_img"
#define IMAGE_MAX_PATH_LEN 64

#define PARTITION_NODE DT_NODELABEL(lfs1)

#if DT_NODE_EXISTS(PARTITION_NODE)
FS_FSTAB_DECLARE_ENTRY(PARTITION_NODE);
#else  /* PARTITION_NODE */
FS_LITTLEFS_DECLARE_DEFAULT_CONFIG(storage);
static struct fs_mount_t lfs_storage_mnt = {
    .type        = FS_LITTLEFS,
    .fs_data     = &storage,
    .storage_dev = (void *)FIXED_PARTITION_ID(storage_partition),
    .mnt_point   = "/lfs",
};
#endif /* PARTITION_NODE */

struct fs_mount_t *mountpoint =
#if DT_NODE_EXISTS(PARTITION_NODE)
    &FS_FSTAB_ENTRY(PARTITION_NODE)
#else
    &lfs_storage_mnt
#endif
    ;

// 从stream_id生成图像文件名（例如，“ img_002a.webp”）; Generate image file name from stream_id (e.g., "img_002a.webp")

static void image_build_filename1(uint16_t stream_id, char *out, size_t out_size)
{
    if (!out || out_size < sizeof(IMAGE_MOUNT_POINT) + 12)
    {
        LOG_ERR("Invalid buffer or size too small: out=%p, size=%zu err!", out, out_size);
        if (out && out_size > 0)
        {
            out[0] = 0;  // 保守输出空字符串; Conservatively output empty string
        }
        return;
    }

    int written = snprintf(out, out_size, IMAGE_MOUNT_POINT "/img_%04X.webp", stream_id);
    if (written < 0 || (size_t)written >= out_size)
    {
        LOG_ERR("Filename truncated or snprintf err!");
        out[0] = 0;
    }
}
// Save complete image to LittleFS
int image_save_to_file(uint16_t stream_id, const uint8_t *data, size_t len)
{
    struct fs_file_t file;
    char             path[IMAGE_MAX_PATH_LEN];
    fs_file_t_init(&file);

    // 构建文件名; Build file name

    image_build_filename(stream_id, path, sizeof(path));

    // 打开文件，以创建和写入模式; Open file in create and write mode

    int ret = fs_open(&file, path, FS_O_CREATE | FS_O_WRITE);
    if (ret < 0)
    {
        LOG_INF("[image_save] open failed: %d", ret);
        return ret;
    }
    ret = fs_write(&file, data, len);
    if (ret < 0)
    {
        LOG_INF("[image_save] write failed: %d", ret);
    }
    else
    {
        LOG_INF("[image_save] saved stream_id=%04X, size=%zu", stream_id, len);
    }

    fs_close(&file);
    return ret;
}

int image_read_from_file(uint16_t stream_id, uint8_t *buffer, size_t buffer_size)
{
    struct fs_file_t file;
    char             path[IMAGE_MAX_PATH_LEN] = {0};
    fs_file_t_init(&file);

    // 构建文件路径; Build file path

    image_build_filename(stream_id, path, sizeof(path));

    int ret = fs_open(&file, path, FS_O_READ);

    if (ret < 0)
    {
        LOG_INF("[image_read] open failed: %d", ret);
        return ret;
    }

    // 从文件中读取数据; Read data from file

    ssize_t read = fs_read(&file, buffer, buffer_size);
    fs_close(&file);

    if (read < 0)
    {
        LOG_INF("[image_read] read failed: %zd", read);
        return read;
    }

    LOG_INF("[image_read] read %zd bytes from stream_id=%04X", read, stream_id);
    return read;
}

int image_delete_file(uint16_t stream_id)
{
    // 定义一个字符数组，用于存储路径; Define a character array to store the path

    char path[IMAGE_MAX_PATH_LEN] = {0};
    // 调用image_build_filename函数，将stream_id转换为路径，并存储在path中; Call image_build_filename function to
    // convert stream_id to path and store in path

    image_build_filename(stream_id, path, sizeof(path));

    // 调用fs_unlink函数，删除path中的文件; Call fs_unlink function to delete the file in path

    int ret = fs_unlink(path);
    if (ret < 0)
    {
        LOG_INF("[image_delete] failed: %d", ret);
    }
    else
    {
        LOG_INF("[image_delete] deleted stream_id=%04X", stream_id);
    }
    return ret;
}

// List all stored images
void image_list_files(void)
{
    // 定义目录结构体和目录项结构体; Define directory structure and directory entry structure

    struct fs_dir_t  dir;
    struct fs_dirent entry;
    // 初始化目录结构体; Initialize directory structure

    fs_dir_t_init(&dir);

    if (fs_opendir(&dir, IMAGE_MOUNT_POINT) != 0)
    {
        LOG_INF("[image_list] Failed to open dir");
        return;
    }

    // 读取目录中的文件; Read files in directory

    while (fs_readdir(&dir, &entry) == 0 && entry.name[0] != 0)
    {
        // 如果文件名以"img_"开头; If file name starts with "img_"

        if (strstr(entry.name, "img_") == entry.name)
        {
            // 打印文件名和文件大小; Print file name and file size

            LOG_INF("[image_list] Found image: %s (%u bytes)", entry.name, entry.size);
        }
    }
    fs_closedir(&dir);
}

// 删除所有图片; Delete all images
void image_delete_all(void)
{
    // 定义目录结构体和目录项结构体; Define directory structure and directory entry structure

    struct fs_dir_t  dir;
    struct fs_dirent entry;
    fs_dir_t_init(&dir);

    if (fs_opendir(&dir, IMAGE_MOUNT_POINT) != 0)
    {
        LOG_INF("[image_delete_all] Failed to open dir");
        return;
    }

    // 遍历目录中的所有文件; Traverse all files in directory

    while (fs_readdir(&dir, &entry) == 0 && entry.name[0] != 0)
    {
        // 如果文件名以"img_"开头; If file name starts with "img_"

        if (strstr(entry.name, "img_") == entry.name)
        {
            // 构造文件路径; Construct file path
            char path[IMAGE_MAX_PATH_LEN];
            snprintf(path, sizeof(path), IMAGE_MOUNT_POINT "/%s", entry.name);
            // 删除文件; Delete file
            fs_unlink(path);
            LOG_INF("[image_delete_all] Deleted: %s", entry.name);
        }
    }
    fs_closedir(&dir);
}

static int littlefs_flash_erase(unsigned int id)
{
    // 定义一个指向flash_area结构体的指针; Define a pointer to flash_area structure

    const struct flash_area *pfa;
    int                      rc;
    // 打开指定的flash区域; Open the specified flash area

    rc = flash_area_open(id, &pfa);
    if (rc < 0)
    {
        LOG_ERR("FAIL: unable to find flash area %u: %d", id, rc);
        return rc;
    }

    // 打印flash区域的详细信息; Print detailed information of flash area
    LOG_INF("Area %u at 0x%x on %s for %u bytes", id, (unsigned int)pfa->fa_off, pfa->fa_dev->name,
            (unsigned int)pfa->fa_size);

    /* Optional wipe flash contents */
    if (IS_ENABLED(CONFIG_APP_WIPE_STORAGE))
    {
        rc = flash_area_flatten(pfa, 0, pfa->fa_size);
        LOG_ERR("Erasing flash area ... %d", rc);
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
#if !DT_NODE_EXISTS(PARTITION_NODE) || !(FSTAB_ENTRY_DT_MOUNT_FLAGS(PARTITION_NODE) & FS_MOUNT_FLAG_AUTOMOUNT)
    rc = fs_mount(mp);
    if (rc < 0)
    {
        LOG_ERR("FAIL: mount id %" PRIuPTR " at %s: %d\n", (uintptr_t)mp->storage_dev, mp->mnt_point, rc);
        return rc;
    }
    LOG_INF("%s mount: %d", mp->mnt_point, rc);
#else
    LOG_INF("%s automounted", mp->mnt_point);
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
// 静态函数，用于列出指定路径下的文件和目录; Static function to list files and directories under the specified path

static int lsdir(const char *path)
{
    int                     res;
    struct fs_dir_t         dirp;
    static struct fs_dirent entry;
    fs_dir_t_init(&dirp);

    res = fs_opendir(&dirp, path);
    if (res)
    {
        LOG_ERR("Error opening dir %s [%d]", path, res);
        return res;
    }

    LOG_INF("Listing dir [%s] ...", path);

    for (;;)
    {
        // 读取目录项; Read directory entry

        res = fs_readdir(&dirp, &entry);

        // 如果读取目录项失败或者目录项为空，则退出循环; If reading directory entry fails or entry is empty, exit loop

        if (res || entry.name[0] == 0)
        {
            // 如果读取目录项失败，打印错误信息; If reading directory entry fails, print error message

            if (res < 0)
            {
                LOG_ERR("Error reading dir [%d]", res);
            }
            break;
        }

        // 如果目录项是目录，则打印目录信息; If entry is directory, print directory info

        if (entry.type == FS_DIR_ENTRY_DIR)
        {
            LOG_INF("[DIR ] %s", entry.name);
        }
        // 如果目录项是文件，则打印文件信息; If entry is file, print file info

        else
        {
            LOG_INF("[FILE] %s (size = %zu)", entry.name, entry.size);
        }
    }
    fs_closedir(&dirp);

    return res;
}

static int littlefs_increase_infile_value(char *fname)
{
    uint8_t          boot_count = 0;
    struct fs_file_t file;
    int              rc, ret;
    fs_file_t_init(&file);
    rc = fs_open(&file, fname, FS_O_CREATE | FS_O_RDWR);
    if (rc < 0)
    {
        LOG_ERR("FAIL: open %s: %d", fname, rc);
        return rc;
    }

    rc = fs_read(&file, &boot_count, sizeof(boot_count));
    if (rc < 0)
    {
        LOG_ERR("FAIL: read %s: [rd:%d]", fname, rc);
        goto out;
    }
    LOG_INF("%s read count:%u (bytes: %d)", fname, boot_count, rc);

    rc = fs_seek(&file, 0, FS_SEEK_SET);
    if (rc < 0)
    {
        LOG_ERR("FAIL: seek %s: %d", fname, rc);
        goto out;
    }

    boot_count += 1;
    rc = fs_write(&file, &boot_count, sizeof(boot_count));
    if (rc < 0)
    {
        LOG_ERR("FAIL: write %s: %d", fname, rc);
        goto out;
    }

    LOG_INF("%s write new boot count %u: [wr:%d]", fname, boot_count, rc);

out:
    ret = fs_close(&file);
    if (ret < 0)
    {
        LOG_ERR("FAIL: close %s: %d", fname, ret);
        return ret;
    }

    return (rc < 0 ? rc : 0);
}

static void incr_pattern(uint8_t *p, uint16_t size, uint8_t inc)
{
    uint8_t fill = 0x55;
    if (p[0] % 2 == 0)
    {
        fill = 0xAA;
    }
    for (int i = 0; i < (size - 1); i++)
    {
        if (i % 8 == 0)
        {
            p[i] += inc;
        }
        else
        {
            p[i] = fill;
        }
    }

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

static int littlefs_binary_file_adj(char *fname)
{
    struct fs_dirent dirent;
    struct fs_file_t file;
    int              rc, ret;

    fs_file_t_init(&file);

    rc = fs_open(&file, fname, FS_O_CREATE | FS_O_RDWR);
    if (rc < 0)
    {
        LOG_ERR("FAIL: open %s: %d", fname, rc);
        return rc;
    }

    rc = fs_stat(fname, &dirent);
    if (rc < 0)
    {
        LOG_ERR("FAIL: stat %s: %d", fname, rc);
        goto out;
    }

    if (rc == 0 && dirent.type == FS_DIR_ENTRY_FILE && dirent.size == 0)
    {
        LOG_INF("Test file: %s not found, create one!", fname);

        init_pattern(file_test_pattern, sizeof(file_test_pattern));
    }
    else
    {
        rc = fs_read(&file, file_test_pattern, sizeof(file_test_pattern));
        if (rc < 0)
        {
            LOG_ERR("FAIL: read %s: [rd:%d]", fname, rc);
            goto out;
        }
        incr_pattern(file_test_pattern, sizeof(file_test_pattern), 0x1);
    }

    LOG_INF("------ FILE: %s ------", fname);
    LOG_HEXDUMP_INF(file_test_pattern, sizeof(file_test_pattern), "Hexdump:");
    rc = fs_seek(&file, 0, FS_SEEK_SET);
    if (rc < 0)
    {
        LOG_ERR("FAIL: seek %s: %d", fname, rc);
        goto out;
    }
    rc = fs_write(&file, file_test_pattern, sizeof(file_test_pattern));
    if (rc < 0)
    {
        LOG_ERR("FAIL: write %s: %d", fname, rc);
    }

out:
    ret = fs_close(&file);
    if (ret < 0)
    {
        LOG_ERR("FAIL: close %s: %d", fname, ret);
        return ret;
    }

    return (rc < 0 ? rc : 0);
}

void littlefs_test(void)
{
    /*************TEST******************** */
    struct fs_statvfs sbuf;
    char              fname1[255];
    char              fname2[255];
    snprintf(fname1, sizeof(fname1), "%s/boot_count", mountpoint->mnt_point);
    snprintf(fname2, sizeof(fname2), "%s/pattern.bin", mountpoint->mnt_point);

    int rc = fs_statvfs(mountpoint->mnt_point, &sbuf);
    if (rc < 0)
    {
        LOG_ERR("FAIL: statvfs: %d", rc);
        goto out;
    }

    LOG_INF("%s: bsize = %lu ; frsize = %lu ; blocks = %lu ; bfree = %lu", mountpoint->mnt_point,
            sbuf.f_bsize,   // 最佳传输块大小 Optimal transfer block size
            sbuf.f_frsize,  // 每块的大小 // Allocation unit size
            sbuf.f_blocks,  // 总块数// Size of FS in f_frsize units
            sbuf.f_bfree);  // 空闲块的数量// Number of free blocks

    rc = lsdir(mountpoint->mnt_point);
    if (rc < 0)
    {
        LOG_INF("FAIL: lsdir %s: %d", mountpoint->mnt_point, rc);
        goto out;
    }

    rc = littlefs_increase_infile_value(fname1);  // 增加文件中的值// Increase value in file
    if (rc)
    {
        goto out;
    }

    rc = littlefs_binary_file_adj(fname2);  // 调整二进制文件// Adjust binary file
    if (rc)
    {
        goto out;
    }
out:
    // rc = fs_unmount(mountpoint);
    // LOG_INF("%s unmount: %d", mountpoint->mnt_point, rc);
    return rc;
}

#endif
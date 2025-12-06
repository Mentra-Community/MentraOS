/*
 * @Author       : Cole
 * @Date         : 2025-12-03 11:37:55
 * @LastEditTime : 2025-12-06 15:07:33
 * @FilePath     : gx8002_update.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "gx8002_update.h"

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "bsp_gx8002.h"
#define GX8002_FIRMWARE_DATA_DEFINE  // 在此文件中定义固件数据
#include "gx8002_firmware_data.h"
#include "grus_i2c_boot.h"

LOG_MODULE_REGISTER(gx8002_update, LOG_LEVEL_INF);

// Current firmware version
static uint8_t gx8002_fm_current_version[] = {0, 0, 0, 3};

#define UPGRADE_DATA_BLOCK_SIZE  16
#define UPGRADE_FLASH_BLOCK_SIZE (1024 * 8)

#pragma pack(1)
typedef struct
{
    uint16_t chip_id;
    uint8_t  chip_type;
    uint8_t  chip_version;
    uint16_t boot_delay;
    uint8_t  baud_rate;
    uint8_t  reserved_1;
    uint32_t stage1_size;
    uint32_t stage2_baud_rate;
    uint32_t stage2_size;
    uint32_t stage2_checksum;
    uint8_t  reserved[8];
} boot_header_t;
#pragma pack()

static boot_header_t boot_header;
static uint8_t*      temp_boot_buf = NULL;
static int           boot_len = 0;
static int           fw_len = 0;
static uint8_t       data_buf[UPGRADE_FLASH_BLOCK_SIZE] = {0};

// Current firmware data pointer (set by gx8002_fw_update function)
// Note: firmware_data parameter is required, cannot be NULL
static const uint8_t* current_firmware_data = NULL;
static uint32_t       current_firmware_len = 0;

static uint8_t gx8002_is_little_endian(void)
{
    int      a = 0x11223344;
    uint8_t* p = (uint8_t*)&a;
    return (*p == 0x44) ? 1 : 0;
}

static uint32_t gx8002_switch_endian(uint32_t v)
{
    return (((v >> 0) & 0xff) << 24) | (((v >> 8) & 0xff) << 16) 
            | (((v >> 16) & 0xff) << 8) | (((v >> 24) & 0xff) << 0);
}

static uint32_t gx8002_be32_to_cpu(uint32_t v)
{
    if (gx8002_is_little_endian())
    {
        return gx8002_switch_endian(v);
    }
    else
    {
        return v;
    }
}

static uint8_t gx8002_parse_bootimg_header(void)
{
    LOG_INF("vad reading boot header ...");

    if (boot_len < sizeof(boot_header))
    {
        LOG_ERR("vad boot data too small, len=%d", boot_len);
        return 1;
    }

    memcpy((uint8_t*)&boot_header, grus_i2c_boot, sizeof(boot_header));

    boot_header.stage1_size      = gx8002_be32_to_cpu(boot_header.stage1_size);
    boot_header.chip_version     = gx8002_be32_to_cpu(boot_header.chip_version);
    boot_header.stage2_baud_rate = gx8002_be32_to_cpu(boot_header.stage2_baud_rate);
    boot_header.stage2_size      = gx8002_be32_to_cpu(boot_header.stage2_size);
    boot_header.stage2_checksum  = gx8002_be32_to_cpu(boot_header.stage2_checksum);

    LOG_INF("vad boot header: chip_id=0x%x, version=%d, stage1=%d, stage2=%d", boot_header.chip_id,
            boot_header.chip_version, boot_header.stage1_size, boot_header.stage2_size);

    return 0;
}

static uint8_t gx8002_download_bootimg_stage1(void)
{
    uint8_t wbuffer[UPGRADE_DATA_BLOCK_SIZE + 10] = {0};
    LOG_INF("vad start boot stage1,size=%d ...", boot_header.stage1_size);
    temp_boot_buf = (uint8_t*)grus_i2c_boot + sizeof(boot_header);
    uint8_t* temp = (uint8_t*)&boot_header.stage1_size;

    wbuffer[0] = temp[0];
    wbuffer[1] = temp[1];
    wbuffer[2] = temp[2];
    wbuffer[3] = temp[3];

    bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 4);

    int wsize = 0;
    int len   = 0;

    wsize = 0;
    while (wsize < boot_header.stage1_size)
    {
        if ((wsize + UPGRADE_DATA_BLOCK_SIZE) <= boot_header.stage1_size)
        {
            len = UPGRADE_DATA_BLOCK_SIZE;
        }
        else
        {
            len = boot_header.stage1_size - wsize;
        }

        memcpy(&wbuffer[0], temp_boot_buf, len);
        temp_boot_buf = temp_boot_buf + len;
        bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, len);

        wsize += len;
    }

    LOG_INF("vad download stage1 size: %d, waiting 0x46 ...", wsize);
    if (bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xA4, 0x46, 2000) == 0)
    {
        LOG_ERR("vad wait 0x46 error");
        return 0;
    }

    LOG_INF("vad get 0x46 !");
    LOG_INF("vad send 0x59, waiting 0x55 ...");

    wbuffer[0] = 0x59;
    if (bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 1))
    {
        if (bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xA0, 0x55, 1000))
        {
            LOG_INF("vad boot stage1 ok (get 0x55)!");
            return 1;
        }
        else
        {
            LOG_ERR("vad wait 0x55 error");
            return 0;
        }
    }
    else
    {
        return 0;
    }
}

static uint8_t gx8002_download_bootimg_stage2(void)
{
    uint32_t checksum = 0;
    uint32_t stage2_size = 0;
    int len = 0;
    int wsize = 0;

    uint8_t wbuffer[UPGRADE_DATA_BLOCK_SIZE + 10] = {0};

    LOG_INF("vad start boot stage2 ...");

    wbuffer[0] = 0xef;
    bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 1);
    if (!bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xa0, 0x78, 1000))
    {
        LOG_ERR("vad wait 0x78 err !");
        return 0;
    }

    LOG_INF("vad get 0x78 !");

    stage2_size = boot_header.stage2_size;
    checksum    = boot_header.stage2_checksum;

    if (checksum == 0 || stage2_size == 0)
    {
        LOG_ERR("vad stage2_size or checksum err ! stage2_size=%u, checksum=%u", stage2_size, checksum);
        return 0;
    }

    LOG_INF("vad send stage2 checksum: %d ...", checksum);
    uint8_t* temp = (uint8_t*)&checksum;
    wbuffer[0]    = temp[0];
    wbuffer[1]    = temp[1];
    wbuffer[2]    = temp[2];
    wbuffer[3]    = temp[3];
    bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 4);

    LOG_INF("vad send stage2 size: %d ...", stage2_size);
    temp       = (uint8_t*)&stage2_size;
    wbuffer[0] = temp[0];
    wbuffer[1] = temp[1];
    wbuffer[2] = temp[2];
    wbuffer[3] = temp[3];
    bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 4);

    LOG_INF("vad download boot stage2 ...");

    wsize = 0;
    while (wsize < stage2_size)
    {
        if ((wsize + UPGRADE_DATA_BLOCK_SIZE) <= stage2_size)
        {
            len = UPGRADE_DATA_BLOCK_SIZE;
        }
        else
        {
            len = stage2_size - wsize;
        }

        memcpy(&wbuffer[0], temp_boot_buf, len);
        temp_boot_buf = temp_boot_buf + len;
        bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, len);

        wsize += len;
        k_sleep(K_MSEC(5));

        if ((wsize % 1600) == 0 && wsize < stage2_size)
        {
            k_sleep(K_MSEC(20));
        }
    }

    LOG_INF("vad download stage2 size: %d, waiting 0x46 ...", wsize);
    if (!bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xa4, 0x46, 1000))
    {
        LOG_ERR("vad wait 0x46 err !");
        return 0;
    }
    LOG_INF("vad get 0x46, to send 0x58, waiting 0x55 ...");

    wbuffer[0] = 0x58;
    if (bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 1))
    {
        if (bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xA0, 0x55, 1000))
        {
            LOG_INF("vad boot stage2 ok (get 0x55)");
        }
        else
        {
            LOG_ERR("vad wait 0x55 error");
            return 0;
        }
    }
    else
    {
        return 0;
    }

    return 1;
}

static uint8_t gx8002_download_flashimg(void)
{
    int wsize = 0;
    int len = 0;
    int offset = 0;
    int img_size  = 0;
    int flash_block_size = UPGRADE_FLASH_BLOCK_SIZE;
    uint8_t wbuffer[16] = {0};

    img_size = fw_len;
    if (img_size == 0)
    {
        LOG_ERR("vad flash image size err !");
        return 0;
    }

    LOG_INF("vad flash image size = %d", img_size);

    uint8_t* temp = (uint8_t*)&offset;
    wbuffer[0]    = temp[0];
    wbuffer[1]    = temp[1];
    wbuffer[2]    = temp[2];
    wbuffer[3]    = temp[3];
    if (!bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 4))
    {
        LOG_ERR("vad send offset error");
        return 0;
    }

    LOG_INF("vad send flash img size: %d ...", img_size);
    temp       = (uint8_t*)&img_size;
    wbuffer[0] = temp[0];
    wbuffer[1] = temp[1];
    wbuffer[2] = temp[2];
    wbuffer[3] = temp[3];
    if (!bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 4))
    {
        LOG_ERR("vad send size error");
        return 0;
    }

    LOG_INF("vad send flash block size: %d ...", flash_block_size);
    temp       = (uint8_t*)&flash_block_size;
    wbuffer[0] = temp[0];
    wbuffer[1] = temp[1];
    wbuffer[2] = temp[2];
    wbuffer[3] = temp[3];
    if (!bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, wbuffer, 4))
    {
        LOG_ERR("vad send block size error");
        return 0;
    }

    LOG_INF("vad waiting 0x43 ...");
    if (!bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xA4, 0x43, 10000))
    {
        LOG_ERR("vad wait 0x43 err !");
        return 0;
    }

    LOG_INF("vad get 0x43 !");

    int read_offset = 0;
    memset(data_buf, 0, UPGRADE_FLASH_BLOCK_SIZE);
    int read_len   = 0;
    
    if (current_firmware_data == NULL || current_firmware_len == 0)
    {
        LOG_ERR("vad firmware data not set");
        return 0;
    }
    
    const uint8_t* fw_data = current_firmware_data;
    uint32_t fw_data_len = current_firmware_len;
    
    int block_size = (UPGRADE_FLASH_BLOCK_SIZE < (int)fw_data_len) 
                        ? UPGRADE_FLASH_BLOCK_SIZE : (int)fw_data_len;
    memcpy(data_buf, fw_data, block_size);
    read_len = block_size;

    if (read_len <= 0)
    {
        LOG_ERR("vad read first block error");
        return 0;
    }
    read_offset = read_len;

    wsize = 0;
    while (wsize < img_size)
    {
        if ((wsize + UPGRADE_DATA_BLOCK_SIZE) <= img_size)
        {
            len = UPGRADE_DATA_BLOCK_SIZE;
        }
        else
        {
            len = img_size - wsize;
        }

        if (!bsp_gx8002_iic_write_data(BSP_GX_DATA_ADDR, data_buf + (wsize % UPGRADE_FLASH_BLOCK_SIZE), len))
        {
            LOG_ERR("vad send flash data error, wsize=%d", wsize);
            return 0;
        }

        wsize += len;

        if ((wsize % UPGRADE_FLASH_BLOCK_SIZE) == 0 && wsize < img_size)
        {
            LOG_INF("vad download size: %d, waiting 0x44 ...", wsize);
            if (!bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xa4, 0x44, 1000))
            {
                LOG_ERR("vad wait 0x44 err !");
                return 0;
            }
            LOG_INF("vad get 0x44 !");

            memset(data_buf, 0, UPGRADE_FLASH_BLOCK_SIZE);
            int remaining  = img_size - read_offset;
            int block_size = (remaining > UPGRADE_FLASH_BLOCK_SIZE) ? UPGRADE_FLASH_BLOCK_SIZE : remaining;

            if (current_firmware_data == NULL || current_firmware_len == 0)
            {
                LOG_ERR("vad firmware data not set");
                return 0;
            }
            
            const uint8_t* fw_data = current_firmware_data;
            uint32_t fw_data_len = current_firmware_len;
            
            if (read_offset >= 0 && read_offset < (int)fw_data_len)
            {
                int remaining_data = (int)fw_data_len - read_offset;
                int copy_len       = (block_size < remaining_data) ? block_size : remaining_data;
                memcpy(data_buf, fw_data + read_offset, copy_len);
                read_len = copy_len;
            }
            else
            {
                LOG_ERR("vad read offset out of range, offset=%d, len=%d", read_offset, fw_data_len);
                read_len = 0;
            }

            if (read_len <= 0)
            {
                LOG_ERR("vad read next block error, offset=%d", read_offset);
                return 0;
            }
            read_offset += read_len;
        }

        k_sleep(K_MSEC(1));
    }

    LOG_INF("vad download size: %d, waiting 0x46 ...", wsize);
    if (!bsp_gx8002_iic_wait_reply(BSP_GX_CMD_ADDR, 0xa4, 0x46, 1000))
    {
        LOG_ERR("vad wait 0x46 err !");
        return 0;
    }

    LOG_INF("vad get 0x46 !");
    LOG_INF("vad flash image ok !");
    return 1;
}

uint8_t gx8002_fw_update(const uint8_t* firmware_data, uint32_t firmware_len)
{
    LOG_INF("vad fw update start ...");
    uint8_t version[4]  = {0};
    uint8_t need_update = 0;

    // Set firmware data source
    current_firmware_data = firmware_data;
    current_firmware_len = firmware_len;

    if (!bsp_gx8002_getversion(version))
    {
        LOG_ERR("vad version failed");
        return 0;
    }

    for (uint8_t k = 0; k < 4; k++)
    {
        if (gx8002_fm_current_version[k] < version[k])
        {
            need_update = 1;
            break;
        }
    }

    if (!need_update)
    {
        LOG_INF("vad is lastest version=%d.%d.%d.%d", version[0], version[1], version[2], version[3]);
        return 1;
    }

    boot_len = grus_i2c_boot_len;

    if (boot_len <= 0)
    {
        LOG_ERR("vad read boot file error, len=%d", boot_len);
        return 0;
    }
    LOG_INF("vad read boot file len=%d", boot_len);

    // Use provided firmware data (required)
    if (firmware_data == NULL || firmware_len == 0)
    {
        LOG_ERR("vad firmware data is required, cannot use default");
        return 0;
    }
    
    fw_len = firmware_len;
    LOG_INF("vad using firmware, size=%d", firmware_len);

    if (fw_len <= 0)
    {
        LOG_ERR("vad read firmware size error, len=%d", fw_len);
        return 0;
    }
    LOG_INF("vad firmware file size = %d", fw_len);

    if (gx8002_parse_bootimg_header() != 0)
    {
        LOG_ERR("vad parse boot header failed");
        return 0;
    }

    // Disable VAD interrupt to prevent I2C conflicts during firmware update
    LOG_INF("Disabling VAD interrupt during firmware update...");
    bsp_gx8002_vad_int_disable();
    
    // Stop I2S if running to free I2C bus
    extern int pdm_audio_stream_stop_i2s_only(void);
    pdm_audio_stream_stop_i2s_only();

    bsp_gx8002_reset();
    // Increased wait time after reset to allow chip to fully restart
    k_sleep(K_MSEC(10));
    
    if (!bsp_gx8002_handshake())
    {
        LOG_ERR("vad handshake failed");
        // Re-enable VAD interrupt even on failure
        bsp_gx8002_vad_int_re_enable();
        return 0;
    }
    if (!gx8002_download_bootimg_stage1())
    {
        LOG_ERR("vad download boot stage1 failed");
        // Re-enable VAD interrupt on failure
        bsp_gx8002_vad_int_re_enable();
        return 0;
    }

    if (!gx8002_download_bootimg_stage2())
    {
        LOG_ERR("vad download boot stage2 failed");
        // Re-enable VAD interrupt on failure
        bsp_gx8002_vad_int_re_enable();
        return 0;
    }

    if (!gx8002_download_flashimg())
    {
        LOG_ERR("vad download flash image failed");
        // Re-enable VAD interrupt on failure
        bsp_gx8002_vad_int_re_enable();
        return 0;
    }

    LOG_INF("vad fw update complete!");

    // Wait for chip to process the update and switch to normal mode
    // After firmware update, chip needs time to restart and load new firmware
    k_sleep(K_MSEC(2000));
    bsp_gx8002_reset();// Final reset to start new firmware
    k_sleep(K_MSEC(10));
    // Re-enable VAD interrupt after firmware update completes
    LOG_INF("Re-enabling VAD interrupt after firmware update...");
    bsp_gx8002_vad_int_re_enable();

    return 1;
}

/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 16:54:29
 * @FilePath     : bsp_log.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2025 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "bsp_log.h"
#include <stdarg.h>
#include <ctype.h>

#define TAG_BSP_LOG "BSP_LOG"

#define BYTES_PER_LINE 16

void bsp_log_buffer_hex_internal(const char *tag, const void *buffer, uint16_t buff_len, BSP_LOG_LEVEL_t log_level)
{
    if (buff_len == 0)
    {
        return;
    }
    // char temp_buffer[BYTES_PER_LINE + 3]; //for not-byte-accessible memory
    char hex_buffer[3 * BYTES_PER_LINE + 1] = {0};
    const char *ptr_line = NULL;
    int bytes_cur_line = 0;
    const char *temp = (const char *)buffer;

    do
    {
        if (buff_len > BYTES_PER_LINE)
        {
            bytes_cur_line = BYTES_PER_LINE;
        }
        else
        {
            bytes_cur_line = buff_len;
        }
        ptr_line = temp;

        for (int i = 0; i < bytes_cur_line; i++)
        {
            sprintf(hex_buffer + 3 * i, "%02x ", (uint8_t)ptr_line[i]);
        }
        BSP_LOG_LEVEL(log_level, tag, "%s", hex_buffer);
        temp += bytes_cur_line;
        buff_len -= bytes_cur_line;
    } while (buff_len);
}

void bsp_log_buffer_char_internal(const char *tag, const void *buffer, uint16_t buff_len, BSP_LOG_LEVEL_t log_level)
{
    if (buff_len == 0)
    {
        return;
    }
    // char temp_buffer[BYTES_PER_LINE + 3]; //for not-byte-accessible memory
    char char_buffer[BYTES_PER_LINE + 1] = {0};
    const char *ptr_line = NULL;
    int bytes_cur_line;
    const char *temp = (const char *)buffer;

    do
    {
        if (buff_len > BYTES_PER_LINE)
        {
            bytes_cur_line = BYTES_PER_LINE;
        }
        else
        {
            bytes_cur_line = buff_len;
        }

        ptr_line = temp;

        for (int i = 0; i < bytes_cur_line; i++)
        {
            sprintf(char_buffer + i, "%c", (uint8_t)ptr_line[i]);
        }
        BSP_LOG_LEVEL(log_level, tag, "%s", char_buffer);
        temp += bytes_cur_line;
        buff_len -= bytes_cur_line;
    } while (buff_len);
}

void bsp_log_buffer_hexdump_internal(const char *tag, const void *buffer, uint16_t buff_len, BSP_LOG_LEVEL_t log_level)
{

    if (buff_len == 0)
    {
        return;
    }
    // char temp_buffer[BYTES_PER_LINE + 3]; //for not-byte-accessible memory
    const char *ptr_line = NULL;
    // format: field[length]
    // ADDR[10]+"   "+DATA_HEX[8*3]+" "+DATA_HEX[8*3]+"  |"+DATA_CHAR[8]+"|"
    char hd_buffer[10 + 3 + BYTES_PER_LINE * 3 + 3 + BYTES_PER_LINE + 1 + 1] = {0};
    char *ptr_hd = NULL;
    int bytes_cur_line;
    const char *temp = (const char *)buffer;

    do
    {
        if (buff_len > BYTES_PER_LINE)
        {
            bytes_cur_line = BYTES_PER_LINE;
        }
        else
        {
            bytes_cur_line = buff_len;
        }

        ptr_line = temp;

        ptr_hd = hd_buffer;

        ptr_hd += sprintf(ptr_hd, "%p ", temp);
        for (int i = 0; i < BYTES_PER_LINE; i++)
        {

            if (i < bytes_cur_line)
            {
                ptr_hd += sprintf(ptr_hd, " %02x", (uint8_t)ptr_line[i]);
            }
            else
            {
                ptr_hd += sprintf(ptr_hd, "   ");
            }
        }
        ptr_hd += sprintf(ptr_hd, "  |");
        for (int i = 0; i < bytes_cur_line; i++)
        {
            if (isprint((int)ptr_line[i]))
            {
                ptr_hd += sprintf(ptr_hd, "%c", (uint8_t)ptr_line[i]);
            }
            else
            {
                ptr_hd += sprintf(ptr_hd, ".");
            }
        }
        ptr_hd += sprintf(ptr_hd, "|");

        BSP_LOG_LEVEL(log_level, tag, "%s", hd_buffer);
        temp += bytes_cur_line;
        buff_len -= bytes_cur_line;
    } while (buff_len);
}

/***
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 16:14:38
 * @FilePath     : bsp_log.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _BSP_LOG_H_
#define _BSP_LOG_H_
#include <zephyr/kernel.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#define LOG_LOCAL_LEVEL 3
typedef enum
{
    BSP_LOG_NONE,   /*!< No log output */
    BSP_LOG_ERROR,  /*!< Critical errors, software module can not recover on its own */
    BSP_LOG_WARN,   /*!< Error conditions from which recovery measures have been taken */
    BSP_LOG_INFO,   /*!< Information messages which describe normal flow of events */
    BSP_LOG_DEBUG,  /*!< Extra information which is not necessary for normal use (values, pointers, sizes, etc). */
    BSP_LOG_VERBOSE /*!< Bigger chunks of debugging information, or frequent messages which can potentially flood the output. */
} BSP_LOG_LEVEL_t;

void bsp_log_buffer_hex_internal(const char *tag, const void *buffer, uint16_t buff_len, BSP_LOG_LEVEL_t log_level);
void bsp_log_buffer_char_internal(const char *tag, const void *buffer, uint16_t buff_len, BSP_LOG_LEVEL_t log_level);
void bsp_log_buffer_hexdump_internal(const char *tag, const void *buffer, uint16_t buff_len, BSP_LOG_LEVEL_t log_level);

#define BSP_LOG_FORMAT(level, format) #level "[%s]: " format "\n"
#define BSP_PRINTF(tag, format, ...) printk(format, tag, ##__VA_ARGS__);
#define DUG BSP_LOGE("DUG", "== %s ==,[%d]", __func__, __LINE__)
// #define DUG                             BSP_LOGE("DUG", "[%s][%d][%s] \n", __FILE__, __LINE__, __func__)
#define BSP_LOG_LEVEL(level, tag, format, ...)                        \
    do                                                                \
    {                                                                 \
        if (level == BSP_LOG_ERROR)                                   \
        {                                                             \
            BSP_PRINTF(tag, BSP_LOG_FORMAT(E, format), ##__VA_ARGS__) \
        }                                                             \
        else if (level == BSP_LOG_WARN)                               \
        {                                                             \
            BSP_PRINTF(tag, BSP_LOG_FORMAT(W, format), ##__VA_ARGS__) \
        }                                                             \
        else if (level == BSP_LOG_DEBUG)                              \
        {                                                             \
            BSP_PRINTF(tag, BSP_LOG_FORMAT(D, format), ##__VA_ARGS__) \
        }                                                             \
        else if (level == BSP_LOG_VERBOSE)                            \
        {                                                             \
            BSP_PRINTF(tag, BSP_LOG_FORMAT(V, format), ##__VA_ARGS__) \
        }                                                             \
        else                                                          \
        {                                                             \
            BSP_PRINTF(tag, BSP_LOG_FORMAT(I, format), ##__VA_ARGS__) \
        }                                                             \
    } while (0)

#define BSP_LOG_LEVEL_LOCAL(level, tag, format, ...)          \
    do                                                        \
    {                                                         \
        if (LOG_LOCAL_LEVEL >= level)                         \
            BSP_LOG_LEVEL(level, tag, format, ##__VA_ARGS__); \
    } while (0)
#define BSP_LOGE(tag, format, ...) BSP_LOG_LEVEL_LOCAL(BSP_LOG_ERROR, tag, format, ##__VA_ARGS__)
#define BSP_LOGW(tag, format, ...) BSP_LOG_LEVEL_LOCAL(BSP_LOG_WARN, tag, format, ##__VA_ARGS__)
#define BSP_LOGI(tag, format, ...) BSP_LOG_LEVEL_LOCAL(BSP_LOG_INFO, tag, format, ##__VA_ARGS__)
#define BSP_LOGD(tag, format, ...) BSP_LOG_LEVEL_LOCAL(BSP_LOG_DEBUG, tag, format, ##__VA_ARGS__)
#define BSP_LOGV(tag, format, ...) BSP_LOG_LEVEL_LOCAL(BSP_LOG_VERBOSE, tag, format, ##__VA_ARGS__)

/**
 * @brief Log a buffer of hex bytes at specified level, separated into 16 bytes each line.
 *
 * @param  tag      description tag
 * @param  buffer   Pointer to the buffer array
 * @param  buff_len length of buffer in bytes
 * @param  level    level of the log
 *
 */
#define BSP_LOG_BUFFER_HEX_LEVEL(tag, buffer, buff_len, level)         \
    do                                                                 \
    {                                                                  \
        if (LOG_LOCAL_LEVEL >= level)                                  \
        {                                                              \
            bsp_log_buffer_hex_internal(tag, buffer, buff_len, level); \
        }                                                              \
    } while (0)

/**
 * @brief Log a buffer of characters at specified level, separated into 16 bytes each line. Buffer should contain only printable characters.
 *
 * @param  tag      description tag
 * @param  buffer   Pointer to the buffer array
 * @param  buff_len length of buffer in bytes
 * @param  level    level of the log
 *
 */
#define BSP_LOG_BUFFER_CHAR_LEVEL(tag, buffer, buff_len, level)         \
    do                                                                  \
    {                                                                   \
        if (LOG_LOCAL_LEVEL >= level)                                   \
        {                                                               \
            bsp_log_buffer_char_internal(tag, buffer, buff_len, level); \
        }                                                               \
    } while (0)

/**
 * @brief Dump a buffer to the log at specified level.
 *
 * The dump log shows just like the one below:
 *
 * I[axxxc]: 1003fcfc   43 41 53 49 43 20 41 47  4e 53 53 20 61 67 65 6e  |CASIC AGNSS agen|
 * I[axxxc]: 1003fd0c   74 20 73 65 72 76 65 72  2e 0a 44 61 74 61 4c 65  |t server..DataLe|
 * I[axxxc]: 1003fd1c   6e 67 74 68 3a 20 35 38  38 32 2e 0a 0a ba ce 38  |ngth: 5882.....8|
 *
 * It is highly recommend to use terminals with over 102 text width.
 *
 * @param tag description tag
 * @param buffer Pointer to the buffer array
 * @param buff_len length of buffer in bytes
 * @param level level of the log
 */
#define BSP_LOG_BUFFER_HEXDUMP(tag, buffer, buff_len, level)               \
    do                                                                     \
    {                                                                      \
        if (LOG_LOCAL_LEVEL >= level)                                      \
        {                                                                  \
            bsp_log_buffer_hexdump_internal(tag, buffer, buff_len, level); \
        }                                                                  \
    } while (0)

/**
 * @brief Log a buffer of hex bytes at Info level
 *
 * @param  tag      description tag
 * @param  buffer   Pointer to the buffer array
 * @param  buff_len length of buffer in bytes
 *
 * @see ``BSP_log_buffer_hex_level``
 *
 */
#define BSP_LOG_BUFFER_HEX(tag, buffer, buff_len)                          \
    do                                                                     \
    {                                                                      \
        if (LOG_LOCAL_LEVEL >= BSP_LOG_INFO)                               \
        {                                                                  \
            BSP_LOG_BUFFER_HEX_LEVEL(tag, buffer, buff_len, BSP_LOG_INFO); \
        }                                                                  \
    } while (0)

/**
 * @brief Log a buffer of characters at Info level. Buffer should contain only printable characters.
 *
 * @param  tag      description tag
 * @param  buffer   Pointer to the buffer array
 * @param  buff_len length of buffer in bytes
 *
 * @see ``BSP_log_buffer_char_level``
 *
 */
#define BSP_LOG_BUFFER_CHAR(tag, buffer, buff_len)                          \
    do                                                                      \
    {                                                                       \
        if (LOG_LOCAL_LEVEL >= BSP_LOG_INFO)                                \
        {                                                                   \
            BSP_LOG_BUFFER_CHAR_LEVEL(tag, buffer, buff_len, BSP_LOG_INFO); \
        }                                                                   \
    } while (0)

#endif /* _BSP_LOG_H_ */

/***
 * @Author       : Cole
 * @Date         : 2025-07-31 11:52:06
 * @LastEditTime : 2025-07-31 18:45:41
 * @FilePath     : bal_os.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _BAL_OS_H__
#define _BAL_OS_H__

#include <zephyr/kernel.h>
#include <zephyr/types.h>

#define TICK_OF_MS(ms) \
    k_ticks_to_ms_floor64(ms)  // 将tick滴答的时间值转换为毫秒;Convert ticks to milliseconds. 64 bits. Truncates.
#define TICK_OF_S(s)          k_ticks_to_ms_floor64(s) / 1000
#define pdTICKS_TO_S(xTicks)  k_ticks_to_ms_floor64(xTicks) / 1000
#define pdTICKS_TO_MS(xTicks) k_ticks_to_ms_floor64(xTicks)
#define pdMS_TO_TICKS(xTimeInMs) \
    k_ms_to_ticks_ceil64(xTimeInMs)  // 将毫秒转换为tick 滴答的时间值;Convert milliseconds to ticks. 64 bits. Rounds up.

typedef uint32_t mos_os_time_t;
typedef uint64_t mos_os_time_ms_t;
typedef uint64_t mos_os_time_us_t;
typedef uint64_t mos_os_tick_t;

#define MOS_OS_WAIT_ON      0
#define MOS_OS_WAIT_FOREVER -1
#define MOS_OS_MAX_DELAY    0xFFFFFFFF
#define MOS_OS_NO_WAIT      K_NO_WAIT
#define MOS_OS_FOREVER      K_FOREVER
typedef enum
{
    MOS_OS_EOK     = 0,
    MOS_OS_ERROR   = -1,
    MOS_OS_TIMEOUT = -2
} OS_RET_CODE;

void mos_delay_ms(uint32_t ms);

void mos_delay_us(uint32_t us);

void mos_busy_wait(uint32_t us);

void mos_reset(void);

void mos_free(void *ptr);

void *mos_malloc(size_t size);

int64_t mos_uptime_get(void);

mos_os_tick_t mos_get_tick(void);

int mos_timer_stop(struct k_timer *timer_handle);

int mos_timer_start(struct k_timer *timer_handle, bool auto_reload, int64_t period);

int mos_timer_create(struct k_timer *timer_handle, void (*callback)(struct k_timer *timer));

int mos_mutex_create_init(struct k_mutex *mutex);

int mos_mutex_lock(struct k_mutex *mutex, int64_t time);

int mos_mutex_unlock(struct k_mutex *mutex);

int mos_sem_give(struct k_sem *sem);

int mos_sem_take(struct k_sem *sem, int64_t time);

int mos_msgq_receive(struct k_msgq *msgq, void *msg, int64_t timeout);

int mos_msgq_send(struct k_msgq *msgq, void *msg, int64_t timeout);
#endif  // !__BAL_OS_H__
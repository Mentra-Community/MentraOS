#ifndef MOS_WATCHDOG_APP_H_
#define MOS_WATCHDOG_APP_H_

#include <stdbool.h>
#include <stdint.h>

#include "mos_yhm4005.h"

#define MOS_WATCHDOG_APP_FEED_DIVISOR         4U
#define MOS_WATCHDOG_APP_MIN_FEED_INTERVAL_MS 100U

typedef struct
{
    bool initialized;
    bool available;
    bool enabled;
    uint32_t timeout_seconds;
    uint32_t feed_interval_ms;
    int last_error;
} mos_watchdog_status_t;

/**
 * @brief Initialize watchdog application layer | 初始化看门狗应用层
 * @details Initializes the YHM4005 driver, reads the chip ID, and disables the external watchdog by default so development, J-Link flashing, and recovery remain safe.
 * @details 初始化 YHM4005 驱动、读取芯片 ID，并默认关闭外部看门狗，确保开发、J-Link 烧录和救援流程不会被看门狗打断。
 * @return 0 on success, negative errno when GPIO/ACMD/ID access fails.
 * @return 成功返回 0；GPIO、ACMD 或 ID 访问失败时返回负数 errno。
 */
int mos_watchdog_app_init(void);

/**
 * @brief Enable watchdog and start automatic feeding | 启用看门狗并启动自动喂狗
 * @param timeout_seconds Supported timeout in seconds.
 * @param timeout_seconds 支持的看门狗超时时间，单位秒。
 * @details Converts seconds to a YHM4005 timeout code, enables the chip with a 200ms reset pulse, then schedules periodic feed work.
 * @details 将秒数转换为 YHM4005 timeout 配置，使用 200ms 复位脉冲启用芯片，然后启动周期性喂狗 work。
 * @return 0 on success, -EINVAL for unsupported timeout, or negative errno from driver/ACMD failure.
 * @return 成功返回 0；不支持的 timeout 返回 -EINVAL，驱动或 ACMD 失败返回负数 errno。
 */
int mos_watchdog_app_enable(uint32_t timeout_seconds);

/**
 * @brief Disable watchdog and stop automatic feeding | 禁用看门狗并停止自动喂狗
 * @details Cancels pending feed work and clears EN_DOG through the YHM4005 driver.
 * @details 取消待执行的喂狗 work，并通过 YHM4005 驱动清除 EN_DOG。
 * @return 0 on success, negative errno from init/driver/ACMD failure.
 * @return 成功返回 0；初始化、驱动或 ACMD 失败时返回负数 errno。
 */
int mos_watchdog_app_disable(void);

/**
 * @brief Feed watchdog once immediately | 立即单次喂狗
 * @details Calls the YHM4005 falling-edge feed operation once and stores the result in last_error.
 * @details 调用一次 YHM4005 下降沿喂狗操作，并将结果记录到 last_error。
 * @return 0 on success, negative errno from driver/ACMD/GPIO failure.
 * @return 成功返回 0；驱动、ACMD 或 GPIO 失败时返回负数 errno。
 */
int mos_watchdog_app_feed(void);

/**
 * @brief Read YHM4005 ID through watchdog app | 通过看门狗应用层读取 YHM4005 ID
 * @param id Output pointer that receives the ID register value.
 * @param id 输出指针，用于接收 ID 寄存器值。
 * @return 0 on success, -EINVAL for null pointer, or negative errno from driver/ACMD failure.
 * @return 成功返回 0；空指针返回 -EINVAL，驱动或 ACMD 失败返回负数 errno。
 */
int mos_watchdog_app_read_id(uint8_t *id);

/**
 * @brief Read YHM4005AW4T ID with ACMD diagnostics | 带 ACMD 诊断信息读取 YHM4005AW4T ID
 * @param id Output pointer that receives the ID register value.
 * @param id 输出指针，用于接收 ID 寄存器值。
 * @param diag Optional output diagnostics from the driver.
 * @param diag 可选输出驱动层诊断信息。
 * @details Ensures the app layer is initialized, reads ID through the confirmed normal address 0x1A, and records the last operation result.
 * @details 确保应用层已初始化，通过已确认的 normal 地址 0x1A 读取 ID，并记录最近一次操作结果。
 * @return 0 on success, -EINVAL for null pointer, or negative errno from driver/ACMD failure.
 * @return 成功返回 0；空指针返回 -EINVAL，驱动或 ACMD 失败返回负数 errno。
 */
int mos_watchdog_app_read_id_diag(uint8_t *id, mos_yhm4005_diag_t *diag);

/**
 * @brief Get cached watchdog status | 获取缓存的看门狗状态
 * @param status Output status structure. Null pointer is ignored.
 * @param status 输出状态结构体；为空时函数直接返回。
 * @details Reports initialization state, chip availability, enable state, timeout/feed interval, and the last operation error.
 * @details 返回初始化状态、芯片可用状态、启用状态、timeout、喂狗周期和最近一次操作错误码。
 */
void mos_watchdog_app_get_status(mos_watchdog_status_t *status);

#endif  // MOS_WATCHDOG_APP_H_

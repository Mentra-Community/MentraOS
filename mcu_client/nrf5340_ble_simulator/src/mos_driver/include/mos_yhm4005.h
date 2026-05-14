#ifndef MOS_YHM4005_H_
#define MOS_YHM4005_H_

#include <stdbool.h>
#include <stdint.h>

#define MOS_YHM4005_ADDRESS_NORMAL       0x1A
#define MOS_YHM4005_REG_ID               0x00
#define MOS_YHM4005_REG_CTRL             0x04
#define MOS_YHM4005_REG_TIMER            0x05
#define MOS_YHM4005_REG_DEV_CFG          0x06
#define MOS_YHM4005_CTRL_EN_WDI          (1U << 2)
#define MOS_YHM4005_CTRL_RST_DOG         (1U << 1)
#define MOS_YHM4005_CTRL_EN_DOG          (1U << 0)
#define MOS_YHM4005_DEV_CFG_ACTIVE_LOW_OD 0x10
#define MOS_YHM4005_RETRY_COUNT          10
#define MOS_YHM4005_DELAY_B0_US          3
#define MOS_YHM4005_DELAY_B1_US          8
#define MOS_YHM4005_DELAY_BZ_US          27
#define MOS_YHM4005_DELAY_SA_US          2
#define MOS_YHM4005_FEED_LOW_US          1000
#define MOS_YHM4005_WAIT_RELEASE_LOOPS   10000

typedef enum
{
    MOS_YHM4005_TIMEOUT_100MS = 0,
    MOS_YHM4005_TIMEOUT_200MS = 1,
    MOS_YHM4005_TIMEOUT_500MS = 2,
    MOS_YHM4005_TIMEOUT_1S = 3,
    MOS_YHM4005_TIMEOUT_2S = 4,
    MOS_YHM4005_TIMEOUT_5S = 5,
    MOS_YHM4005_TIMEOUT_10S = 6,
    MOS_YHM4005_TIMEOUT_20S = 7,
    MOS_YHM4005_TIMEOUT_50S = 8,
    MOS_YHM4005_TIMEOUT_100S = 9,
    MOS_YHM4005_TIMEOUT_200S = 10,
    MOS_YHM4005_TIMEOUT_500S = 11,
    MOS_YHM4005_TIMEOUT_1000S = 12,
    MOS_YHM4005_TIMEOUT_2000S = 13,
} mos_yhm4005_timeout_t;

typedef enum
{
    MOS_YHM4005_RESET_20MS = 0,
    MOS_YHM4005_RESET_100MS = 1,
    MOS_YHM4005_RESET_200MS = 2,
    MOS_YHM4005_RESET_500MS = 3,
    MOS_YHM4005_RESET_1S = 4,
    MOS_YHM4005_RESET_2S = 5,
    MOS_YHM4005_RESET_5S = 6,
    MOS_YHM4005_RESET_ALWAYS_ACTIVE = 7,
} mos_yhm4005_reset_pulse_t;

/**
 * @brief Initialize YHM4005 ACMD GPIO | 初始化 YHM4005 ACMD GPIO
 * @details Configures the watchdog ACMD pin from devicetree as output high so the single-wire bus is idle and ready for ID/read/write/feed operations.
 * @details 从设备树读取 watchdog ACMD 引脚并配置为输出高电平，使单线总线处于空闲状态，供后续读 ID、读写寄存器和喂狗使用。
 * @return 0 on success, negative errno on GPIO/devicetree failure.
 * @return 成功返回 0，GPIO 或设备树异常时返回负数 errno。
 */
int mos_yhm4005_init(void);

/**
 * @brief Read YHM4005 ID register | 读取 YHM4005 ID 寄存器
 * @param id Output pointer that receives register 0x00 value.
 * @param id 输出指针，用于接收 0x00 寄存器的值。
 * @return 0 on success, -EINVAL for null pointer, -ENODEV before init, or -EIO when ACMD communication fails.
 * @return 成功返回 0；空指针返回 -EINVAL，未初始化返回 -ENODEV，ACMD 通讯失败返回 -EIO。
 */
int mos_yhm4005_read_id(uint8_t *id);

/**
 * @brief Enable YHM4005 watchdog | 启用 YHM4005 看门狗
 * @param timeout Timeout code from mos_yhm4005_timeout_t.
 * @param timeout 看门狗超时时间枚举值。
 * @param reset_pulse Reset pulse width code from mos_yhm4005_reset_pulse_t.
 * @param reset_pulse 复位脉冲宽度枚举值。
 * @details Verifies ID, selects falling-edge feed mode, programs timeout/reset pulse/RST output, then sets EN_DOG.
 * @details 函数会先校验 ID，然后配置下降沿喂狗模式、超时时间、复位脉冲和 RST 输出方式，最后置位 EN_DOG。
 * @return 0 on success, negative errno on invalid parameter, missing init, ID mismatch, or ACMD failure.
 * @return 成功返回 0；参数错误、未初始化、ID 不匹配或 ACMD 通讯失败时返回负数 errno。
 */
int mos_yhm4005_enable(mos_yhm4005_timeout_t timeout, mos_yhm4005_reset_pulse_t reset_pulse);

/**
 * @brief Disable YHM4005 watchdog | 禁用 YHM4005 看门狗
 * @details Keeps EN_WDI set for falling-edge feed mode but clears EN_DOG so the external watchdog stops resetting the MCU.
 * @details 保持 EN_WDI 为下降沿喂狗模式，同时清除 EN_DOG，使外部看门狗停止复位 MCU。
 * @return 0 on success, -ENODEV before init, or -EIO when ACMD write fails.
 * @return 成功返回 0；未初始化返回 -ENODEV，ACMD 写失败返回 -EIO。
 */
int mos_yhm4005_disable(void);

/**
 * @brief Feed YHM4005 once by ACMD falling edge | 通过 ACMD 下降沿单次喂狗
 * @details Drives ACMD high, pulls it low for at least MOS_YHM4005_FEED_LOW_US, then releases it high to reset the watchdog timer.
 * @details 先将 ACMD 拉高，再拉低至少 MOS_YHM4005_FEED_LOW_US，最后恢复高电平，用这个下降沿复位看门狗计时器。
 * @return 0 on success, -ENODEV before init, or GPIO error code on pin operation failure.
 * @return 成功返回 0；未初始化返回 -ENODEV，GPIO 操作失败时返回对应错误码。
 */
int mos_yhm4005_feed(void);

/**
 * @brief Check whether YHM4005 GPIO driver was initialized | 查询 YHM4005 GPIO 驱动是否已初始化
 * @return true after mos_yhm4005_init succeeds, otherwise false.
 * @return mos_yhm4005_init 成功后返回 true，否则返回 false。
 */
bool mos_yhm4005_is_initialized(void);

/**
 * @brief Convert timeout seconds to YHM4005 timeout code | 将秒数转换为 YHM4005 timeout 枚举
 * @param seconds Supported timeout in seconds: 1/2/5/10/20/50/100/200/500/1000/2000.
 * @param seconds 支持的超时时间秒数：1/2/5/10/20/50/100/200/500/1000/2000。
 * @param timeout Output timeout enum.
 * @param timeout 输出的 timeout 枚举值。
 * @return 0 on success, -EINVAL when seconds is unsupported or timeout is null.
 * @return 成功返回 0；秒数不支持或 timeout 为空时返回 -EINVAL。
 */
int mos_yhm4005_timeout_seconds_to_code(uint32_t seconds, mos_yhm4005_timeout_t *timeout);

/**
 * @brief Convert YHM4005 timeout code to seconds | 将 YHM4005 timeout 枚举转换为秒数
 * @param timeout Timeout enum value.
 * @param timeout timeout 枚举值。
 * @return Timeout seconds for supported codes, or 0 for sub-second/invalid codes.
 * @return 支持的枚举返回对应秒数；亚秒级或非法枚举返回 0。
 */
uint32_t mos_yhm4005_timeout_code_to_seconds(mos_yhm4005_timeout_t timeout);

#endif  // MOS_YHM4005_H_

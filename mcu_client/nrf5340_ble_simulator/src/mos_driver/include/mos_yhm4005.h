#ifndef MOS_YHM4005_H_
#define MOS_YHM4005_H_

#include <stdbool.h>
#include <stdint.h>

/* YHM4005AW4T ACMD addresses | YHM4005AW4T ACMD 地址 */
/* Normal address is the production path confirmed on YHM4005AW4T. */
/* normal 地址是 YHM4005AW4T 已确认的正式读写路径。 */
#define MOS_YHM4005_ADDRESS_NORMAL       0x1A
#define MOS_YHM4005_REG_ID               0x00
#define MOS_YHM4005_REG_CTRL             0x04
#define MOS_YHM4005_REG_TIMER            0x05
#define MOS_YHM4005_REG_DEV_CFG          0x06
#define MOS_YHM4005_CTRL_EN_WDI          (1U << 2)
#define MOS_YHM4005_CTRL_RST_DOG         (1U << 1)
#define MOS_YHM4005_CTRL_EN_DOG          (1U << 0)
#define MOS_YHM4005_DEV_CFG_ACTIVE_LOW_OD 0x10

/* ID validation for YHM4005AW4T register 0x00 | YHM4005AW4T 0x00 寄存器 ID 校验 */
/* Vendor reset check uses (ID & 0xC0) == 0x80; board-read AW4T ID 0x93 is therefore valid. */
/* 厂商 reset 检查使用 (ID & 0xC0) == 0x80；本板 AW4T 实测 ID 0x93 因此是合法值。 */
#define MOS_YHM4005_ID_VALID_MASK        0xC0
#define MOS_YHM4005_ID_VALID_VALUE       0x80
#define MOS_YHM4005_RETRY_COUNT          10

/* ACMD bit timing defaults | ACMD 位时序默认值 */
/* Vendor target low widths: B0 ~= 2.4us, B1 ~= 7.8us, BZ ~= 27us, tolerance about +/-10%. */
/* Board-tuned stable values on YHM4005AW4T + nRF5340 P0.04 + nRF GPIO HAL: B0=2us, B1=6us, BZ=25us, SA=4us. */
/* 厂商目标低电平宽度：B0 约 2.4us，B1 约 7.8us，BZ 约 27us，误差建议约 +/-10%。 */
/* YHM4005AW4T + nRF5340 P0.04 + nRF GPIO HAL 上板实测稳定值：B0=2us，B1=6us，BZ=25us，SA=4us。 */
#define MOS_YHM4005_DELAY_B0_US          2
#define MOS_YHM4005_DELAY_B1_US          6
#define MOS_YHM4005_DELAY_BZ_US          25
#define MOS_YHM4005_DELAY_SA_US          4
#define MOS_YHM4005_FEED_LOW_US          1000
#define MOS_YHM4005_WAIT_RELEASE_LOOPS   10000

typedef enum
{
    MOS_YHM4005_ACMD_MODE_NORMAL = 0,
} mos_yhm4005_acmd_mode_t;

typedef struct
{
    /* ACMD mode/address used by the last read | 最近一次读取使用的 ACMD 模式和地址 */
    mos_yhm4005_acmd_mode_t mode;
    uint8_t address;

    /* ID and timing snapshot for the last attempt | 最近一次尝试的 ID 和时序快照 */
    uint8_t id;
    uint32_t delay_b0_us;
    uint32_t delay_b1_us;
    uint32_t delay_bz_us;
    uint32_t delay_sa_us;

    /* Vendor-style failure details for waveform/timing debug | 厂商风格的失败定位信息，用于波形和时序调试 */
    int error_location;
    int read_bit_error1;
    int read_bit_error2;
    int last_ack;
    int expected_ack;
} mos_yhm4005_diag_t;

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
 * @details Validates the devicetree ACMD pin and configures hardware-confirmed P0.04 through nRF GPIO HAL as output high so the single-wire bus is idle.
 * @details 校验设备树中的 ACMD 引脚，并通过 nRF GPIO HAL 将硬件已确认的 P0.04 配置为输出高电平，使单线总线处于空闲状态。
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
 * @brief Read YHM4005AW4T ID with diagnostics | 带诊断信息读取 YHM4005AW4T ID
 * @param id Output pointer that receives register 0x00 value.
 * @param id 输出指针，用于接收 0x00 寄存器的值。
 * @param diag Optional output diagnostics including timing, address, error location, and read-bit errors.
 * @param diag 可选输出诊断信息，包含时序、地址、错误位置和 read-bit 错误。
 * @details Uses the confirmed YHM4005AW4T normal address 0x1A and records vendor-style error_location/read_bit_error fields for ACMD debugging.
 * @details 使用已确认的 YHM4005AW4T normal 地址 0x1A，并记录厂商风格的 error_location/read_bit_error 字段用于 ACMD 调试。
 * @return 0 on success, -EINVAL for null ID pointer, -ENODEV before init, or -EIO when ACMD communication fails.
 * @return 成功返回 0；ID 指针为空返回 -EINVAL，未初始化返回 -ENODEV，ACMD 通讯失败返回 -EIO。
 */
int mos_yhm4005_read_id_diag(uint8_t *id, mos_yhm4005_diag_t *diag);

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

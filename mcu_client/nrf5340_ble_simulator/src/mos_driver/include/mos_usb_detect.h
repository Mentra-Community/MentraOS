#ifndef MOS_USB_DETECT_H_
#define MOS_USB_DETECT_H_

#include <stdbool.h>

/**
 * @brief Initialize USB cable detection (polling mode) | 初始化USB线缆检测（轮询模式）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int usb_detect_init(void);

/**
 * @brief Query USB cable connection status | 查询USB线缆连接状态
 * @return true if USB cable is connected | USB已连接返回 true
 * @return false if USB cable is disconnected | USB未连接返回 false
 */
bool usb_is_connected(void);

#endif /* MOS_USB_DETECT_H_ */

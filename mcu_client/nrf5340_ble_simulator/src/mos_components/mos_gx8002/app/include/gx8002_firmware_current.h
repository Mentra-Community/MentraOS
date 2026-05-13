

#ifndef _GX8002_FIRMWARE_CURRENT_H_
#define _GX8002_FIRMWARE_CURRENT_H_

#include <stdint.h>

#ifndef GX8002_VAD_FIRMWARE_ENABLE
#define GX8002_VAD_FIRMWARE_ENABLE         0
#endif

#if GX8002_VAD_FIRMWARE_ENABLE
#define GX8002_VAD_FW_VERSION_STR          "v1_2"

#if defined(GX8002_FIRMWARE_DATA_DEFINE)
/* 只在定义固件实体的那个编译单元内展开大数组，避免重复定义。
 * Expand the blob only in the translation unit that owns the firmware data.
 */
#include "gx8002_firmware_data_v1_2.h"
#endif

/* 对外统一暴露当前固件符号，避免 shell/update 代码跟具体版本名耦合。
 * Expose a stable current-firmware alias so shell/update code stays version-agnostic.
 */
#define gx8002_firmware_data_current        gx8002_firmware_datas
#define gx8002_firmware_data_current_len    gx8002_firmware_datas_len

extern const uint8_t gx8002_firmware_data_current[];
extern const uint32_t gx8002_firmware_data_current_len;
#endif

#endif /* _GX8002_FIRMWARE_CURRENT_H_ */

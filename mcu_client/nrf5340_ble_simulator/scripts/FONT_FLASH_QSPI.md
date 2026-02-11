# Flash Font to QSPI (XIP Address)

Convert an LVGL binfont (`.bin`) to Intel HEX and program it onto the nRF5340 DK external QSPI Flash for XIP (execute-in-place) use.

## Prerequisites

- **ARM GCC** installed (`arm-none-eabi-objcopy` on PATH)
- **nRF Util** installed (`nrfutil`)
- Device connected via USB; **serial number** known (e.g. `771549234`)
- Font XIP base address matches the project (example `0x100f0000`; see `pm_static.yml` / Kconfig)

## Step 1: BIN → HEX (with XIP address)

Convert the font binary to Intel HEX and set the load address in QSPI:

```bash
arm-none-eabi-objcopy -I binary -O ihex \
  --change-addresses 0x100f0000 \
  mcu_client/nrf5340_ble_simulator/scripts/font_zh_en_18_lvgl_1.bin \
  mcu_client/nrf5340_ble_simulator/scripts/font_zh_en_18_lvgl_1.hex
```

- `--change-addresses 0x100f0000`: Must match the font XIP base address in firmware (see `pm_static.yml` font_storage or Kconfig `PM_FONT_STORAGE_ADDRESS`). Change if your partition uses a different address.
- Paths above are **relative to the repo root**; run from the repo root or use absolute paths as needed.

## Step 2: Program to device

Program the HEX to external QSPI with nrfutil:

```bash
nrfutil device --x-ext-mem-config-file mcu_client/nrf5340_ble_simulator/scripts/nrf5340dk_qspi_ext_mem_config.json program \
  --firmware mcu_client/nrf5340_ble_simulator/scripts/font_zh_en_18_lvgl_1.hex \
  --serial-number 771549234 \
  --options ext_mem_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,chip_erase_mode=ERASE_NONE,verify=VERIFY_READ
```

- `--serial-number`: Use your device’s serial (run `nrfutil device list` to find it).
- `ext_mem_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE`: Erase only QSPI ranges covered by the HEX.
- `chip_erase_mode=ERASE_NONE`: Do not full-chip erase.
- `verify=VERIFY_READ`: Verify after programming by reading back.

## Troubleshooting

- **Wrong address**: If the firmware cannot read the font, check that `--change-addresses` matches the font_storage base in `pm_static.yml` / Kconfig.
- **Device not found**: Run `nrfutil device list` to confirm the device and serial number.
- **Permissions / drivers**: On Linux you may need udev rules or sudo; on Windows install the J-Link driver.

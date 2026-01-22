# Changelog

## [Unreleased]
### Added
- Real-time battery percentage integration: Mobile app now displays actual fuel gauge SoC percentage instead of hardcoded values.
- Battery data getter functions: Added `battery_get_soc_percentage()` and `battery_is_charging()` to fuel gauge module.
- Fuel gauge data storage: Current SoC and charging status now stored globally and updated in real-time.
- Clear display command: Implemented protobuf ClearDisplay command (tag 99) to clear all LVGL content and hardware framebuffer.
- Display clear functionality: Added `display_clear_all()` function and `LCD_CMD_CLEAR_ALL` command type to MOS LVGL display module.
- Microphone switching protection: Added comprehensive crash protection against rapid microphone state switching from mobile app.
- Rate limiting and debouncing: 500ms debounce delay and 2-second window tracking to prevent rapid successive microphone state changes.
- Duplicate request detection: Detects and blocks identical microphone state requests (ON->ON, OFF->OFF) with max 5 rapid requests limit.

### Changed
- Increased A6N projector container width to 470 pixels for live caption display.
- Container border hidden, text center-aligned, and secondary font set to lv_font_montserrat_24 for A6N projector live caption container.
- Simplified container initial text to show simple welcome message with device name when glasses are disconnected/unpaired.
- Display now shows dynamic BLE device name with MAC address suffix (e.g., "Nex1-A1B2C3") instead of static name.
- Changed device name format from "NexSim XXXXXX" to "Nex1-XXXXXX" for cleaner appearance.
- Battery percentage calculation corrected: SoC from fuel gauge is already in percentage format, removed incorrect multiplication by 100.
- Microphone error handling improved: -EALREADY errors now treated as warnings instead of failures to prevent unnecessary error states.
 - EVT1 PDM pin mapping updated: `PDM_CLK` → P0.20, `PDM_DIN` → P0.21. Board overlay updated at [mcu_client/nrf5340_ble_simulator/boards/nrf5340dk_nrf5340_cpuapp_ns.overlay](mcu_client/nrf5340_ble_simulator/boards/nrf5340dk_nrf5340_cpuapp_ns.overlay) to reflect EVT1 hardware.

### Fixed
- Battery status synchronization: Mobile app now shows correct battery percentage matching the Zephyr shell `battery status` command.
- Firmware crash prevention: Fixed crashes caused by new mobile app rapidly switching microphone states with protection mechanisms.
- PDM audio state management: Added atomic state change operations and in-progress flags to prevent overlapping operations.
- A6N brightness control: Fixed BLE protobuf handler to use linear 0x00-0xFF register mapping instead of 0-9 levels, ensuring consistent brightness behavior between shell commands and mobile app.
- Shell brightness command now accepts any value 0-100 with linear mapping instead of fixed levels (20,40,60,80,100).
- Modular display configuration updates for improved UI consistency.


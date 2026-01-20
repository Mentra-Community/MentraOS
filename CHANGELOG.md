# Changelog

## [Unreleased]
### Added
- Real-time battery percentage integration: Mobile app now displays actual fuel gauge SoC percentage instead of hardcoded values.
- Battery data getter functions: Added `battery_get_soc_percentage()` and `battery_is_charging()` to fuel gauge module.
- Fuel gauge data storage: Current SoC and charging status now stored globally and updated in real-time.

### Changed
- Increased A6N projector container width to 470 pixels for live caption display.
- Container border hidden, text center-aligned, and secondary font set to lv_font_montserrat_24 for A6N projector live caption container.
- Simplified container initial text to show simple welcome message with device name when glasses are disconnected/unpaired.
- Display now shows dynamic BLE device name with MAC address suffix (e.g., "Nex1-A1B2C3") instead of static name.
- Changed device name format from "NexSim XXXXXX" to "Nex1-XXXXXX" for cleaner appearance.
- Battery percentage calculation corrected: SoC from fuel gauge is already in percentage format, removed incorrect multiplication by 100.

### Fixed
- Battery status synchronization: Mobile app now shows correct battery percentage matching the Zephyr shell `battery status` command.
- A6N brightness control: Fixed BLE protobuf handler to use linear 0x00-0xFF register mapping instead of 0-9 levels, ensuring consistent brightness behavior between shell commands and mobile app.
- Shell brightness command now accepts any value 0-100 with linear mapping instead of fixed levels (20,40,60,80,100).
- Modular display configuration updates for improved UI consistency.


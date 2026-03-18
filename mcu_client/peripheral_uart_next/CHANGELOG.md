# Changelog

## [Unreleased]
### Changed
- Updated projector display driver pinout for nRF5340DK board:
  - SPI3 SCK: P1.15
  - SPI3 MOSI: P1.13
  - SPI3 MISO: P1.14
  - Left CS: P0.28
  - Right CS: P0.29
  - Reset: P1.01
  - V0.9 Enable: P0.05
  - V1.8 Enable: P0.06
  - VCOM: P0.07

### Testing
- ✅ Build successful on nRF5340DK target (nrf5340dk/nrf5340/cpuapp)
- ✅ Flash successful to board serial 1050065315
- 📊 Memory usage: FLASH 406KB/1008KB (39%), RAM 196KB/448KB (43%)
- ⚠️ Minor compilation warnings present (non-blocking)

### Notes
- This pinout update prepares the project for nrf5340dk and future simulator porting.
- Ready for hardware testing and validation.

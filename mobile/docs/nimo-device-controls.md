# NIMO device controls

## Firmware evidence

The vendor SDK documents factory recovery as command `0x08`, key `0x03`, empty
payload, with an ACK. Explicit Unpair uses this command before local teardown.
Passive disconnect, pairing cancellation and logout do not request a factory reset.
When NIMO is offline, only the local pairing can be removed. A failed/missing reset
ACK is logged and local unpair still completes. Android also removes the selected
NIMO Bluetooth bond; iOS cannot remove the operating system bond programmatically.

System menu language is absent from the SDK's public constants. It was verified
in the supplied `ota-0.1.1.1-20260827164351-537cf1-dirty-dynamic-v1.bin`, SHA-256
`5e23c574e3dfd8c27172f4f9a33475e6efd0d33e7230bfcce8f4fe8ca59fe433`.
The OTA contains LZMA streams. Its application image is the stream at file offset
`0xC9478`; its runtime address is `0x041B4000` including the 32-byte image header.

- Display SET handler at `0x0427B34A` handles key `0x24`, requires nonempty payload
  with a nonzero first byte, persists `value - 1`, and posts UI event `0xAF`.
- UI handler at `0x041FE662` accepts one byte and passes `value - 1` to the locale
  setter at `0x04268292` (internal range 0–20).
- The string table at `0x04360C4C` contains 126 entries per locale: locale 0 is
  English (e.g. “Welcome to NIMO”), locale 1 is Simplified Chinese.
- Therefore system English is `cmd=0x03, key=0x24, payload=[0x01]`. It is sent
  once at connection initialization; rejection by older firmware does not block
  the connection. This is separate from translation-app language selection.

Golden complete frames (ACK requested):

- English menus: `BF020500702500000324010001`
- Factory recovery: `BF0204005358000008030000`

## Settings capabilities

UI visibility comes from explicit model capabilities, not display count or IMU
presence. Physical height/depth adjustment is distinct from the scene API's
`display.canPosition` (placing text and other elements on the canvas).

The SDK and supplied firmware implement NIMO distance (`03/03`) and height
(`03/17`) at levels 0–10. Firmware handlers at `0x0427B404` and `0x0427B41C`
validate those limits and call the adjustment routines. Head-up angle (`03/04`)
uses `[1, degrees]`, 0–90; the handler at `0x0427B434` distinguishes calibration
(operation 0) from setting the threshold (operation 1). Both native SGCs already
implement those commands. NIMO's settings use these ranges; G1/G2 and Mentra
Display retain their existing ranges.

## Physical regression path

On a physical Android phone, connect NIMO and confirm an English-setting ACK and
English firmware menus. Verify position sliders use 0–10 and head-up uses 0–90;
restore any values changed for testing. Use explicit Unpair once, confirm the
factory-reset ACK precedes teardown and the Android bond is removed, then pair
again. Keep the Mac disconnected throughout this Android test. On iOS, validate
the native build and the same wire frames; operating-system Forget remains a
manual Settings action when switching hosts.

# BES Burst-Loss Audit Experiment (OS-1409 step 1)

Instrumented byte-conservation audit to localize where the BES firmware loses one early UART pack during multi-pack bursts. Blocks `BATCHED_ACKS_ENABLED` and `BIG_PACKS_ENABLED` in asg_client until resolved.

## Builds

| Component | Version / branch | Notes |
|-----------|------------------|-------|
| BES firmware | `17.26.7.10` on `feat/ble-throughput-phy-txwindow` | Factory-flash only (OTA apply corrupts images >= ~1.98 MB) |
| asg_client | MentraOS dev + audit TX logs | Install via adb |
| Audit gate | `BLE_RX_AUDIT=1` in `ble_rx_audit.h` | Set to `0` to compile out instrumentation |

Confirm firmware: `cs_syvr` / `sr_syvr` must report `17.26.7.10`.

## Counter stations

| Station | Source | Log grep |
|---------|--------|----------|
| S0 MTK TX | `K900BluetoothManager` | `AUDIT tx pack=` / `AUDIT summary tx_bytes=` |
| S1 ISR | `uart_dma_rx` | `lxy audit summary isr=` |
| S2 delivered | DMA thread callback | `deliv=` in summary |
| S3 parse ring | `lxy_uart_buffer_add` | `added=` / `dropped=` / `lxy audit ring drop` |
| S4 frame parser | `lxy_uart_buffer_parse` | `dsc=` `dtl=` `de=` `dne=` / `lxy audit discard` |
| S5 file handler | `lxy_ble_file_sendData` | `ok=` `reject=` / `lxy audit snap reject` |

**Decision tree:** first station where bytes diverge from S0 localizes the bug.

- S1 < S0: hardware DMA/FIFO loss (re-arm gap hypothesis)
- S1 == S0, dropped > 0: parse ring overflow
- dropped == 0, discard counters > 0: frame parser bug
- parser clean, reject > 0: verify/index mismatch (inspect snap hex dump)

## Bench setup

```bash
# 1. Factory-flash BES audit firmware (17.26.7.10)
# 2. Install audit asg_client APK
adb install -r app-debug.apk

# 3. Enable BES trace polling into logcat
adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled true --ei interval_ms 3000

# 4. Capture logs (separate terminal)
adb logcat -s MentraBleTrace K900BluetoothManager | tee burst-audit-$(date +%Y%m%d-%H%M).log
```

Wait for `sr_syvr` showing `17.26.7.10` and baud negotiation to `1152000` before running arms.

## Test matrix

Flip flags in [K900BluetoothManager.java](../asg_client/app/src/main/java/com/mentra/asg_client/io/bluetooth/managers/K900BluetoothManager.java) and rebuild asg_client per arm. Keep `BIG_PACKS_ENABLED` and `BATCHED_ACKS_ENABLED` as documented below.

| Arm | `BATCHED_ACKS_ENABLED` | `BIG_PACKS_ENABLED` | Expected |
|-----|------------------------|---------------------|----------|
| A (control) | `false` | `false` | 5/5 clean; all counters conserved |
| B | `true` | `false` | Pack 1 loss at 400B window-12 |
| C | `true` | `true` | Pack 0 loss at 800B window-12 |

Trigger one BLE photo per trace-poll cycle (~3 s) so the 32 KB BES trace ring does not wrap mid-transfer:

```bash
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"take_photo","requestId":"audit-1","packageName":"com.mentra.audit","transferMethod":"ble"}'
```

Run 5 photos per arm. Record pass/fail and counter snapshots.

## Results template

Copy per transfer:

```
Arm: __  Run: __/5  Date: ____
BES version: 17.26.7.10
Pack size / window / batched: ____ / ____ / ____

S0 tx_bytes:     ____
S1 isr:          ____  (delta from S0: ____)
S2 deliv:        ____  (delta from S1: ____)
S3 added:        ____  dropped: ____
S4 parsed:       ____  dsc: __ dtl: __ de: __ dne: __
S5 ok:           ____  reject: ____

Outcome: PASS / FAIL (unexpected index at pack __)
First divergent station: S__
Notes:
```

## Follow-up variants (same session)

If S1 < S0 (hardware gap confirmed), try one change per flash:

1. Increase `UART_BUF_SIZE_MARGIN_IN_BYTES` from 512 to 2048 in `app_uart_dma_thread.c`
2. Hold `APP_SYSFREQ_104M` at boot (not only on pack 0) in test build
3. Both (1) and (2)

Rerun Arms B/C after each variant. Whichever conserves bytes end-to-end is the fix candidate.

## Disabling audit

- Firmware: `#define BLE_RX_AUDIT 0` in `apps/common/ble_rx_audit.h`
- Trace polling: `adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled false`

## References

- Linear: [OS-1409](https://linear.app/mentralabs/issue/OS-1409/mentra-live-improve-ble-image-transfer-quality-and-speed)
- BES PR: fengyue120/mentra-live-bes#6
- Related: OS-1646 (BES CI/CD; OTA size gate)

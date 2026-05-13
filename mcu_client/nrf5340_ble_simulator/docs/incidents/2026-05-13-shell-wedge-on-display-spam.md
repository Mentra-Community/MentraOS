# Shell Wedge When Spamming Display Commands — Debug Notes

Captures investigation of a reproducible USB + RTT shell freeze that happens when sending many `display` shell commands before BLE is connected.

## Symptom Pattern

1. Fresh flash / clean reset → USB serial shell and RTT shell both work, logs flow.
2. With **no BLE connection to phone**, send `display debug border on` commands into the USB shell.
3. After **a variable number of commands** the USB serial terminal stops responding:
   - Threshold ranges from **1 command to ~80+** between attempts — not a fixed count.
   - Connection still established (device enumerated, terminal can attach).
   - No log output.
   - No input echo, no command response.
4. RTT goes silent the same way — connection succeeds, but nothing flows in either direction.
5. Display keeps showing the scrolling welcome animation. USB stays enumerated.
6. Background logging continues to flow normally **up until the moment a command is executed**; the wedge fires on command execution, not on idle time.
7. **Reset clears it.** Power cycle clears it.
8. **Connecting glasses to phone over BLE also clears it instantly** — both USB and RTT come back to life and never wedge again no matter how much you spam.

### What the variable threshold rules out

A fixed-size 16-deep queue + fixed consumer rate would wedge at a fixed count. The 1-to-80 spread means **at least one** of the following is true:

- Consumer rate (LVGL `lv_timer_handler()` cost per iteration) varies a lot — plausible given the welcome scroll animation phase.
- The queue depth varies at the moment of the first user command — implies _some_ background activity is intermittently posting to `lvgl_display_msgq` even before user input.
- The wedge mechanism is **not solely** "queue full + `WAIT_FOREVER`" — there's a secondary blocker that can fire after a single command.

The "sometimes after 1 command" data point is the strongest hint that there's a second mechanism in play.

## What We Proved

### APPROTECT / "device is secured" dialog is a red herring

When the device is wedged, trying to attach RTT through JLink RTT Viewer / `nrfutil device rtt` shows:

> AHB-AP CSW register indicates that the device is secured.
> For debugger connection the device needs to be unsecured.
> Note: Unsecuring will trigger a mass erase…

**Do not click "Yes" — it mass-erases both cores.**

This is **Segger UX misreporting**, not an actual APPROTECT lock. When the SoC is in this wedged state, the AP read can return values that confuse Segger's tooling, and "AHB-AP CSW indicates secured" is its catch-all error. The chip is not actually relocked.

Confirmation: while wedged, you can still read peripheral registers via the AP:

```bash
nrfutil device read --core Application --address 0x50039400 --bytes 4 --direct
# returns a value (e.g. 0x00000001) → AP is reachable
```

If `--direct` returns a value, the AP is fine; ignore the "secured" dialog.

### No silent reset is happening

`RESETREAS` on both cores during the wedge:

```bash
nrfutil device read --core Application --address 0x50039400 --bytes 4 --direct  # App RESETREAS
nrfutil device read --core Network     --address 0x41039400 --bytes 4 --direct  # Net RESETREAS
```

App = `0x00000001` (RESETPIN only, from last manual reset), Net = `0x00000000`. No watchdog (DOG0/DOG1 bits), no CPU lockup, no `sys_reboot`. So this is not a reset issue.

Bit reference for App-core `RESETREAS`:

| Bit | Meaning                         |
| --- | ------------------------------- |
| 0   | RESETPIN — reset button / POR   |
| 1   | DOG0 — watchdog 0               |
| 2   | CTRLAP — debugger reset         |
| 3   | SREQ — software reset           |
| 4   | LOCKUP — CPU lockup             |
| 16  | OFF — wake from System OFF      |
| 17  | LPCOMP — wake                   |
| 18  | DIF — debug interface wake      |
| 20  | DOG1 — watchdog 1               |
| 21  | CTRLAPSOFT — soft CTRL-AP reset |

## Primary Suspect — `WAIT_FOREVER` on a 16-deep msgq

`src/mos_components/mos_display/src/mos_display.c:263`:

```c
void display_set_debug_borders(bool enabled) {
    display_cmd_t cmd = {
        .type = LCD_CMD_SET_DEBUG_BORDERS,
        .p.debug_borders = {.enabled = enabled},
    };
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);  // ← unbounded block
}
```

`lvgl_display_msgq` is `DISPLAY_CMD_QSZ = 16` deep (`mos_display.c:40`).

The consumer is the LVGL display thread (`mos_display.c:564`), priority 6, looping:

```c
mos_msgq_receive(&lvgl_display_msgq, &cmd, LVGL_TICK_MS);  // 5ms
// dispatch
if (need_refresh || lvgl_force_one_refresh)
    lv_timer_handler();   // services LVGL animations + redraw
```

The shell command path (`shell_display_control.c:1607`):

```c
static int cmd_display_debug_border_on(const struct shell *shell, ...) {
    display_set_debug_borders(true);                // ← blocks if queue full
    shell_print(shell, "Debug borders: ON");
    return 0;
}
```

### Initial theory (partial)

- Spam fills 16-deep queue.
- LVGL thread drains slowly because welcome-scene scrolling animation makes each `lv_timer_handler()` expensive, and `mos_ui_main_scene_apply_debug_borders()` invalidates the whole screen each time.
- 17th command posts with `WAIT_FOREVER` → shell thread parks forever on the msgq.
- Shell thread is also its own log backend (`CONFIG_SHELL_LOG_BACKEND` implied) → log thread blocks delivering to USB shell's per-backend log queue (`CONFIG_SHELL_BACKEND_SERIAL_LOG_MESSAGE_QUEUE_SIZE=4096`) → log thread now stuck → can't deliver to RTT shell backend either → RTT also goes dark.
- `CONFIG_LOG_PRINTK=y` + `CONFIG_LOG_MODE_DEFERRED=y` → `CONFIG_LOG_BUFFER_SIZE=8192` eventually fills → other log producers block too.
- Display keeps running because LVGL thread is separate from shell.

### Gaps in the theory

Two observations are not fully explained by "queue full + `WAIT_FOREVER`" alone:

**(a) Wedge persists indefinitely.** If the consumer is merely _slow_, the queue should eventually drain and the shell thread should unblock — but the wedge holds until BLE connects. That means the LVGL consumer must be **truly stuck**, not just slow, OR the shell thread is parked on something different (TX ring, log queue), OR something keeps re-filling the queue at the drain rate.

**(b) Variable threshold including "1 command".** A 16-deep queue can only wedge at the 17th post (or later) if the queue starts empty. To wedge after a _single_ user command, the queue must already be ~full from background activity, **or** the wedge mechanism for that case is something other than the msgq.

These gaps are **unresolved** until we inspect thread state via GDB.

### Leading secondary-mechanism candidate

The strongest fit for "sometimes after 1 command" is **the shell thread parking on its TX ring buffer**, not on the msgq:

- `cmd_display_debug_border_on` calls `display_set_debug_borders(...)` first, then `shell_print(shell, "Debug borders: ON")`.
- `CONFIG_SHELL_BACKEND_SERIAL_TX_RING_BUFFER_SIZE=512` is small.
- If USB CDC is briefly choked (host paused reading for any reason — terminal app glitch, focus switch, DTR jitter), background log lines pile into the TX ring.
- The next command's `shell_print` block-waits on ring space → shell thread parks → cascade as described.
- BLE-connect likely kicks the CDC stack indirectly (Zephyr's USB device subsystem shares some state with BLE on nRF53 — to be confirmed), draining the ring and unsticking everything.

This candidate explains the variable threshold cleanly: it depends on how full the TX ring happens to be at the moment you press Enter, which depends on recent log activity.

The primary `WAIT_FOREVER` bug at `mos_display.c:263` is still a real hazard worth fixing regardless — but it may not be the _only_ wedge mechanism, and possibly not even the dominant one.

### Why BLE-connect unsticks everything

- BLE-connected callback fires: `display_handle_bt_connected()` runs synchronously (caption-state reset), then phone immediately drives UI updates via protobuf characteristic writes (`protobuf_handler.c:918` posts `LCD_CMD_INVALIDATE_VISIBLE_UI`).
- The very first drained queue slot unparks the shell thread; the cascade unwinds in milliseconds.
- The post-BLE UI exits welcome scene → scrolling animation stops → `lv_timer_handler()` becomes cheap → queue drain rate is way higher than any shell spam can fill → wedge cannot recur.

## Other `WAIT_FOREVER` Posters Worth Auditing

Same file, same pattern — anything callable from shell, BLE callbacks, or LVGL timer context that posts unbounded is a landmine:

| Line | Function                         | Caller surface                       |
| ---- | -------------------------------- | ------------------------------------ |
| 63   | `on_font_changed`                | font-change callback (shell or LVGL) |
| 102  | `display_open`                   | boot only; probably safe             |
| 167  | `display_update_height`          | shell + protobuf                     |
| 242  | `display_clear_screen`           | needs audit                          |
| 248  | `display_request_full_redraw`    | shell                                |
| 254  | `display_request_visible_redraw` | shell + protobuf                     |
| 263  | `display_set_debug_borders`      | shell — **the demonstrated bug**     |

## Fix Plan

### 1. Primary — `mos_display.c:263`

```c
void display_set_debug_borders(bool enabled) {
    display_cmd_t cmd = {
        .type = LCD_CMD_SET_DEBUG_BORDERS,
        .p.debug_borders = {.enabled = enabled},
    };
    if (mos_msgq_send(&lvgl_display_msgq, &cmd, K_NO_WAIT) != 0) {
        LOG_WRN("display msgq full, dropping debug-border toggle");
    }
}
```

### 2. Dedupe at command sites

In `cmd_display_debug_border_on/off`, skip the post if `display_get_debug_borders() == enabled`. Prevents trivial queue pressure from repeat keystrokes.

### 3. Audit & convert remaining `WAIT_FOREVER` posters

Use `K_NO_WAIT` or short timeouts (matching the existing `(int64_t)50` / `100` pattern in this file) for any post reachable from shell, BLE callback, or LVGL context. `WAIT_FOREVER` is only safe from background threads where blocking is fine.

### 4. Cheap insurance

Bump `DISPLAY_CMD_QSZ` from 16 to 32 or 64 in `mos_display.c:40`. Cost is trivial; head-room is real.

### 5. Defense in depth — log overflow mode

Add to `prj.conf` so a stalled log consumer can't take down all logging:

```kconfig
CONFIG_LOG_MODE_OVERFLOW=y
```

(Exact symbol may vary by NCS version — check `menuconfig` under _Logging → Mode_ for "drop on overflow.")

### 6. Optional — debug config overlay

For dev builds, disable APPROTECT and enable thread inspection so GDB attach + thread-aware debug works without the unsecure dialog:

```kconfig
# debug.conf overlay
CONFIG_NRF_APPROTECT_LOCK=n
CONFIG_NRF_APPROTECT_USER_HANDLING=n
CONFIG_NRF_SECURE_APPROTECT_LOCK=n
CONFIG_NRF_SECURE_APPROTECT_USER_HANDLING=n
CONFIG_TFM_NRF_APPROTECT=n
CONFIG_TFM_NRF_SECURE_APPROTECT=n

CONFIG_DEBUG_THREAD_INFO=y
CONFIG_THREAD_NAME=y
CONFIG_THREAD_RUNTIME_STATS=y

# RTT log + non-blocking
CONFIG_LOG_BACKEND_RTT=y
CONFIG_USE_SEGGER_RTT=y
CONFIG_SEGGER_RTT_BUFFER_SIZE_UP=4096
CONFIG_LOG_BACKEND_RTT_MODE_OVERWRITE=y
```

## Outstanding Diagnostic — Confirm Exact Stuck Point

The gap above (why doesn't a slow consumer eventually drain?) can be settled by halting the wedged device and reading thread state. Since the AP is reachable during the wedge, this works without resetting:

### Persistent J-Link session (no reset on reconnect)

```bash
# Terminal 1 — leave open
JLinkExe -device nRF5340_xxAA_APP -if SWD -speed 4000 -autoconnect 1
> connect
> rtt start
# leave running

# Terminal 2 — RTT viewer, reconnect freely
telnet localhost 19021
```

JLinkRTTViewer GUI: choose **"Existing Session"** instead of fresh USB connect — same effect.

### GDB attach without reset

```bash
# Terminal 1
JLinkGDBServer -device nRF5340_xxAA_APP -if SWD -speed 4000 \
  -rtos GDBServer/RTOSPlugin_Zephyr

# Terminal 2
arm-zephyr-eabi-gdb build/zephyr/zephyr.elf
(gdb) target remote :2331
(gdb) continue                      # release the connect-time halt
# reproduce the wedge in shell
(gdb) <Ctrl-C>                      # halt in place
(gdb) info threads                  # needs RTOS plugin
(gdb) thread apply all bt 20
(gdb) continue                      # resume so we don't disturb state
```

If RTOS plugin not available, several `Ctrl-C` → `bt` samples will reveal the active thread. Path of `_kernel.threads` works if you walk it manually.

### Backtrace patterns to look for

| Backtrace ends in…                                             | Diagnosis                                              |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `mos_msgq_send` / `k_msgq_put` waiting on `lvgl_display_msgq`  | Shell parked on queue → confirms primary theory        |
| `ring_buf_put` / `uart_poll_out` / `cdc_acm_*`                 | Shell parked on TX ring → different bug, USB CDC stall |
| LVGL thread in `lv_timer_handler` / `a6n_*` / `spi_transceive` | Consumer stuck mid-render → display flush blocked      |
| `logging` thread pending on backend queue                      | Log thread blocked → explains both shells going dark   |

Three or four sampled backtraces from the wedged state will nail this down.

## Tooling Cheat Sheet (Earned The Hard Way)

### nrfutil device

- **nrfjprog is deprecated** — use `nrfutil device` everywhere.
- Peripheral register reads need `--direct`:
  ```bash
  nrfutil device read --core Application --address 0x50039400 --bytes 4 --direct
  ```
- RTT typically resets device on attach. Look for `--reset none` / equivalent flag (varies by version).

### J-Link

- "AHB-AP CSW register indicates that the device is secured" is **often a misleading catch-all** for unresponsive AP, not an actual APPROTECT lock. **Do not mass-erase** unless you've ruled out the device just being mid-wedge.
- Keep one `JLinkExe` session attached + use `telnet localhost 19021` for RTT to avoid reset-on-reconnect.
- Use `JLinkRTTViewer → Existing Session` for the same reason.
- `JLinkGDBServer -rtos GDBServer/RTOSPlugin_Zephyr` for Zephyr thread-aware debug.

### Reset-reason quick read

```bash
nrfutil device read --core Application --address 0x50039400 --bytes 4 --direct
nrfutil device read --core Network     --address 0x41039400 --bytes 4 --direct
```

`RESETREAS` is latching — clear it (write 1s back) if you want to capture a fresh event cleanly.

## TL;DR Action List

1. [ ] **Diagnostic first** — capture GDB backtrace during a wedge. With variable threshold (1 to ~80 commands), the diagnostic is now load-bearing for confirming root cause, not just a "nice to have." See backtrace patterns table above.
2. [ ] Patch `mos_display.c:263` to `K_NO_WAIT` (safe fix regardless of which mechanism is dominant).
3. [ ] Dedupe shell command toggle (skip if already on/off).
4. [ ] Audit other `WAIT_FOREVER` msgq posters in `mos_display.c`.
5. [ ] Bump `DISPLAY_CMD_QSZ` to 32 or 64.
6. [ ] Bump `CONFIG_SHELL_BACKEND_SERIAL_TX_RING_BUFFER_SIZE` from 512 to 4096 — addresses the TX-ring-park candidate.
7. [ ] Add `CONFIG_LOG_MODE_OVERFLOW=y` (or equivalent) to prevent future log-deadlock cascades.
8. [ ] (Optional) Build a `debug.conf` overlay for APPROTECT-off + RTT log + thread info, for easier in-situ debugging.

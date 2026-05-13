# `display pattern` Shell Command — "Display command queue full"

**Date observed:** Reported 2026-05-13 (date of the underlying event itself not recorded)
**Reporter:** Xiong
**Status:** Not investigated, not reproduced. Logged for tracking.

## What Happened

Xiong invoked `display pattern <id>` via the shell. The command returned:

> ❌ Display command queue full

The device kept running, but the pattern did not switch. **A device restart cleared the condition** and subsequent `display pattern` invocations worked normally.

No deeper investigation was performed at the time. No reproduction attempts have been made since.

## Code Path

The error message is emitted at `src/shell_display_control.c:499`, inside `cmd_display_pattern`:

```c
display_cmd_t cmd = {.type = LCD_CMD_SHOW_PATTERN, .p.pattern = {.pattern_id = pattern_id}};

// Use K_NO_WAIT to avoid blocking shell thread - LVGL will process it asynchronously
if (k_msgq_put(&lvgl_display_msgq, &cmd, K_NO_WAIT) != 0)
{
    shell_error(shell, "❌ Display command queue full");
    return -EBUSY;
}
```

The shell command posts non-blocking to `lvgl_display_msgq` (a `K_MSGQ_DEFINE`'d queue consumed by the LVGL display thread). If the queue has no free slot at that exact moment, the post fails immediately with `-EBUSY` and the user sees the error. The shell command itself is well-behaved — it neither blocks nor hangs.

So the report is effectively: **`lvgl_display_msgq` was momentarily full when Xiong's command was processed, and stayed full long enough that retry behavior (if any) didn't matter.**

## What We Don't Know

- The state of the device at the time — what else was running, was BLE connected, was a different display operation in flight.
- How long the queue was full — instantaneous burst, or saturated for a while.
- Why a restart was needed to clear it. A momentary full queue should drain on its own as the LVGL thread services it. If a restart was actually required, the consumer side may have been stuck — but this is speculation without observation.
- Whether this is a one-off or a recurring pattern.
- What other shell command(s) or background activity were happening around the same time.

## What's Worth Doing Next

If we want to confirm whether this is a real recurring issue:

- [ ] Ask Xiong for any additional context they remember from the session — what command sequence preceded the failure, whether BLE was connected, whether the display was animating something heavy, anything that stood out.
- [ ] Add temporary instrumentation: when the `queue full` branch fires, also log the current queue depth and the LVGL thread state. Cheap to add and removes ambiguity if it happens again.
- [ ] Try a deliberate reproduction: send `display pattern` rapidly in a loop, with and without BLE connected, with and without other display activity in parallel. If we can't reproduce it manually, it's probably a benign race; if we can, we have a real bug.

## Notes

- The error path uses `K_NO_WAIT`, so this command itself cannot wedge the shell — it just returns an error and lets the user retry. That's the correct pattern for a shell-triggered display command.
- "Restart fixed it" is an interesting detail. A truly transient queue-full would clear in milliseconds without operator action. If a restart was actually needed (and not just convenient), something held the queue full longer than expected — but we have no data to attribute that to a cause yet.

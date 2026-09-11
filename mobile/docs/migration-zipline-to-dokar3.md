# Migration: Cash App Zipline → dokar3/quickjs-kt

**Status:** Shipped on `mentra-miniapp-sdk-2` (commit `01d2b98a6`, follow-ups `60f4e1a78`/`d8f939fb5`).
**Scope:** Android only. iOS (Apple JSC) unchanged.
**Module:** `mobile/modules/crust/android/`
**Shipped dep:** `io.github.dokar3:quickjs-kt-android:1.0.0-alpha13`
  — NOT 1.0.5: that release ships Kotlin 2.3.0 metadata which this build's
  Kotlin 2.1.20 compiler cannot read. Alpha13 is the last release built with
  Kotlin 2.0 metadata; its API matches 1.0.5 for the surface we use.
**Estimated effort:** 2–3 days end-to-end. Actual: ~half a day end-to-end.

## Why

Zipline's `bind<NativeBridge>("__mentraNativeBridge", impl)` does not expose the bridge as a JS global on `globalThis` — it only registers the service in an internal Kotlin map keyed by name for the Kotlin/JS-compiled `Zipline.take()` API. Our polyfill is hand-written JS; it reads `globalThis.__mentraNativeBridge`, finds undefined, and the GLUE_SCRIPT IIFE bails at `if (!bridge) return;`. Result: `__dispatch`, `__hostLog`, and every other host-callable global is missing on Android — confirmed by `pre-glue globals: bridge=undefined keys=[]` in logcat. Outbound JS→host traffic has been silently dropped since Android crust was written.

dokar3/quickjs-kt exposes `QuickJs.function(name) { args -> ... }` which installs the lambda directly as a property of `globalThis` via QuickJS's `JS_SetPropertyStr(JS_NewCFunction(...))`. This matches iOS's `ctx.setObject(closure, forKeyedSubscript: "__dispatch" as NSString)` pattern point-for-point.

## Non-goals

- No iOS changes. iOS keeps Apple JSC; the polyfill abstraction layer means the JS user-API surface stays identical.
- No new sandbox features. We are doing a like-for-like engine wrapper swap.
- No interrupt-handler / runaway-loop protection in this migration. Tracked as a follow-up (see §Risk register).
- No bytecode precompilation. We continue passing source strings to `evaluate()`.

## What the user-visible JS surface keeps

The polyfill bundle (`modules/jspolyfill/assets/startup.js`) and the SDK (`@mentra/miniapp`) are unchanged. From the JS side, all of these must still be installed on `globalThis` before the polyfill evaluates:

| Global | Signature | Sync/Async | Notes |
|---|---|---|---|
| `__dispatch(iface, method, argsJson)` | `(s, s, s) → string \| null` | sync, may throw | Returns dispatcher JSON, null for Async/ForwardToRn, throws on Error |
| `__hostLog(level, messageJson)` | `(s, s) → void` | fire-and-forget | Routes to `__log` outbound |
| `__hostError(payloadJson)` | `(s) → void` | fire-and-forget | Routes to `__error.uncaught` outbound |
| `__hostUnhandledRejection(payloadJson)` | `(s) → void` | fire-and-forget | Routes to `__error.unhandledRejection` outbound |
| `__nativeSetTimeout(token, delayMs)` | `(int, int) → void` | fire-and-forget | Schedules wallclock callback |
| `__nativeClearTimer(token)` | `(int) → void` | fire-and-forget | Cancels scheduled |

Same set iOS installs at `JSCRuntime.swift:497–574`. Migration parity check: read iOS `setObject` block and confirm 1:1 with the Kotlin bindings.

## Files touched

### Modified
- `mobile/modules/crust/android/build.gradle` — drop Zipline plugin + dep, add dokar3 dep.
- `mobile/modules/crust/android/src/main/java/com/mentra/crust/jsc/JSCRuntime.kt` — full rewrite of engine ownership. ~40% of file lines change. Public API surface (`spawn`, `kill`, `evaluate`, `dispatchToJs`, `markReady`, `isAlive`, `alivePackages`, `debugForceGC`, `loadPolyfillBundle`, `onOutbound`, `OutboundMessage`, `MentraJSDispatchError`) is preserved so callers don't change.

### Unchanged (verify after Phase 1; do not touch)
- `mobile/modules/crust/android/src/main/java/com/mentra/crust/CrustModule.kt` — calls `JSCRuntime.shared(ctx).spawn/kill/evaluate/dispatchToJs/alivePackages/debugForceGC/loadPolyfillBundle` plus `JSCRuntime.shared(ctx).dispatcher.setManifest(...)`. Every signature stays exactly the same after the migration.
- `mobile/modules/crust/android/src/main/java/com/mentra/crust/jsc/JSCDispatcher.kt` — engine-agnostic.
- `mobile/modules/crust/android/src/main/java/com/mentra/crust/jsc/JSCPolyfillBridge.kt` — engine-agnostic.
- `mobile/modules/jspolyfill/assets/startup.js` — polyfill unchanged.
- iOS `JSCRuntime.swift` — unchanged.
- `MentraJSRouter.ts`, `LocalMiniappRuntime.ts`, the SDK `@mentra/miniapp` — unchanged.

### Deleted from `JSCRuntime.kt`
- The `interface NativeBridge : ZiplineService` block.
- The `private inner class JSCBridgeImpl(...) : NativeBridge` block.
- The `private val GLUE_SCRIPT: String = """..."""` constant.
- The diagnostic logging added during debugging: `pre-glue globals`, `post-init probe`, `dispatchToJs(...)` info log, `__deliver returned cleanly`.

### Kept in `JSCRuntime.kt`
- `MentraJSDispatchError` — still thrown from the `__dispatch` binding lambda. Dokar3 surfaces Kotlin throwables as JS Errors (validated in Phase 0.5).
- The production logs: `runtime installed`, `outbound dropped (no sink)`, `spawned`, `killed`, `NACK`, watchdog `__error.watchdog_kill`.

## Architecture parity (iOS ↔ Android after migration)

```
                     iOS (JSCRuntime.swift)            Android (JSCRuntime.kt, post-migration)
                     ──────────────────────            ────────────────────────────────────────
JS engine            Apple JSC (JSContext)             QuickJS via dokar3 (QuickJs)
Thread model         per-context DispatchQueue         per-context single-thread Executor
Coroutine wrapping   n/a (Swift blocks)                executor.asCoroutineDispatcher(); runBlocking
Global install       ctx.setObject(closure, ...)       qjs.function(name) { args -> ... }
                                                       qjs.asyncFunction NOT used (we want sync)
JS → host bridge     6 globals, all sync               6 globals, all sync (sync return for
                                                         __dispatch; fire-and-forget for the rest)
Host → JS bridge     ctx.evaluateScript(__deliver…)    runBlocking(dispatcher) { qjs.evaluate(…) }
Exception propagation Kotlin throw → JS Error           Kotlin throw → JS Error (dokar3 wraps)
Timers               DispatchQueue.after               ScheduledExecutorService → executor →
                                                         qjs.evaluate("__deliverTimer(token)")
Memory cap           JSC default                       qjs.memoryLimit (set per context)
Stack cap            JSC default                       qjs.maxStackSize
NACK / watchdog      same scheme as Android             unchanged
```

The diagram captures the only places where the engines differ visibly. Everything above the "JS engine" row stays cross-platform identical.

## Phase 0 — Pre-work and validation

**Goal:** confirm dokar3 actually does what we need on Android before touching production code.

### 0.1 Add dokar3 dependency to build.gradle

In `mobile/modules/crust/android/build.gradle`:

```groovy
// Inside dependencies { … } block (around line 120 where Zipline is today):
implementation 'io.github.dokar3:quickjs-kt-android:1.0.5'
```

Do **not** remove Zipline yet. Both can coexist during the spike.

Run `bun expo prebuild --platform android` then `cd android && ./gradlew :crust:compileDebugKotlin`. Must build clean.

### 0.2 Verify AAR contents

After first sync, confirm `~/.gradle/caches/modules-2/files-2.1/io.github.dokar3/quickjs-kt-android/1.0.5/.../quickjs-kt-android-1.0.5.aar` contains:

- `libquickjs.so` for `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`.
- 16KB page alignment (relevant for Android 15+; Play Store requires this for new submissions after Nov 2025).

Quick check:
```bash
unzip -l ~/.gradle/caches/modules-2/files-2.1/io.github.dokar3/quickjs-kt-android/1.0.5/*/quickjs-kt-android-1.0.5.aar | grep '\.so'
```

### 0.3 Standalone spike

Create `mobile/modules/crust/android/src/main/java/com/mentra/crust/jsc/DokarSpike.kt` (throwaway file, **do not commit**):

```kotlin
package com.mentra.crust.jsc

import android.util.Log
import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import java.util.concurrent.Executors

object DokarSpike {
    private const val TAG = "DokarSpike"

    fun run() {
        val exec = Executors.newSingleThreadExecutor { r ->
            Thread(r, "spike-js").apply { isDaemon = true }
        }
        val dispatcher = exec.asCoroutineDispatcher()
        // Hop everything onto the executor so dokar3's mutex serialization
        // doesn't have to worry about cross-thread interactions; mirrors the
        // production model in JSCRuntime.
        exec.submit {
            val qjs = QuickJs.create(dispatcher).apply {
                memoryLimit = 16L * 1024 * 1024
                maxStackSize = 256L * 1024
            }
            qjs.function("__dispatch") { args ->
                Log.i(TAG, "dispatch sync: iface=${args[0]} method=${args[1]} args=${args[2]}")
                "{\"ok\":true,\"echo\":\"${args[2]}\"}"  // sync string return
            }
            qjs.function<Unit>("__hostLog") { args ->
                Log.i(TAG, "hostLog level=${args[0]} msg=${args[1]}")
            }
            try {
                val result = runBlocking(dispatcher) {
                    qjs.evaluate<String>(
                        """
                        const r = globalThis.__dispatch("test", "echo", "hello");
                        globalThis.__hostLog("info", JSON.stringify({sawResult: r}));
                        JSON.parse(r).echo
                        """.trimIndent(),
                        filename = "spike.js",
                    )
                }
                Log.i(TAG, "evaluate returned: $result")
            } catch (e: Throwable) {
                Log.e(TAG, "spike threw", e)
            } finally {
                qjs.close()
            }
        }.get()
        exec.shutdown()
    }
}
```

Invoke from a debug-menu button or temporary `CrustModule` AsyncFunction:

```kotlin
// In CrustModule.definition(), temporarily:
AsyncFunction("dokarSpike") { -> DokarSpike.run() }
```

Then call from RN dev tools / a temporary button.

**Pass criteria** (logcat under tag `DokarSpike`):
1. `dispatch sync: iface=test method=echo args=hello`
2. `hostLog level=info msg={"sawResult":"{\"ok\":true,\"echo\":\"hello\"}"}`
3. `evaluate returned: hello`

If any of those don't fire, **stop the migration** and regroup.

### 0.4 Validate thread affinity

After the spike works, change the spike to assert single-thread discipline:

```kotlin
val capturedThread = Thread.currentThread()
qjs.function("__dispatch") { args ->
    check(Thread.currentThread() == capturedThread) { "binding ran off-thread: ${Thread.currentThread().name}" }
    "ok"
}
```

This should not throw — confirms the dispatcher is honoring our executor.

### 0.5 Validate Kotlin exception → JS-catchable throw

**This is critical and must pass.** The SDK's dispatch wrapper relies on
JS-side `try { __dispatch(...) } catch (e) { ... }` catching Kotlin throws.
If the throw escapes the JS try/catch and unwinds the whole `evaluate()`
call, our dispatch protocol is broken on Android.

```kotlin
qjs.function("__throwy") { _ -> throw RuntimeException("boom") }
val caught = runBlocking(dispatcher) {
    qjs.evaluate<String>(
        """
        try { __throwy(); "unreached" }
        catch (e) { "caught: " + (e && e.message ? e.message : "no message") }
        """.trimIndent(),
        filename = "throwy.js",
    )
}
Log.i(TAG, "result=$caught")
```

**Pass criteria**: log shows `result=caught: boom` (or `result=caught: ...boom...`
with some wrapper prefix). If instead the log shows `spike threw` and the
exception propagated to Kotlin's catch block, **dokar3's error model is
incompatible with our dispatch protocol** — we'd have to revisit the choice.

If this fails, options:
- Patch dokar3's JNI to convert Kotlin throws to `JS_Throw(JS_NewError(...))`.
- Switch to quickjs-wrapper (which the report indicates does this correctly).
- Modify the SDK to use sentinel return values instead of throws for errors.

### 0.6 Delete the spike

Once Phase 0 passes, delete `DokarSpike.kt` and revert the temporary `AsyncFunction("dokarSpike")` in `CrustModule.kt`. **Do not commit the spike** — it's validation, not product code.

**Phase 0 deliverable:** confidence that dokar3 works as advertised on your target device. Maybe a Slack message confirming the three log lines.

## Phase 1 — Engine swap in `JSCRuntime.kt`

**Goal:** replace Zipline with dokar3 inside `JSCRuntime`. External API of `JSCRuntime` (the `spawn`, `kill`, `dispatchToJs`, `evaluate`, `debugForceGC`, `markReady`, `alivePackages`, `isAlive`, `onOutbound`, `OutboundMessage` surface used by `CrustModule.kt`) **must stay unchanged**. Internal implementation only.

### 1.1 Imports

Remove:
```kotlin
import app.cash.zipline.Zipline
import app.cash.zipline.ZiplineService
import kotlinx.coroutines.asCoroutineDispatcher
```

Add:
```kotlin
import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
```

(`asCoroutineDispatcher` is still present — we use it for the executor→dispatcher
conversion. `CoroutineDispatcher` is referenced as the type of the new
`ContextRecord.jsDispatcher` field. `runBlocking` is the bridge from synchronous
host code into dokar3's `suspend evaluate(...)`.)

### 1.2 Rewrite `ContextRecord`

Old:
```kotlin
private inner class ContextRecord(
    val packageName: String,
    val zipline: Zipline,
    val executor: ExecutorService,
    val pendingTimers: MutableMap<Int, ScheduledFuture<*>> = ConcurrentHashMap(),
    @Volatile var readyAcked: Boolean = false,
    @Volatile var readyNackTimer: ScheduledFuture<*>? = null,
    @Volatile var watchdogTimer: ScheduledFuture<*>? = null,
) {
    val quickJs get() = zipline.quickJs
}
```

New:
```kotlin
private inner class ContextRecord(
    val packageName: String,
    val qjs: QuickJs,
    val executor: ExecutorService,
    val jsDispatcher: CoroutineDispatcher,
    val pendingTimers: MutableMap<Int, ScheduledFuture<*>> = ConcurrentHashMap(),
    @Volatile var readyAcked: Boolean = false,
    @Volatile var readyNackTimer: ScheduledFuture<*>? = null,
    @Volatile var watchdogTimer: ScheduledFuture<*>? = null,
)
```

Two changes: `zipline: Zipline` → `qjs: QuickJs`, and we cache the dispatcher (needed for `runBlocking` calls in `dispatchToJs` and `evaluate`).

### 1.3 Rewrite `spawn()`

Replace the entire body of `spawn(...)`:

```kotlin
fun spawn(packageName: String, polyfillBundleOverride: String?, miniappJs: String): Boolean {
    if (isAlive(packageName)) {
        kill(packageName)
    }
    val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "MentraJS-$packageName").apply { isDaemon = true }
    }
    // Local var renamed to avoid shadowing the class field `dispatcher: JSCDispatcher`.
    val jsDispatcher = executor.asCoroutineDispatcher()

    // Create the QuickJs context ON the executor thread. dokar3's QuickJs is
    // mutex-serialized rather than thread-affinity-asserted, but keeping every
    // operation on one thread matches iOS and avoids any surprises with the
    // JNI handle lifecycle. `create` is sync (non-suspend), so no runBlocking
    // is needed here — only `evaluate()` is suspend.
    val qjs = try {
        executor.submit<QuickJs> {
            QuickJs.create(jsDispatcher).apply {
                memoryLimit = 32L * 1024 * 1024     // 32 MB heap per miniapp
                maxStackSize = 512L * 1024          // 512 KB stack
            }
        }.get()
    } catch (e: Throwable) {
        Log.e(TAG, "QuickJs.create() failed for $packageName", e)
        executor.shutdownNow()
        return false
    }

    val record = ContextRecord(
        packageName = packageName,
        qjs = qjs,
        executor = executor,
        jsDispatcher = jsDispatcher,
    )
    contexts[packageName] = record

    armReadyNackTimer(record, COLD_START_NACK_TIMEOUT_MS, cold = true)

    val bundle = polyfillBundleOverride ?: polyfillBundle

    return try {
        executor.submit<Boolean> {
            runBlocking(jsDispatcher) {
                installGlobals(qjs, packageName)
                if (bundle.isNotEmpty()) {
                    qjs.evaluate<Any?>(bundle, filename = "mentrajs:startup.js")
                }
                if (miniappJs.isNotEmpty()) {
                    qjs.evaluate<Any?>(miniappJs, filename = "mentrajs:miniapp.js")
                }
            }
            Log.i(TAG, "spawned $packageName")
            true
        }.get()
    } catch (e: Throwable) {
        Log.e(TAG, "spawn failed for $packageName: ${e.message}", e)
        kill(packageName)
        false
    }
}
```

### 1.4 New `installGlobals()` method

Replace the `GLUE_SCRIPT` + `JSCBridgeImpl` + `NativeBridge` complex with one Kotlin function that installs all six globals directly:

```kotlin
private fun installGlobals(qjs: QuickJs, packageName: String) {
    // __dispatch: sync. Returns JSON or null. Throws on dispatcher Error.
    qjs.function("__dispatch") { args ->
        val record = contexts[packageName] ?: return@function null
        val iface = args[0] as? String ?: throw MentraJSDispatchError("INVALID_ARGS", "iface")
        val method = args[1] as? String ?: throw MentraJSDispatchError("INVALID_ARGS", "method")
        val argsJson = args[2] as? String ?: throw MentraJSDispatchError("INVALID_ARGS", "argsJson")
        val parsed = parseArgsEnvelope(argsJson)
        val outcome = dispatcher.handle(
            packageName = packageName,
            iface = iface,
            method = method,
            args = parsed.first,
            reqId = parsed.second,
        )
        when (outcome) {
            is JSCDispatchOutcome.Sync -> outcome.json
            is JSCDispatchOutcome.Async -> null
            is JSCDispatchOutcome.Error -> throw MentraJSDispatchError(outcome.code, outcome.message ?: outcome.code)
            is JSCDispatchOutcome.ForwardToRn -> {
                val payload = HashMap<String, Any?>(outcome.payload)
                payload["packageName"] = packageName
                payload["iface"] = iface
                payload["method"] = method
                parsed.second?.let { payload["reqId"] = it }
                deliverOrDrop(OutboundMessage(packageName, payload))
                null
            }
        }
    }

    // __hostLog: fire-and-forget.
    qjs.function<Unit>("__hostLog") { args ->
        deliverOrDrop(OutboundMessage(
            packageName,
            mapOf(
                "packageName" to packageName,
                "iface" to "__log",
                "method" to (args[0] as? String ?: "log"),
                "argsJson" to (args[1] as? String ?: "[]"),
            ),
        ))
    }

    // __hostError: window.onerror trampoline.
    qjs.function<Unit>("__hostError") { args ->
        deliverOrDrop(OutboundMessage(
            packageName,
            mapOf(
                "packageName" to packageName,
                "iface" to "__error",
                "method" to "uncaught",
                "argsJson" to (args[0] as? String ?: "{}"),
            ),
        ))
    }

    // __hostUnhandledRejection: Promise unhandledrejection trampoline.
    qjs.function<Unit>("__hostUnhandledRejection") { args ->
        deliverOrDrop(OutboundMessage(
            packageName,
            mapOf(
                "packageName" to packageName,
                "iface" to "__error",
                "method" to "unhandledRejection",
                "argsJson" to (args[0] as? String ?: "{}"),
            ),
        ))
    }

    // __nativeSetTimeout: schedule wallclock callback. Fires __deliverTimer.
    qjs.function<Unit>("__nativeSetTimeout") { args ->
        val token = (args[0] as? Number)?.toInt() ?: return@function
        val delayMs = (args[1] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L
        scheduleTimer(packageName, token, delayMs)
    }

    // __nativeClearTimer: cancel scheduled.
    qjs.function<Unit>("__nativeClearTimer") { args ->
        val token = (args[0] as? Number)?.toInt() ?: return@function
        contexts[packageName]?.pendingTimers?.remove(token)?.cancel(false)
    }
}

private fun scheduleTimer(packageName: String, token: Int, delayMs: Long) {
    val record = contexts[packageName] ?: return
    val future = timerScheduler.schedule({
        record.pendingTimers.remove(token)
        try {
            record.executor.submit {
                runBlocking(record.jsDispatcher) {
                    try {
                        record.qjs.evaluate<Any?>(
                            "globalThis.__deliverTimer && globalThis.__deliverTimer($token);",
                            filename = "mentrajs:timer-$token.js",
                        )
                    } catch (e: Throwable) {
                        Log.w(TAG, "timer fire threw in $packageName: ${e.message}")
                    }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // Context already killed — drop silently.
        }
    }, delayMs, TimeUnit.MILLISECONDS)
    record.pendingTimers[token] = future
}
```

### 1.5 Rewrite `dispatchToJs()`

The shape doesn't change. Only the inner evaluate call gets wrapped in `runBlocking(record.jsDispatcher)`:

```kotlin
fun dispatchToJs(packageName: String, envelopeJson: String) {
    val record = contexts[packageName] ?: run {
        // Quiet drop — happens during normal teardown races. Was a warning
        // during the migration but no longer interesting once the bridge works.
        return
    }
    if (record.readyAcked) {
        armReadyNackTimer(record, STEADY_STATE_NACK_TIMEOUT_MS, cold = false)
    }
    try {
        record.executor.submit {
            val warn = timerScheduler.schedule({
                Log.i(TAG, "watchdog: $packageName __deliver blocked >${WATCHDOG_WARN_MS}ms")
            }, WATCHDOG_WARN_MS, TimeUnit.MILLISECONDS)
            val killTimer = timerScheduler.schedule({
                Log.e(TAG, "watchdog: $packageName blocked >${WATCHDOG_KILL_MS}ms, killing")
                deliverOrDrop(OutboundMessage(
                    packageName,
                    mapOf(
                        "packageName" to packageName,
                        "iface" to "__error",
                        "method" to "watchdog_kill",
                        "argsJson" to org.json.JSONObject(
                            mapOf("thresholdMs" to WATCHDOG_KILL_MS) as Map<*, *>,
                        ).toString(),
                    ),
                ))
                kill(packageName)
            }, WATCHDOG_KILL_MS, TimeUnit.MILLISECONDS)
            record.watchdogTimer = killTimer
            try {
                val source = "globalThis.__deliver(${jsStringLiteral(envelopeJson)});"
                runBlocking(record.jsDispatcher) {
                    record.qjs.evaluate<Any?>(source, filename = "mentrajs:deliver.js")
                }
                record.readyNackTimer?.cancel(false)
                record.readyNackTimer = null
            } catch (e: Throwable) {
                Log.w(TAG, "dispatchToJs threw in $packageName: ${e.message}", e)
            } finally {
                warn.cancel(false)
                killTimer.cancel(false)
                if (record.watchdogTimer === killTimer) record.watchdogTimer = null
            }
        }
    } catch (_: java.util.concurrent.RejectedExecutionException) {
        // Context killed mid-flight — drop. dispatchToJs is best-effort.
    }
}
```

### 1.6 Rewrite `evaluate()`

```kotlin
fun evaluate(packageName: String, source: String): Any? {
    val record = contexts[packageName] ?: return null
    return try {
        record.executor.submit<Any?> {
            runBlocking(record.jsDispatcher) {
                record.qjs.evaluate<Any?>(source, filename = "mentrajs:eval-${System.nanoTime()}.js")
            }
        }.get()
    } catch (e: Throwable) {
        Log.w(TAG, "evaluate threw in $packageName: ${e.message}")
        null
    }
}
```

### 1.7 Rewrite `kill()`

`QuickJs.close()` is sync (not suspend) — no `runBlocking` needed. We still hop
onto the executor thread to satisfy thread affinity.

```kotlin
fun kill(packageName: String) {
    val record = contexts.remove(packageName) ?: return
    for ((_, future) in record.pendingTimers) future.cancel(false)
    record.pendingTimers.clear()
    record.readyNackTimer?.cancel(false)
    record.readyNackTimer = null
    record.watchdogTimer?.cancel(false)
    record.watchdogTimer = null
    try {
        record.executor.submit {
            try {
                record.qjs.close()
            } catch (e: Throwable) {
                Log.w(TAG, "QuickJs.close() threw for $packageName: ${e.message}")
            }
        }.get(2, TimeUnit.SECONDS)
    } catch (e: Throwable) {
        Log.w(TAG, "killed $packageName but cleanup hit ${e.javaClass.simpleName}")
    } finally {
        record.executor.shutdownNow()
    }
    Log.i(TAG, "killed $packageName")
}
```

### 1.8 Rewrite `debugForceGC()`

`qjs.gc()` is sync. Same pattern — hop to executor thread, no `runBlocking`.

```kotlin
fun debugForceGC(packageName: String): Boolean {
    val record = contexts[packageName] ?: return false
    return try {
        record.executor.submit {
            try { record.qjs.gc() } catch (_: Throwable) { }
        }
        true
    } catch (_: Throwable) {
        false
    }
}
```

### 1.9 Delete dead code

In `JSCRuntime.kt`, remove:
- The entire `interface NativeBridge : ZiplineService { ... }` block.
- The entire `private inner class JSCBridgeImpl(...) : NativeBridge { ... }` block.
- The `private val GLUE_SCRIPT: String = """..."""` constant.
- The temporary diagnostic logging:
  - `pre-glue globals in ...` block in `spawn()`.
  - `dispatchToJs(...)` info log line.
  - `__deliver returned cleanly in ...` info log line.
  - `post-init probe in ...` block.

Keep:
- `MentraJSDispatchError` class — still thrown from the `__dispatch` binding lambda. dokar3 surfaces Kotlin throws as JS Errors.
- `parseArgsEnvelope`, `jsonArrayToList`, `jsonValueToAny`, `jsStringLiteral`.
- `OutboundMessage`, `onOutbound`, `deliverOrDrop`, `droppedOutboundCount`.
- NACK and watchdog scaffolding.

### 1.10 Update class doc comment

The class header doc says "QuickJS (via Cash App's Zipline)". Change to "QuickJS (via dokar3/quickjs-kt)". Update the "Zipline drains them during bridge re-entry" paragraph to "dokar3 drains pending jobs after each evaluate() and after async binding completion via QuickJS's JS_ExecutePendingJob loop."

## Phase 2 — Remove Zipline from the build

Only do this after Phase 1 compiles and the smoke test in Phase 3 passes.

### 2.1 `build.gradle` edits

In `mobile/modules/crust/android/build.gradle`:

Remove:
```groovy
classpath 'app.cash.zipline:zipline-gradle-plugin:1.20.0'
```
from the buildscript dependencies block.

Remove:
```groovy
apply plugin: 'app.cash.zipline'
```
from the plugin application section.

Remove:
```groovy
implementation 'app.cash.zipline:zipline-android:1.20.0'
```
from the dependencies block.

Keep the `kotlin-serialization` plugin and classpath — other code in the module may still need it. (Check by grepping for `@Serializable` in `modules/crust/android/src/`. If nothing uses it, remove that too in a follow-up cleanup.)

### 2.2 Clean and re-prebuild

```bash
cd mobile
bun expo prebuild --platform android
cd android
./gradlew :crust:clean :crust:assembleDebug
```

Build must succeed. Look for any leftover Zipline references the compiler would catch.

### 2.3 Verify APK shrinks

`./gradlew :app:assembleDebug` and check `app/build/outputs/apk/debug/app-debug.apk` size. Zipline pulls kotlinx-serialization plus a vendored QuickJS. dokar3 ships its own QuickJS. Expect APK size to be roughly flat or slightly smaller.

## Phase 3 — Device smoke test

### 3.1 Pre-checks before launching

- `bun android` builds and installs.
- App launches; logcat shows `onOutbound sink installed` and `runtime installed (OnCreate)` (these are the same lines as before; unchanged behavior outside the engine swap).

### 3.2 Open the example miniapp

Navigate to `com.mentra.example` via the dev miniapp catalog. Expected logcat (tag `MentraJS`) in order:

1. `spawned com.mentra.example` — context created, polyfill + miniapp.js evaluated cleanly.
2. **No** `NACK: ... cold-start ready signal not received` — polyfill's `__dispatch("__runtime", "ready", ...)` succeeded.
3. RN-side log `[LOCAL_MINIAPP] registerApp(com.mentra.example)` (this is unchanged).
4. Outbound `__log` events as the example miniapp's `console.log` fires.
5. Outbound `__bridge.send` envelopes carrying CONNECT / SUBSCRIBE frames. These should land in `MentraJSRouter`'s `mentrajs_message` handler.
6. RN-side `MIC_COORDINATOR: local requirements updated — pcm=false→true` once the SUBSCRIBE for transcription is processed by `LocalMiniappRuntime`.
7. Mic actually turning on (visible glasses-app indicator or via `adb shell dumpsys media.audio_policy`).

**Pass criteria:**
- Mic turns on within ~3 seconds of opening the miniapp.
- Transcription text appears in the miniapp's UI (the example app displays it).
- No `outbound dropped (no sink)` warnings.
- No `dispatchToJs threw` warnings.

If any of these fail, capture logcat to a file and diagnose.

### 3.3 Stress tests

Once smoke test passes:

- **Reopen test:** back out of the miniapp, reopen. Verify the existing context is killed and respawned cleanly. Should see `killed com.mentra.example` then `spawned com.mentra.example`.
- **Dev reload test:** change one line in the example miniapp's source, save. The dev server should send `respawn-bg`. Verify the miniapp reloads and works again.
- **Background test:** open the miniapp, then background the app, then foreground. The miniapp should keep working — no respawn, no broken state.
- **Multiple miniapps test (if a second dev miniapp is available):** open A, then open B. Both contexts should be alive simultaneously. Outbound traffic from both should be routed correctly by `packageName`.
- **iOS parity check:** open the same miniapp on iOS and Android side by side. Visible behavior must be identical.

### 3.4 Cleanup probe

Once smoke test passes, do one final code review pass on `JSCRuntime.kt`:

- All Zipline imports removed.
- No `NativeBridge` or `ZiplineService` references.
- No `GLUE_SCRIPT` constant.
- No diagnostic-only logs from the debugging session (`pre-glue globals`, `post-init probe`, `dispatchToJs(...)` info log, `__deliver returned cleanly`).
- All `runBlocking(record.jsDispatcher) { ... }` calls happen inside an `executor.submit { ... }` (to keep thread affinity).
- `MentraJSDispatchError` still imported and thrown from `__dispatch`.

## Phase 4 — Documentation and follow-up

### 4.1 Update `modules/crust/android/AGENTS.md` (or top-of-file doc comment in `JSCRuntime.kt`)

Add a section documenting the new architecture:

```markdown
## MentraJS Android runtime

Each miniapp gets its own QuickJs context via dokar3/quickjs-kt, owned by a
dedicated single-thread executor. We install six host-callable globals
(`__dispatch`, `__hostLog`, `__hostError`, `__hostUnhandledRejection`,
`__nativeSetTimeout`, `__nativeClearTimer`) using `qjs.function(name) { ... }`,
mirroring iOS's `ctx.setObject(closure, forKeyedSubscript: ...)` pattern.

### Threading rule

Every QuickJs operation must run on its context's dedicated executor thread.
We use `runBlocking(record.jsDispatcher) { qjs.evaluate(...) }` from inside
`executor.submit { ... }` to satisfy both dokar3's coroutine entry point and
the thread-affinity invariant.

### Re-entrancy rule

**Bindings must not call `qjs.evaluate()` on the same instance.** dokar3's
internal `jsMutex` is held across `evaluate()`; a binding that re-enters
deadlocks. Our `__dispatch` returns a string and may throw, but never
re-evaluates JS, so this rule is satisfied by construction. Future bindings
must observe it.

### No runaway-loop protection (yet)

dokar3 1.0.5 does not expose `JS_SetInterruptHandler`. A miniapp that runs
`while(true){}` will pin its executor thread until process restart. Mitigations:

- Miniapps are vetted through the store. Infinite loops should not pass review.
- Each miniapp has its own executor — runaway in A does not affect B.
- Future work: upstream a `setInterruptHandler` PR to dokar3, or fork.
```

### 4.2 File the follow-up issue

Create a tracking issue / TODO:

> **MentraJS: add interrupt-handler support for runaway miniapp protection**
>
> dokar3/quickjs-kt 1.0.5 does not expose `JS_SetInterruptHandler` from
> QuickJS, so a miniapp that enters an infinite loop pins its executor
> thread until app restart.
>
> Fix: add ~30 LoC JNI + ~20 LoC Kotlin to
> `quickjs/native/jni/quickjs_jni.c` + `QuickJs.jni.kt`. Submit upstream PR
> to dokar3/quickjs-kt. Until merged, carry locally.
>
> Until then, document the limit for miniapp developers.

### 4.3 Update developer-facing miniapp docs

Wherever miniapp developer documentation lives (likely `cloud/websites/docs` or `docs/`), add a note:

> **Avoid infinite loops in background code.** Smart-glasses miniapps run
> in a sandboxed QuickJS context on Android. The Android sandbox cannot
> currently kill a runaway loop — it will pin a thread until the host app
> restarts. Use timers, events, or async patterns instead of busy waits.

### 4.4 Commit

One commit (or PR), title:

```
android: replace Zipline with dokar3/quickjs-kt for direct JS global install
```

Body:

```
Zipline.bind(name, service) registers services in an internal Kotlin map
keyed by name for the Kotlin/JS-compiled Zipline.take() API — it does not
install JS globals on globalThis. Our polyfill is hand-written JS and
reads globalThis.__mentraNativeBridge, which was always undefined.
Outbound JS→host traffic (mic SUBSCRIBE, display calls, hostLog) has been
silently dropped on Android since the crust module was written.

This swaps the engine wrapper from Cash App Zipline to dokar3/quickjs-kt,
which exposes JS_SetPropertyStr-backed global function install via
qjs.function(name) { args -> ... }, mirroring iOS Apple JSC's
ctx.setObject(closure, forKeyedSubscript: ...) pattern point-for-point.

- Same engine (QuickJS), different Kotlin wrapper.
- iOS unchanged. Polyfill unchanged. SDK unchanged. MentraJSRouter unchanged.
- One context per miniapp on a dedicated single-thread executor (unchanged).
- Memory cap + stack cap set per context.
- Known limit (tracked separately): no interrupt-handler exposure → no
  runaway-loop protection. Vetted miniapps only for now.

Confirmed in logcat: post-init outbound traffic now flows, mic subscribes,
transcription reaches the example miniapp's UI.
```

## Risk register

| # | Risk | Likelihood | Mitigation |
|---|------|-----------|-----------|
| 1 | dokar3 has a Kotlin/JNI bug we don't find until a real device run | medium | Phase 0 spike catches simple cases; Phase 3 smoke test catches integration cases; library is small (~2000 LoC), readable in a day if something weird shows up. |
| 2 | Mutex deadlock from a binding accidentally re-entering `evaluate()` | low | Documented constraint in module README. Current bindings don't do this. Future bindings must observe the rule. |
| 3 | Performance regression vs Zipline | very low | dokar3 is thinner. Spike timings will confirm in Phase 0.5 if we add a perf assertion. |
| 4 | Runaway miniapp pins a thread | low–medium | Accepted for v1. Each miniapp has its own executor so blast radius is one miniapp. Document. Plan upstream PR. |
| 5 | dokar3 maintainer goes inactive | medium | The library is small enough that we can fork and own it. Same risk class as our current Zipline dep. Apache-2.0 license. |
| 6 | iOS Apple JSC and Android QuickJS diverge on a specific JS spec corner | low | Polyfill is single source of truth for host API. If a JS feature differs (e.g. WeakRef behavior), the divergence will surface during testing. Bellard QuickJS supports ES2023 + WeakRef + FinalizationRegistry; Apple JSC is more current but the polyfill doesn't use anything bleeding-edge. |
| 7 | Timer scheduler races with `kill()` | low | `kill()` cancels `pendingTimers` futures and `shutdownNow()`'s the executor before close. Scheduled fires that arrive after teardown hit `RejectedExecutionException` and are dropped (handled with a `catch`). |
| 8 | Kotlin throw from a binding is NOT catchable by JS `try { __dispatch(...) } catch (e) { ... }` — instead it escapes to the host's `evaluate()` caller and tears down the script | **high impact, unknown likelihood** | Validated explicitly by Phase 0.5. If this fails, options are: (a) patch dokar3 to wrap throws via `JS_Throw(JS_NewError(...))`, (b) switch to `HarlonWang/quickjs-wrapper` (the second-choice library that the research said does this correctly), or (c) refactor the SDK to use sentinel return values (`{ok:false, code, message}` envelopes) instead of throws. **DO NOT proceed past Phase 0 until this is validated.** |
| 9 | `runBlocking(jsDispatcher)` from inside `executor.submit { }` deadlocks | very low | The submit runs on the executor thread; `runBlocking` parks that thread inside its event loop and dispatches the suspend block back to that same thread. This is the canonical pattern for bridging a single-thread executor to a coroutine API. Validated by the spike in Phase 0. |

## Out of scope (future work)

- Interrupt-handler / runaway-loop protection.
- Bytecode precompilation (`qjs.compile()` → cached bytecode) for faster miniapp startup.
- Switching dokar3's vendored QuickJS to QuickJS-NG for more spec coverage.
- Shared polyfill cache across contexts (currently each context re-evaluates the 27KB polyfill).
- Memory pressure callback / OOM telemetry per miniapp.
- Diagnostic introspection API (list contexts, dump heap usage) for the dev menu.

## Pre-flight checklist

Before starting Phase 0:

- [ ] On a clean branch off `mentra-miniapp-sdk-2`.
- [ ] Repo builds clean with current Zipline code (so any new break is from our edit).
- [ ] An Android test device is paired and reachable via `adb`.
- [ ] Phone has a recent example miniapp install path (dev server reachable, QR code or URL handy).
- [ ] iOS device or sim ready for parity comparison in Phase 3.

Before merging:

- [ ] Phase 0 spike passes all three pass criteria.
- [ ] Phase 1 compiles clean (`./gradlew :crust:assembleDebug`).
- [ ] Phase 2 build succeeds without Zipline.
- [ ] Phase 3 smoke test passes — mic turns on in example miniapp.
- [ ] Phase 3.3 stress tests pass (reopen, dev reload, background, parity with iOS).
- [ ] No `outbound dropped (no sink)` warnings during normal operation.
- [ ] No diagnostic-only logs left in `JSCRuntime.kt`.
- [ ] AGENTS.md / module doc updated.
- [ ] Follow-up issue filed for interrupt handler.

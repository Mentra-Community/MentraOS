package com.mentra.bluetoothsdk.stt

import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor

/**
 * Owns the one on-device speech recognizer and loads it only while on-device transcription is
 * in demand.
 *
 * - Models load on [loader], never on the audio thread and never while [lock] is held.
 * - A finished load is swapped in under [lock]; the replaced recognizer is released after the
 *   swap, so the audio thread can no longer reach it by the time [release] runs. [release]
 *   must not free native memory on the calling thread (the recognizer releases on its own
 *   worker after the audio already queued to it).
 * - [current] and [isLoaded] are lock-free volatile reads, safe on the audio thread and on
 *   Expo's shared module queue.
 * - Demand ending releases the recognizer and discards any load still in flight.
 */
internal class OnDeviceRecognizerHost<R : Any>(
    private val selection: () -> Selection?,
    private val loadModel: (Selection) -> R,
    private val pathMatches: (R, String) -> Boolean,
    private val release: (R) -> Unit,
    private val loader: Executor,
    private val log: (String) -> Unit = {},
) {
    /** The model to load: its stored path and language. */
    data class Selection(val path: String, val language: String)

    private class Pending(val generation: Long, val selection: Selection) {
        val result = CompletableFuture<Unit>()
    }

    private val lock = Any()

    /** The loaded recognizer, or null. Read without locking. */
    @Volatile
    var current: R? = null
        private set

    // Guarded by lock.
    private var currentSelection: Selection? = null
    private var demand = false
    private var generation = 0L
    private var pending: Pending? = null

    /** Whether the loaded recognizer has [path]. Never blocks. */
    fun isLoaded(path: String): Boolean {
        val recognizer = current ?: return false
        return pathMatches(recognizer, path)
    }

    /**
     * On-device transcription demand changed. Gaining demand starts loading the selected model;
     * losing it releases the recognizer and invalidates an in-flight load.
     */
    fun setDemand(active: Boolean) {
        val selected = if (active) selection() else null
        var toRelease: R? = null
        var settle: Pending? = null
        synchronized(lock) {
            if (demand == active) return
            demand = active
            if (active) {
                if (selected != null && !(current != null && currentSelection == selected)) {
                    startLoadLocked(selected)
                }
            } else {
                generation++
                settle = pending
                pending = null
                toRelease = current
                current = null
                currentSelection = null
            }
        }
        // A restart waiting on a discarded load resolves: there is no demand any more.
        settle?.result?.complete(Unit)
        toRelease?.let {
            log("STT: on-device transcription demand ended; releasing the speech model")
            release(it)
        }
    }

    /**
     * Load the selected model if on-device transcription is in demand. The future completes
     * once that model is loaded (immediately when it already is, or when there is no demand)
     * and fails if loading fails.
     */
    fun restart(): CompletableFuture<Unit> {
        val selected = selection()
        synchronized(lock) {
            if (!demand) return CompletableFuture.completedFuture(Unit)
            if (selected == null) {
                return CompletableFuture<Unit>().apply {
                    completeExceptionally(IllegalStateException("No on-device speech model is selected"))
                }
            }
            if (current != null && currentSelection == selected) {
                return CompletableFuture.completedFuture(Unit)
            }
            pending?.let { if (it.selection == selected) return it.result }
            return startLoadLocked(selected).result
        }
    }

    private fun startLoadLocked(selected: Selection): Pending {
        generation++
        val next = Pending(generation, selected)
        // A superseded load's waiter gets the outcome of the load that replaced it.
        pending?.let { superseded ->
            next.result.whenComplete { _, error ->
                if (error == null) superseded.result.complete(Unit)
                else superseded.result.completeExceptionally(error)
            }
        }
        pending = next
        loader.execute { runLoad(next) }
        return next
    }

    private fun runLoad(job: Pending) {
        synchronized(lock) {
            if (job.generation != generation) return
        }
        log("STT: loading speech model ${job.selection.path}")
        val startedAt = System.currentTimeMillis()
        var loaded: R? = null
        var failure: Throwable? = null
        try {
            loaded = loadModel(job.selection)
        } catch (error: Exception) {
            failure = error
        } catch (error: LinkageError) {
            // Public SDK builds compile against sherpa-onnx without shipping it.
            failure = IllegalStateException("On-device transcription is not available in this build", error)
        }

        var toRelease: R? = null
        synchronized(lock) {
            if (job.generation != generation) {
                // Superseded or demand ended while loading: never swap a stale model in.
                toRelease = loaded
            } else {
                pending = null
                if (loaded != null) {
                    toRelease = current
                    current = loaded
                    currentSelection = job.selection
                } else if (currentSelection?.path != job.selection.path) {
                    // Don't keep running a model that is no longer the selected one.
                    toRelease = current
                    current = null
                    currentSelection = null
                }
            }
        }
        toRelease?.let(release)

        if (loaded != null) {
            log("STT: speech model loaded in ${System.currentTimeMillis() - startedAt}ms")
            job.result.complete(Unit)
        } else {
            val error = failure ?: IllegalStateException("Could not load the speech model")
            log("STT: speech model failed to load: ${error.message}")
            job.result.completeExceptionally(error)
        }
    }
}

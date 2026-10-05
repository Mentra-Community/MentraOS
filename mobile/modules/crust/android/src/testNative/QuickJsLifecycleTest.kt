package com.mentra.crust.jsc

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.Executors

/** Exercise actual JNI/Kotlin callbacks across independent runtime lifetimes. */
fun main() = runBlocking {
    var calls = 0
    val survivor = QuickJs.create(Dispatchers.Unconfined)
    survivor.function("hostCallback") { calls++; 42 }
    val other = QuickJs.create(Dispatchers.Unconfined)
    check(survivor.evaluate<Int>("hostCallback()") == 42)
    other.close()
    var failure: Throwable? = null
    try {
        withTimeout(1000) { check(survivor.evaluate<Int>("hostCallback()") == 42) }
    } catch (error: Throwable) {
        failure = error
    }
    check(failure == null) { "Closing another instance broke the survivor: $failure" }
    check(calls == 2)
    repeat(20) {
        val temporary = QuickJs.create(Dispatchers.Unconfined)
        temporary.close()
        check(survivor.evaluate<Int>("hostCallback()") == 42)
    }
    val workers = Executors.newFixedThreadPool(4)
    try {
        val jobs = (1..40).map {
            workers.submit {
                val temporary = QuickJs.create(Dispatchers.Unconfined)
                temporary.close()
            }
        }
        jobs.forEach { it.get() }
        check(survivor.evaluate<Int>("hostCallback()") == 42)
    } finally {
        workers.shutdownNow()
    }
    survivor.close()
    val fresh = QuickJs.create(Dispatchers.Unconfined)
    fresh.function("hostCallback") { 7 }
    check(fresh.evaluate<Int>("hostCallback()") == 7)
    fresh.close()
    val older = QuickJs.create(Dispatchers.Unconfined)
    val newer = QuickJs.create(Dispatchers.Unconfined)
    newer.function("hostCallback") { 9 }
    older.close()
    check(newer.evaluate<Int>("hostCallback()") == 9)
    newer.close()
    println("PASS: callbacks survive across both close orders, churn, and clean restart")
}

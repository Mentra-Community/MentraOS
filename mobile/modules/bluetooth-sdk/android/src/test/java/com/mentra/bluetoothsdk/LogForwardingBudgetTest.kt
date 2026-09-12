package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LogForwardingBudgetTest {
    private var nowMs = 0L
    private val budget = LogForwardingBudget(maxPerWindow = 3, windowMs = 1_000L, clock = { nowMs })

    @Test
    fun `forwards up to the budget within a window and withholds the rest`() {
        assertEquals(0, budget.admit())
        assertEquals(0, budget.admit())
        assertEquals(0, budget.admit())
        assertNull(budget.admit())
        assertNull(budget.admit())
    }

    @Test
    fun `the first line forwarded after a shortfall reports how many were withheld`() {
        repeat(5) { budget.admit() }

        nowMs = 1_000L
        assertEquals(2, budget.admit())
        assertEquals(0, budget.admit())
    }

    @Test
    fun `the budget renews every window`() {
        repeat(5) { budget.admit() }
        nowMs = 999L
        assertNull(budget.admit())

        nowMs = 1_000L
        assertEquals(3, budget.admit())
        assertEquals(0, budget.admit())
        assertEquals(0, budget.admit())
        assertNull(budget.admit())
    }

    @Test
    fun `withheld lines are reported even after a long silence`() {
        repeat(4) { budget.admit() }

        nowMs = 60_000L
        assertEquals(1, budget.admit())
    }
}

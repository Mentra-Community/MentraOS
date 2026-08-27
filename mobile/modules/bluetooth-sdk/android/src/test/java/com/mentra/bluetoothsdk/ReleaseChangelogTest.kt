package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Test

class ReleaseChangelogTest {
    @Test
    fun includesTargetNotesForTransitionWithinOneReleaseTrain() {
        val changelogs = ReleaseChangelogCatalog.select("3.1.0-dev.2", "3.1.0-beta.8")

        assertEquals(listOf("3.1.0"), changelogs.map { it.version })
    }
}

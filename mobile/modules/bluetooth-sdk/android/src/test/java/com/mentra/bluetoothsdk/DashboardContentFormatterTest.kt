package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Test

class DashboardContentFormatterTest {
    @Test
    fun emptyContentReturnsStatusHeaderOnly() {
        assertEquals(
            "\$TIME12$ \$DATE$ \$GBATT$ \$CONNECTION_STATUS$",
            DashboardContentFormatter.template(""),
        )
    }

    @Test
    fun nonEmptyContentIsAppendedExactlyOnNextLine() {
        assertEquals(
            "\$TIME12$ \$DATE$ \$GBATT$ \$CONNECTION_STATUS$\n  Next meeting\nRoom 2  ",
            DashboardContentFormatter.template("  Next meeting\nRoom 2  "),
        )
    }

    @Test
    fun leadingNewlineKeepsOptionalBlankRow() {
        assertEquals(
            "\$TIME12$ \$DATE$ \$GBATT$ \$CONNECTION_STATUS$\n\nNext meeting",
            DashboardContentFormatter.template("\nNext meeting"),
        )
    }
}

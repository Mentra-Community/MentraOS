package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.utils.G2Text
import org.junit.Assert.assertEquals
import org.junit.Test

class G2TextTest {
  @Test fun blankRowsAreEncodedOnlyAtTheDeviceBoundary() {
    assertEquals("hello\n\u200B\nworld\n\u200B", G2Text.containerContent("hello\n\nworld\n"))
    assertEquals(" ", G2Text.containerContent(""))
    assertEquals("hello\nworld", G2Text.containerContent("hello\nworld"))
  }
}

package com.mentra.bluetoothsdk.utils

/** Encode blank rows without triggering the EvenHub empty-line parser bug. */
internal object G2Text {
  fun containerContent(text: String): String =
    if (text.isEmpty()) " " else text.split("\n").joinToString("\n") { it.ifEmpty { "\u200B" } }
}

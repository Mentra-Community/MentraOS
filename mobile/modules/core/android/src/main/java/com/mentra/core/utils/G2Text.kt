package com.mentra.core.utils

import com.mentra.core.proto.TeleprompterContent
import com.mentra.core.proto.TeleprompterComplete
import com.mentra.core.proto.TeleprompterDisplaySettings
import com.mentra.core.proto.TeleprompterInit
import com.mentra.core.proto.TeleprompterMessage
import com.mentra.core.proto.TeleprompterStart
import com.mentra.core.proto.TeleprompterState
import com.google.protobuf.ByteString

class G2Text {
    companion object {
        private const val DISPLAY_WIDTH = 267          // Teleprompter display_width field
        private const val LINES_PER_PAGE = 10          // Lines per page
        private const val FONT_SIZE = 5                // Font size field
        private const val VIEWPORT_HEIGHT = 1294       // Visible area
        private const val LINE_HEIGHT = 230            // Line height
    }

    private var msgId = 100
    private val fontLoader = G1FontLoaderKt() // Reuse G1 font loader for glyph widths

    // Calculate text width in pixels (same approach as G1 but adapted for G2 display)
    fun calculateTextWidth(text: String): Int {
        var width = 0
        for (char in text) {
            val glyph = fontLoader.getGlyph(char)
            width += glyph.width + 1
        }
        return width
    }

    fun splitIntoLines(text: String, maxDisplayWidth: Int): List<String> {
        val processedText = text.replace("⬆", "^").replace("⟶", "-")
        val lines = mutableListOf<String>()

        if (processedText.isEmpty() || processedText == " ") {
            lines.add(processedText)
            return lines
        }

        val rawLines = processedText.split("\n")

        for (rawLine in rawLines) {
            if (rawLine.isEmpty()) {
                lines.add("")
                continue
            }

            val lineLength = rawLine.length
            var startIndex = 0

            while (startIndex < lineLength) {
                val endIndex = lineLength
                val lineWidth = calculateSubstringWidth(rawLine, startIndex, endIndex)

                if (lineWidth <= maxDisplayWidth) {
                    lines.add(rawLine.substring(startIndex))
                    break
                }

                var left = startIndex + 1
                var right = lineLength
                var bestSplitIndex = startIndex + 1

                while (left <= right) {
                    val mid = left + (right - left) / 2
                    val width = calculateSubstringWidth(rawLine, startIndex, mid)

                    if (width <= maxDisplayWidth) {
                        bestSplitIndex = mid
                        left = mid + 1
                    } else {
                        right = mid - 1
                    }
                }

                var splitIndex = bestSplitIndex
                var foundSpace = false
                for (i in bestSplitIndex downTo startIndex + 1) {
                    if (i > 0 && rawLine[i - 1] == ' ') {
                        splitIndex = i
                        foundSpace = true
                        break
                    }
                }

                if (!foundSpace && bestSplitIndex - startIndex > 2) {
                    splitIndex = bestSplitIndex
                }

                val line = rawLine.substring(startIndex, splitIndex).trim()
                lines.add(line)

                var newStartIndex = splitIndex
                while (newStartIndex < lineLength && rawLine[newStartIndex] == ' ') {
                    newStartIndex++
                }
                startIndex = newStartIndex
            }
        }

        return lines
    }

    private fun calculateSubstringWidth(text: String, start: Int, end: Int): Int {
        val substring = text.substring(start, end)
        return calculateTextWidth(substring)
    }

    /**
     * Build the teleprompter protobuf messages for displaying text on the G2.
     * Returns a list of serialized protobuf byte arrays to be sent via the transport layer.
     *
     * The sequence is:
     * 1. TeleprompterMessage type=1 (init) - set up display settings
     * 2. TeleprompterMessage type=3 (content) - send text pages
     * 3. TeleprompterMessage type=4 (complete) - signal end of content
     * 4. TeleprompterMessage type=1 (start) - trigger display
     */
    fun createTeleprompterMessages(text: String): List<ByteArray> {
        val lines = splitIntoLines(text, DISPLAY_WIDTH)
        val totalLines = lines.size
        val totalPages = Math.ceil(totalLines.toDouble() / LINES_PER_PAGE.toDouble()).toInt().coerceAtLeast(1)
        val contentHeight = totalLines * LINE_HEIGHT

        val messages = mutableListOf<ByteArray>()

        // 1. Init message
        val initMsg = TeleprompterMessage.newBuilder()
            .setType(1)
            .setMsgId(nextMsgId())
            .setInit(
                TeleprompterInit.newBuilder()
                    .setScriptIndex(0)
                    .setDisplay(
                        TeleprompterDisplaySettings.newBuilder()
                            .setField1(1)
                            .setField2(0)
                            .setField3(0)
                            .setDisplayWidth(DISPLAY_WIDTH)
                            .setContentHeight(contentHeight)
                            .setLineHeight(LINE_HEIGHT)
                            .setViewportHeight(VIEWPORT_HEIGHT)
                            .setFontSize(FONT_SIZE)
                            .setScrollMode(1)
                            .build()
                    )
                    .build()
            )
            .build()
        messages.add(initMsg.toByteArray())

        // 2. Content messages (one per page)
        for (page in 0 until totalPages) {
            val startLine = page * LINES_PER_PAGE
            val endLine = Math.min(startLine + LINES_PER_PAGE, totalLines)
            val pageLines = lines.subList(startLine, endLine)
            val pageText = pageLines.joinToString("\n")

            val contentMsg = TeleprompterMessage.newBuilder()
                .setType(3)
                .setMsgId(nextMsgId())
                .setContent(
                    TeleprompterContent.newBuilder()
                        .setPageNumber(page)
                        .setLineCount(LINES_PER_PAGE)
                        .setText(ByteString.copyFromUtf8(pageText))
                        .build()
                )
                .build()
            messages.add(contentMsg.toByteArray())
        }

        // 3. Complete message
        val completeMsg = TeleprompterMessage.newBuilder()
            .setType(4)
            .setMsgId(nextMsgId())
            .setComplete(
                TeleprompterComplete.newBuilder()
                    .setStartPage(0)
                    .setTotalPages(totalPages)
                    .setTotalLines(totalLines)
                    .build()
            )
            .build()
        messages.add(completeMsg.toByteArray())

        // 4. Start message (trigger display)
        val startMsg = TeleprompterMessage.newBuilder()
            .setType(1)
            .setMsgId(nextMsgId())
            .setInit(
                TeleprompterInit.newBuilder()
                    .setScriptIndex(0)
                    .setDisplay(
                        TeleprompterDisplaySettings.newBuilder()
                            .setField1(1)
                            .setField2(0)
                            .setField3(0)
                            .setDisplayWidth(DISPLAY_WIDTH)
                            .setContentHeight(contentHeight)
                            .setLineHeight(LINE_HEIGHT)
                            .setViewportHeight(VIEWPORT_HEIGHT)
                            .setFontSize(FONT_SIZE)
                            .setScrollMode(1)
                            .build()
                    )
                    .build()
            )
            .build()
        messages.add(startMsg.toByteArray())

        return messages
    }

    /**
     * Create double text wall (split screen) for G2.
     * Lays out two columns of text.
     */
    fun createDoubleTextWallMessages(textTop: String, textBottom: String): List<ByteArray> {
        val leftColumnWidth = (DISPLAY_WIDTH * 0.50).toInt()
        val rightColumnStart = (DISPLAY_WIDTH * 0.55).toInt()
        val rightColumnWidth = DISPLAY_WIDTH - rightColumnStart

        val lines1 = splitIntoLines(textTop, leftColumnWidth).toMutableList()
        val lines2 = splitIntoLines(textBottom, rightColumnWidth).toMutableList()

        while (lines1.size < LINES_PER_PAGE) lines1.add("")
        while (lines2.size < LINES_PER_PAGE) lines2.add("")

        val spaceWidth = calculateTextWidth(" ").coerceAtLeast(1)

        val combinedLines = mutableListOf<String>()
        for (i in 0 until LINES_PER_PAGE) {
            val left = lines1.getOrElse(i) { "" }
            val right = lines2.getOrElse(i) { "" }
            val leftPixelWidth = calculateTextWidth(left)
            val spaces = calculateSpacesForAlignment(leftPixelWidth, rightColumnStart, spaceWidth)
            combinedLines.add(left + " ".repeat(spaces) + right)
        }

        val combinedText = combinedLines.joinToString("\n")
        return createTeleprompterMessages(combinedText)
    }

    private fun calculateSpacesForAlignment(currentWidth: Int, targetPosition: Int, spaceWidth: Int): Int {
        val pixelsNeeded = targetPosition - currentWidth
        if (pixelsNeeded <= 0) return 1
        return Math.ceil(pixelsNeeded.toDouble() / spaceWidth.toDouble()).toInt().coerceAtMost(100)
    }

    private fun nextMsgId(): Int {
        msgId = (msgId + 1) % 65536
        return msgId
    }
}

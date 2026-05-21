package com.mentra.core.utils

class G1Text {
    companion object {
        // Constants for text wall display
        private const val TEXT_COMMAND: Byte = 0x4E // Text command
        private const val DISPLAY_WIDTH = 488
        private const val DISPLAY_USE_WIDTH = 488 // How much of the display to use
        private const val FONT_MULTIPLIER: Float = 1 / 50.0f
        private const val OLD_FONT_SIZE = 21 // Font size
        private const val FONT_DIVIDER: Float = 2.0f
        private const val LINES_PER_SCREEN = 5 // Lines per screen
        private const val MAX_CHUNK_SIZE = 176 // Maximum chunk size for BLE packets
    }

    private var textSeqNum = 0 // Sequence number for text packets
    private val fontLoader = G1FontLoaderKt()

    // Calculate text width in pixels
    fun calculateTextWidth(text: String): Int {
        var width = 0
        for (char in text) {
            val glyph = fontLoader.getGlyph(char)
            width += glyph.width + 1 // Add 1 pixel per character for spacing
        }
        return width * 2
    }

    private fun calculateSubstringWidth(text: String, start: Int, end: Int): Int {
        val substring = text.substring(start, end)
        return calculateTextWidth(substring)
    }

    private fun calculateSpacesForAlignment(currentWidth: Int, targetPosition: Int, spaceWidth: Int): Int {
        // Calculate space needed in pixels
        val pixelsNeeded = targetPosition - currentWidth

        // Calculate spaces needed (with minimum of 1 space for separation)
        if (pixelsNeeded <= 0) {
            return 1 // Ensure at least one space between columns
        }

        // Calculate the exact number of spaces needed
        val spaces = Math.ceil(pixelsNeeded.toDouble() / spaceWidth.toDouble()).toInt()

        // Cap at a reasonable maximum
        return Math.min(spaces, 100)
    }

    fun splitIntoLines(text: String, maxDisplayWidth: Int): List<String> {
        // Replace specific symbols
        val processedText = text.replace("⬆", "^").replace("⟶", "-")

        val lines = mutableListOf<String>()

        // Handle empty or single space case
        if (processedText.isEmpty() || processedText == " ") {
            lines.add(processedText)
            return lines
        }

        // Split by newlines first
        val rawLines = processedText.split("\n")

        for (rawLine in rawLines) {
            // Add empty lines for newlines
            if (rawLine.isEmpty()) {
                lines.add("")
                continue
            }

            val lineLength = rawLine.length
            var startIndex = 0

            while (startIndex < lineLength) {
                // Get maximum possible end index
                val endIndex = lineLength

                // Calculate width of the entire remaining text
                val lineWidth = calculateSubstringWidth(rawLine, startIndex, endIndex)

                // If entire line fits, add it and move to next line
                if (lineWidth <= maxDisplayWidth) {
                    lines.add(rawLine.substring(startIndex))
                    break
                }

                // Binary search to find the maximum number of characters that fit
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

                // Now find a good place to break (preferably at a space)
                var splitIndex = bestSplitIndex

                // Look for a space to break at
                var foundSpace = false
                for (i in bestSplitIndex downTo startIndex + 1) {
                    if (i > 0 && rawLine[i - 1] == ' ') {
                        splitIndex = i
                        foundSpace = true
                        break
                    }
                }

                // If we couldn't find a space in a reasonable range, use the calculated split point
                if (!foundSpace && bestSplitIndex - startIndex > 2) {
                    splitIndex = bestSplitIndex
                }

                // Add the line
                val line = rawLine.substring(startIndex, splitIndex).trim()
                lines.add(line)

                // Skip any spaces at the beginning of the next line
                var newStartIndex = splitIndex
                while (newStartIndex < lineLength && rawLine[newStartIndex] == ' ') {
                    newStartIndex++
                }

                startIndex = newStartIndex
            }
        }

        return lines
    }

    fun createTextWallChunks(text: String): List<ByteArray> {
        val margin = 5

        // Get width of single space character
        val spaceWidth = calculateTextWidth(" ")

        // Calculate effective display width after accounting for left and right margins in spaces
        val marginWidth = margin * spaceWidth // Width of left margin in pixels
        val effectiveWidth = DISPLAY_WIDTH - (2 * marginWidth) // Subtract left and right margins

        // Split text into lines based on effective display width
        val lines = splitIntoLines(text, effectiveWidth)

        // Calculate total pages (hard set to 1 - 1PAGECHANGE)
        val totalPages = 1

        val allChunks = mutableListOf<ByteArray>()

        // Process each page
        for (page in 0 until totalPages) {
            // Get lines for current page
            val startLine = page * LINES_PER_SCREEN
            val endLine = Math.min(startLine + LINES_PER_SCREEN, lines.size)
            val pageLines = lines.subList(startLine, endLine)

            // Combine lines for this page with proper indentation
            val pageText = StringBuilder()

            for (line in pageLines) {
                // Add the exact number of spaces for indentation
                val indentation = " ".repeat(margin)
                pageText.append("$indentation$line\n")
            }

            val textBytes = pageText.toString().toByteArray(Charsets.UTF_8)
            val totalChunks = Math.ceil(textBytes.size.toDouble() / MAX_CHUNK_SIZE.toDouble()).toInt()

            // Create chunks for this page
            for (i in 0 until totalChunks) {
                val start = i * MAX_CHUNK_SIZE
                val end = Math.min(start + MAX_CHUNK_SIZE, textBytes.size)
                val payloadChunk = textBytes.copyOfRange(start, end)

                // Create header with protocol specifications
                val screenStatus: Byte = 0x71 // New content (0x01) + Text Show (0x70)
                val header = byteArrayOf(
                    TEXT_COMMAND, // Command type
                    textSeqNum.toByte(), // Sequence number
                    totalChunks.toByte(), // Total packages
                    i.toByte(), // Current package number
                    screenStatus, // Screen status
                    0x00, // new_char_pos0 (high)
                    0x00, // new_char_pos1 (low)
                    page.toByte(), // Current page number
                    totalPages.toByte() // Max page number
                )

                // Combine header and payload
                val chunk = header + payloadChunk

                allChunks.add(chunk)
            }

            // Increment sequence number for next page
            textSeqNum = (textSeqNum + 1) % 256
            break // Hard set to 1 - 1PAGECHANGE
        }

        return allChunks
    }

    /**
     * Creates BLE chunks for pre-composed double text wall.
     *
     * NOTE: DisplayProcessor now composes double_text_wall into a single text_wall
     * with pixel-precise column alignment using ColumnComposer. This method may
     * not be called anymore for new flows, but is kept for backwards compatibility.
     *
     * Column composition is handled by DisplayProcessor in React Native.
     * This method is a "dumb pipe" - it just combines and chunks the text.
     *
     * @param textTop Pre-composed left/top column text
     * @param textBottom Pre-composed right/bottom column text
     * @return List of BLE chunks ready for transmission
     */
    fun createDoubleTextWallChunks(textTop: String, textBottom: String): List<ByteArray> {
        // Text is already composed by DisplayProcessor's ColumnComposer
        // Just combine and chunk for transmission - no custom wrapping logic needed
        val combinedText = "$textTop\n$textBottom"
        return chunkTextForTransmission(combinedText)
    }

    private fun chunkTextForTransmission(text: String): List<ByteArray> {
        val textBytes = text.toByteArray(Charsets.UTF_8)
        val totalChunks = Math.ceil(textBytes.size.toDouble() / MAX_CHUNK_SIZE.toDouble()).toInt()

        val allChunks = mutableListOf<ByteArray>()
        for (i in 0 until totalChunks) {
            val start = i * MAX_CHUNK_SIZE
            val end = Math.min(start + MAX_CHUNK_SIZE, textBytes.size)
            val payloadChunk = textBytes.copyOfRange(start, end)

            // Create header with protocol specifications
            val screenStatus: Byte = 0x71 // New content (0x01) + Text Show (0x70)
            val header = byteArrayOf(
                TEXT_COMMAND, // Command type
                textSeqNum.toByte(), // Sequence number
                totalChunks.toByte(), // Total packages
                i.toByte(), // Current package number
                screenStatus, // Screen status
                0x00, // new_char_pos0 (high)
                0x00, // new_char_pos1 (low)
                0x00, // Current page number (always 0 for now)
                0x01 // Max page number (always 1)
            )

            // Combine header and payload
            val chunk = header + payloadChunk

            allChunks.add(chunk)
        }

        // Increment sequence number for next page
        textSeqNum = (textSeqNum + 1) % 256

        return allChunks
    }
}

// Font loader with hardcoded font data
class G1FontLoaderKt {
    private val fontMap: MutableMap<Char, FontGlyph> = mutableMapOf()

    init {
        loadHardcodedFontData()
    }

    private fun loadHardcodedFontData() {
        // Hardcoded font data based on the Swift implementation
        val hardcodedGlyphs = listOf(
            GlyphData(32, ' ', 2, 26),
            GlyphData(33, '!', 1, 26),
            GlyphData(34, '"', 2, 26),
            GlyphData(35, '#', 6, 26),
            GlyphData(36, '$', 5, 26),
            GlyphData(37, '%', 6, 26),
            GlyphData(38, '&', 7, 26),
            GlyphData(39, '\'', 1, 26),
            GlyphData(40, '(', 2, 26),
            GlyphData(41, ')', 2, 26),
            GlyphData(42, '*', 3, 26),
            GlyphData(43, '+', 4, 26),
            GlyphData(44, ',', 1, 26),
            GlyphData(45, '-', 4, 26),
            GlyphData(46, '.', 1, 26),
            GlyphData(47, '/', 3, 26),
            GlyphData(48, '0', 5, 26),
            GlyphData(49, '1', 3, 26),
            GlyphData(50, '2', 5, 26),
            GlyphData(51, '3', 5, 26),
            GlyphData(52, '4', 5, 26),
            GlyphData(53, '5', 5, 26),
            GlyphData(54, '6', 5, 26),
            GlyphData(55, '7', 5, 26),
            GlyphData(56, '8', 5, 26),
            GlyphData(57, '9', 5, 26),
            GlyphData(58, ':', 1, 26),
            GlyphData(59, ';', 1, 26),
            GlyphData(60, '<', 4, 26),
            GlyphData(61, '=', 4, 26),
            GlyphData(62, '>', 4, 26),
            GlyphData(63, '?', 5, 26),
            GlyphData(64, '@', 7, 26),
            GlyphData(65, 'A', 6, 26),
            GlyphData(66, 'B', 5, 26),
            GlyphData(67, 'C', 5, 26),
            GlyphData(68, 'D', 5, 26),
            GlyphData(69, 'E', 4, 26),
            GlyphData(70, 'F', 4, 26),
            GlyphData(71, 'G', 5, 26),
            GlyphData(72, 'H', 5, 26),
            GlyphData(73, 'I', 2, 26),
            GlyphData(74, 'J', 3, 26),
            GlyphData(75, 'K', 5, 26),
            GlyphData(76, 'L', 4, 26),
            GlyphData(77, 'M', 7, 26),
            GlyphData(78, 'N', 5, 26),
            GlyphData(79, 'O', 5, 26),
            GlyphData(80, 'P', 5, 26),
            GlyphData(81, 'Q', 5, 26),
            GlyphData(82, 'R', 5, 26),
            GlyphData(83, 'S', 5, 26),
            GlyphData(84, 'T', 5, 26),
            GlyphData(85, 'U', 5, 26),
            GlyphData(86, 'V', 6, 26),
            GlyphData(87, 'W', 7, 26),
            GlyphData(88, 'X', 6, 26),
            GlyphData(89, 'Y', 6, 26),
            GlyphData(90, 'Z', 5, 26),
            GlyphData(91, '[', 2, 26),
            GlyphData(92, '\\', 3, 26),
            GlyphData(93, ']', 2, 26),
            GlyphData(94, '^', 4, 26),
            GlyphData(95, '_', 3, 26),
            GlyphData(96, '`', 2, 26),
            GlyphData(97, 'a', 5, 26),
            GlyphData(98, 'b', 4, 26),
            GlyphData(99, 'c', 4, 26),
            GlyphData(100, 'd', 4, 26),
            GlyphData(101, 'e', 4, 26),
            GlyphData(102, 'f', 4, 26),
            GlyphData(103, 'g', 4, 26),
            GlyphData(104, 'h', 4, 26),
            GlyphData(105, 'i', 1, 26),
            GlyphData(106, 'j', 2, 26),
            GlyphData(107, 'k', 4, 26),
            GlyphData(108, 'l', 1, 26),
            GlyphData(109, 'm', 7, 26),
            GlyphData(110, 'n', 4, 26),
            GlyphData(111, 'o', 4, 26),
            GlyphData(112, 'p', 4, 26),
            GlyphData(113, 'q', 4, 26),
            GlyphData(114, 'r', 3, 26),
            GlyphData(115, 's', 4, 26),
            GlyphData(116, 't', 3, 26),
            GlyphData(117, 'u', 5, 26),
            GlyphData(118, 'v', 5, 26),
            GlyphData(119, 'w', 7, 26),
            GlyphData(120, 'x', 5, 26),
            GlyphData(121, 'y', 5, 26),
            GlyphData(122, 'z', 4, 26),
            GlyphData(123, '{', 3, 26),
            GlyphData(124, '|', 1, 26),
            GlyphData(125, '}', 3, 26),
            GlyphData(126, '~', 7, 26),
            GlyphData(192, 'À', 6, 26),
            GlyphData(194, 'Â', 6, 26),
            GlyphData(199, 'Ç', 5, 26),
            GlyphData(200, 'È', 4, 26),
            GlyphData(201, 'É', 4, 26),
            GlyphData(202, 'Ê', 4, 26),
            GlyphData(203, 'Ë', 4, 26),
            GlyphData(206, 'Î', 3, 26),
            GlyphData(207, 'Ï', 3, 26),
            GlyphData(212, 'Ô', 5, 26),
            GlyphData(217, 'Ù', 5, 26),
            GlyphData(219, 'Û', 5, 26),
            GlyphData(220, 'Ü', 5, 26),
            GlyphData(224, 'à', 5, 26),
            GlyphData(231, 'ç', 4, 26),
            GlyphData(232, 'è', 4, 26),
            GlyphData(233, 'é', 4, 26),
            GlyphData(234, 'ê', 4, 26),
            GlyphData(235, 'ë', 4, 26),
            GlyphData(238, 'î', 3, 26),
            GlyphData(239, 'ï', 3, 26),
            GlyphData(244, 'ô', 4, 26),
            GlyphData(249, 'ù', 5, 26),
            GlyphData(251, 'û', 5, 26),
            GlyphData(252, 'ü', 5, 26),
            GlyphData(255, 'ÿ', 5, 26),
            GlyphData(376, 'Ÿ', 6, 26),
            GlyphData(196, 'Ä', 6, 26),
            GlyphData(228, 'ä', 5, 26),
            GlyphData(214, 'Ö', 5, 26),
            GlyphData(246, 'ö', 4, 26),
            GlyphData(223, 'ß', 4, 26),
            GlyphData(7838, 'ẞ', 5, 26),
            GlyphData(226, 'â', 5, 26),
            GlyphData(193, 'Á', 6, 26),
            GlyphData(225, 'á', 5, 26),
            GlyphData(205, 'Í', 2, 26),
            GlyphData(237, 'í', 2, 26),
            GlyphData(209, 'Ñ', 5, 26),
            GlyphData(241, 'ñ', 4, 26),
            GlyphData(250, 'ú', 5, 26),
            GlyphData(211, 'Ó', 5, 26),
            GlyphData(243, 'ó', 4, 26),
            GlyphData(218, 'Ú', 5, 26)
        )

        // Map characters directly to FontGlyph objects
        for (glyph in hardcodedGlyphs) {
            fontMap[glyph.char] = FontGlyph(glyph.width, glyph.height)
        }

        println("Hardcoded font data loaded successfully! ${fontMap.size} glyphs mapped.")
    }

    fun getGlyph(character: Char): FontGlyph {
        return fontMap[character] ?: FontGlyph(6, 26) // Default width=6, height=26
    }

    data class FontGlyph(val width: Int, val height: Int)

    private data class GlyphData(val codePoint: Int, val char: Char, val width: Int, val height: Int)
}

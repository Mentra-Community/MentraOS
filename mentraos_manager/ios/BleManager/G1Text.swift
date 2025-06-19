//
//  G1Text.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/5/25.
//


import Foundation
import CoreGraphics

class G1Text {
    // Constants for text wall display
    private static let TEXT_COMMAND: UInt8 = 0x4E  // Text command
    private static let DISPLAY_WIDTH = 488
    private static let DISPLAY_USE_WIDTH = 488  // How much of the display to use
    private static let FONT_MULTIPLIER: Float = 1/50.0
    private static let OLD_FONT_SIZE = 21      // Font size
    private static let FONT_DIVIDER: Float = 2.0
    private static let LINES_PER_SCREEN = 5 // Lines per screen
    private static let MAX_CHUNK_SIZE = 176 // Maximum chunk size for BLE packets
    
    private var textSeqNum = 0 // Sequence number for text packets
    private var fontLoader = G1FontLoader()
    
    init() {
    }
    
    // MARK: - Text Wall Methods
    
//    func displayTextWall(_ text: String) {
//        let chunks = createTextWallChunks(text)
//        sendChunks(chunks)
//    }
    
//    func displayDoubleTextWall(textTop: String, textBottom: String) {
//        let chunks = createDoubleTextWallChunks(textTop: textTop, textBottom: textBottom)
//        sendChunks(chunks)
//    }
    
    func createTextWallChunks(_ text: String) -> [[UInt8]] {
        let margin = 5
        
        // Get width of single space character
        let spaceWidth = calculateTextWidth(" ")
        
        // Calculate effective display width after accounting for left and right margins in spaces
        let marginWidth = margin * spaceWidth // Width of left margin in pixels
        let effectiveWidth = G1Text.DISPLAY_WIDTH - (2 * marginWidth) // Subtract left and right margins
        
        // Split text into lines based on effective display width
        let lines = splitIntoLines(text, maxDisplayWidth: effectiveWidth)
        
        // Calculate total pages (hard set to 1 - 1PAGECHANGE)
        let totalPages = 1
        
        var allChunks = [[UInt8]]()
        
        // Process each page
        for page in 0..<totalPages {
            // Get lines for current page
            let startLine = page * G1Text.LINES_PER_SCREEN
            let endLine = min(startLine + G1Text.LINES_PER_SCREEN, lines.count)
            let pageLines = Array(lines[startLine..<endLine])
            
            // Combine lines for this page with proper indentation
            var pageText = ""
            
            for line in pageLines {
                // Add the exact number of spaces for indentation
                let indentation = String(repeating: " ", count: margin)
                pageText.append("\(indentation)\(line)\n")
            }
            
            guard let textData = pageText.data(using: .utf8) else { continue }
            let textBytes = [UInt8](textData)
            let totalChunks = Int(ceil(Double(textBytes.count) / Double(G1Text.MAX_CHUNK_SIZE)))
            
            // Create chunks for this page
            for i in 0..<totalChunks {
                let start = i * G1Text.MAX_CHUNK_SIZE
                let end = min(start + G1Text.MAX_CHUNK_SIZE, textBytes.count)
                let payloadChunk = Array(textBytes[start..<end])
                
                // Create header with protocol specifications
                let screenStatus: UInt8 = 0x71 // New content (0x01) + Text Show (0x70)
                let header: [UInt8] = [
                    G1Text.TEXT_COMMAND,    // Command type
                    UInt8(textSeqNum),      // Sequence number
                    UInt8(totalChunks),     // Total packages
                    UInt8(i),               // Current package number
                    screenStatus,           // Screen status
                    0x00,                   // new_char_pos0 (high)
                    0x00,                   // new_char_pos1 (low)
                    UInt8(page),            // Current page number
                    UInt8(totalPages)       // Max page number
                ]
                
                // Combine header and payload
                var chunk = header
                chunk.append(contentsOf: payloadChunk)
                
                allChunks.append(chunk)
            }
            
            // Increment sequence number for next page
            textSeqNum = (textSeqNum + 1) % 256
            break // Hard set to 1 - 1PAGECHANGE
        }
        
        return allChunks
    }
    
    public func createDoubleTextWallChunks(textTop: String, textBottom: String) -> [[UInt8]] {
//        print("Creating double text wall chunks... \(textTop), \(textBottom)")
        // Define column widths and positions
        let LEFT_COLUMN_WIDTH = Int(Double(G1Text.DISPLAY_WIDTH) * 0.5)  // 50% of display for left column
        let RIGHT_COLUMN_START = Int(Double(G1Text.DISPLAY_WIDTH) * 0.55)  // Right column starts at 60%
        
        // Split texts into lines with specific width constraints
        var lines1 = splitIntoLines(textTop, maxDisplayWidth: LEFT_COLUMN_WIDTH)
        var lines2 = splitIntoLines(textBottom, maxDisplayWidth: G1Text.DISPLAY_WIDTH - RIGHT_COLUMN_START)
        
        // Ensure we have exactly LINES_PER_SCREEN lines (typically 5)
        while lines1.count < G1Text.LINES_PER_SCREEN { lines1.append("") }
        while lines2.count < G1Text.LINES_PER_SCREEN { lines2.append("") }
        
        lines1 = Array(lines1.prefix(G1Text.LINES_PER_SCREEN))
        lines2 = Array(lines2.prefix(G1Text.LINES_PER_SCREEN))

//        print("Lines1: \(lines1)")
//        print("Lines2: \(lines2)")
        
        // Get precise space width
        let spaceWidth = calculateTextWidth(" ")
        
        // Construct the text output by merging the lines with precise positioning
        var pageText = ""
        for i in 0..<G1Text.LINES_PER_SCREEN {
            let leftText = lines1[i].replacingOccurrences(of: "\u{2002}", with: "") // Drop enspaces
            let rightText = lines2[i].replacingOccurrences(of: "\u{2002}", with: "")
            
            // Calculate width of left text in pixels
            let leftTextWidth = calculateTextWidth(leftText)
            
            // Calculate exactly how many spaces are needed to position the right column correctly
            let spacesNeeded = calculateSpacesForAlignment(
                currentWidth: leftTextWidth,
                targetPosition: RIGHT_COLUMN_START,
                spaceWidth: spaceWidth
            )
            
            // Log detailed alignment info for debugging
//            print("Line \(i): Left='\(leftText)' (width=\(leftTextWidth)px) | Spaces=\(spacesNeeded) | Right='\(rightText)'")
            
            // Construct the full line with precise alignment
            pageText.append(leftText)
            pageText.append(String(repeating: " ", count: spacesNeeded))
            pageText.append(rightText)
            pageText.append("\n")
        }

//        print("Page Text: \(pageText)")
        
        // Convert to bytes and chunk for transmission
        return chunkTextForTransmission(pageText)
    }
    
    private func chunkTextForTransmission(_ text: String) -> [[UInt8]] {
        guard let textData = text.data(using: .utf8) else { return [] }
        let textBytes = [UInt8](textData)
        let totalChunks = Int(ceil(Double(textBytes.count) / Double(G1Text.MAX_CHUNK_SIZE)))
        
        var allChunks = [[UInt8]]()
        for i in 0..<totalChunks {
            let start = i * G1Text.MAX_CHUNK_SIZE
            let end = min(start + G1Text.MAX_CHUNK_SIZE, textBytes.count)
            let payloadChunk = Array(textBytes[start..<end])
            
            // Create header with protocol specifications
            let screenStatus: UInt8 = 0x71 // New content (0x01) + Text Show (0x70)
            let header: [UInt8] = [
                G1Text.TEXT_COMMAND,    // Command type
                UInt8(textSeqNum),      // Sequence number
                UInt8(totalChunks),     // Total packages
                UInt8(i),               // Current package number
                screenStatus,           // Screen status
                0x00,                   // new_char_pos0 (high)
                0x00,                   // new_char_pos1 (low)
                0x00,                   // Current page number (always 0 for now)
                0x01                    // Max page number (always 1)
            ]
            
            // Combine header and payload
            var chunk = header
            chunk.append(contentsOf: payloadChunk)
            
            allChunks.append(chunk)
        }
        
        // Increment sequence number for next page
        textSeqNum = (textSeqNum + 1) % 256
        
        return allChunks
    }
    
    private func calculateTextWidth(_ text: String) -> Int {
        var width = 0
        for char in text {
            let glyph = fontLoader.getGlyph(char)
            width += glyph.width + 1 // Add 1 pixel per character for spacing
        }
        return width * 2
    }
    
    private func calculateSubstringWidth(_ text: String, start: Int, end: Int) -> Int {
        let startIndex = text.index(text.startIndex, offsetBy: start)
        let endIndex = text.index(text.startIndex, offsetBy: end)
        let substring = text[startIndex..<endIndex]
        return calculateTextWidth(String(substring))
    }
    
    private func calculateSpacesForAlignment(currentWidth: Int, targetPosition: Int, spaceWidth: Int) -> Int {
        // Calculate space needed in pixels
        let pixelsNeeded = targetPosition - currentWidth
        
        // Calculate spaces needed (with minimum of 1 space for separation)
        if pixelsNeeded <= 0 {
            return 1 // Ensure at least one space between columns
        }
        
        // Calculate the exact number of spaces needed
        let spaces = Int(ceil(Double(pixelsNeeded) / Double(spaceWidth)))
        
        // Cap at a reasonable maximum
        return min(spaces, 100)
    }
    
    private func splitIntoLines(_ text: String, maxDisplayWidth: Int) -> [String] {
        // Replace specific symbols
        let processedText = text.replacingOccurrences(of: "⬆", with: "^").replacingOccurrences(of: "⟶", with: "-")
        
        var lines = [String]()
        
        // Handle empty or single space case
        if processedText.isEmpty || processedText == " " {
            lines.append(processedText)
            return lines
        }
        
        // Split by newlines first
        let rawLines = processedText.components(separatedBy: "\n")
        
//        print("Splitting text into lines...\(rawLines)")
        
        for rawLine in rawLines {
            // Add empty lines for newlines
            if rawLine.isEmpty {
                lines.append("")
                continue
            }
            
            let lineLength = rawLine.count
            var startIndex = 0
            
            while startIndex < lineLength {
                // Get maximum possible end index
                let endIndex = lineLength
                
                // Calculate width of the entire remaining text
                let lineWidth = calculateSubstringWidth(rawLine, start: startIndex, end: endIndex)
                
//                print("Line length: \(rawLine)")
//                print("Calculating line width: \(lineWidth)")
                
                // If entire line fits, add it and move to next line
                if lineWidth <= maxDisplayWidth {
                    let startIndexChar = rawLine.index(rawLine.startIndex, offsetBy: startIndex)
                    lines.append(String(rawLine[startIndexChar...]))
                    break
                }
                
                // Binary search to find the maximum number of characters that fit
                var left = startIndex + 1
                var right = lineLength
                var bestSplitIndex = startIndex + 1
                
                while left <= right {
                    let mid = left + (right - left) / 2
                    let width = calculateSubstringWidth(rawLine, start: startIndex, end: mid)
                    
                    if width <= maxDisplayWidth {
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
                for i in (startIndex+1...bestSplitIndex).reversed() {
                    if i > 0 && rawLine[rawLine.index(rawLine.startIndex, offsetBy: i-1)] == " " {
                        splitIndex = i
                        foundSpace = true
                        break
                    }
                }
                
                // If we couldn't find a space in a reasonable range, use the calculated split point
                if !foundSpace && bestSplitIndex - startIndex > 2 {
                    splitIndex = bestSplitIndex
                }
                
                // Add the line
                let startChar = rawLine.index(rawLine.startIndex, offsetBy: startIndex)
                let endChar = rawLine.index(rawLine.startIndex, offsetBy: splitIndex)
                let line = String(rawLine[startChar..<endChar]).trimmingCharacters(in: .whitespaces)
                lines.append(line)
                
                // Skip any spaces at the beginning of the next line
                while splitIndex < lineLength && rawLine[rawLine.index(rawLine.startIndex, offsetBy: splitIndex)] == " " {
                    splitIndex += 1
                }
                
                startIndex = splitIndex
            }
        }
        
        return lines
    }
}

class G1FontLoader {
    private var fontMap: [Character: FontGlyph] = [:]
    
    init() {
        // Initialize with hardcoded font data instead of loading from file
        loadHardcodedFontData()
    }
    
    private func loadHardcodedFontData() {
        // Hardcoded font data based on the JSON snippet
        let hardcodedGlyphs: [[String: Any]] = [
          [
            "code_point": 32,
            "char": " ",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 33,
            "char": "!",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 34,
            "char": "\"",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 35,
            "char": "#",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 36,
            "char": "$",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 37,
            "char": "%",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 38,
            "char": "&",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 39,
            "char": "'",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 40,
            "char": "(",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 41,
            "char": ")",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 42,
            "char": "*",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 43,
            "char": "+",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 44,
            "char": ",",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 45,
            "char": "-",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 46,
            "char": ".",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 47,
            "char": "/",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 48,
            "char": "0",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 49,
            "char": "1",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 50,
            "char": "2",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 51,
            "char": "3",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 52,
            "char": "4",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 53,
            "char": "5",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 54,
            "char": "6",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 55,
            "char": "7",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 56,
            "char": "8",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 57,
            "char": "9",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 58,
            "char": ":",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 59,
            "char": ";",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 60,
            "char": "<",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 61,
            "char": "=",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 62,
            "char": ">",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 63,
            "char": "?",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 64,
            "char": "@",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 65,
            "char": "A",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 66,
            "char": "B",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 67,
            "char": "C",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 68,
            "char": "D",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 69,
            "char": "E",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 70,
            "char": "F",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 71,
            "char": "G",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 72,
            "char": "H",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 73,
            "char": "I",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 74,
            "char": "J",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 75,
            "char": "K",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 76,
            "char": "L",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 77,
            "char": "M",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 78,
            "char": "N",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 79,
            "char": "O",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 80,
            "char": "P",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 81,
            "char": "Q",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 82,
            "char": "R",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 83,
            "char": "S",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 84,
            "char": "T",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 85,
            "char": "U",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 86,
            "char": "V",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 87,
            "char": "W",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 88,
            "char": "X",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 89,
            "char": "Y",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 90,
            "char": "Z",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 91,
            "char": "[",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 92,
            "char": "\\",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 93,
            "char": "]",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 94,
            "char": "^",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 95,
            "char": "_",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 96,
            "char": "`",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 97,
            "char": "a",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 98,
            "char": "b",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 99,
            "char": "c",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 100,
            "char": "d",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 101,
            "char": "e",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 102,
            "char": "f",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 103,
            "char": "g",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 104,
            "char": "h",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 105,
            "char": "i",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 106,
            "char": "j",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 107,
            "char": "k",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 108,
            "char": "l",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 109,
            "char": "m",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 110,
            "char": "n",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 111,
            "char": "o",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 112,
            "char": "p",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 113,
            "char": "q",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 114,
            "char": "r",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 115,
            "char": "s",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 116,
            "char": "t",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 117,
            "char": "u",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 118,
            "char": "v",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 119,
            "char": "w",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 120,
            "char": "x",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 121,
            "char": "y",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 122,
            "char": "z",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 123,
            "char": "{",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 124,
            "char": "|",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 125,
            "char": "}",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 126,
            "char": "~",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 192,
            "char": "À",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 194,
            "char": "Â",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 199,
            "char": "Ç",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 200,
            "char": "È",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 201,
            "char": "É",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 202,
            "char": "Ê",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 203,
            "char": "Ë",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 206,
            "char": "Î",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 207,
            "char": "Ï",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 212,
            "char": "Ô",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 217,
            "char": "Ù",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 219,
            "char": "Û",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 220,
            "char": "Ü",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 224,
            "char": "à",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 231,
            "char": "ç",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 232,
            "char": "è",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 233,
            "char": "é",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 234,
            "char": "ê",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 235,
            "char": "ë",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 238,
            "char": "î",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 239,
            "char": "ï",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 244,
            "char": "ô",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 249,
            "char": "ù",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 251,
            "char": "û",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 252,
            "char": "ü",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 255,
            "char": "ÿ",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 376,
            "char": "Ÿ",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 196,
            "char": "Ä",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 228,
            "char": "ä",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 214,
            "char": "Ö",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 246,
            "char": "ö",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 223,
            "char": "ß",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 7838,
            "char": "ẞ",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 226,
            "char": "â",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 193,
            "char": "Á",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 225,
            "char": "á",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 205,
            "char": "Í",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 237,
            "char": "í",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 209,
            "char": "Ñ",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 241,
            "char": "ñ",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 250,
            "char": "ú",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 211,
            "char": "Ó",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 243,
            "char": "ó",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 218,
            "char": "Ú",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 46,
            "char": ".",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 44,
            "char": ",",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 58,
            "char": ":",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 59,
            "char": ";",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 8230,
            "char": "…",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 33,
            "char": "!",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 63,
            "char": "?",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 183,
            "char": "·",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 8226,
            "char": "•",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 42,
            "char": "*",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 35,
            "char": "#",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 47,
            "char": "/",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 92,
            "char": "\\",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 45,
            "char": "-",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 8211,
            "char": "–",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8212,
            "char": "—",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 95,
            "char": "_",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 40,
            "char": "(",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 41,
            "char": ")",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 123,
            "char": "{",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 125,
            "char": "}",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 91,
            "char": "[",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 93,
            "char": "]",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 8220,
            "char": "“",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8221,
            "char": "”",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8216,
            "char": "‘",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 8217,
            "char": "’",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 8249,
            "char": "‹",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8250,
            "char": "›",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 34,
            "char": "\"",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 39,
            "char": "'",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 64,
            "char": "@",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 38,
            "char": "&",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 124,
            "char": "|",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 43,
            "char": "+",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 61,
            "char": "=",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 62,
            "char": ">",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 60,
            "char": "<",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 126,
            "char": "~",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 94,
            "char": "^",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 37,
            "char": "%",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8260,
            "char": "⁄",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 189,
            "char": "½",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 188,
            "char": "¼",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 190,
            "char": "¾",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 8539,
            "char": "⅛",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8540,
            "char": "⅜",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 8541,
            "char": "⅝",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 8542,
            "char": "⅞",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8320,
            "char": "₀",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8321,
            "char": "₁",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 8322,
            "char": "₂",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8323,
            "char": "₃",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8324,
            "char": "₄",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8325,
            "char": "₅",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8326,
            "char": "₆",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8327,
            "char": "₇",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8328,
            "char": "₈",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8329,
            "char": "₉",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8304,
            "char": "⁰",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8305,
            "char": "ⁱ",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8306,
            "char": "⁲",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8307,
            "char": "⁳",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8308,
            "char": "⁴",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8309,
            "char": "⁵",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8310,
            "char": "⁶",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8311,
            "char": "⁷",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8312,
            "char": "⁸",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 8313,
            "char": "⁹",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 191,
            "char": "¿",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8218,
            "char": "‚",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 8222,
            "char": "„",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 171,
            "char": "«",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 187,
            "char": "»",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 3647,
            "char": "฿",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 182,
            "char": "¶",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 167,
            "char": "§",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 169,
            "char": "©",
            "width": 8,
            "height": 26
          ],
          [
            "code_point": 174,
            "char": "®",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8482,
            "char": "™",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 176,
            "char": "°",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 166,
            "char": "¦",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 8224,
            "char": "†",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8225,
            "char": "‡",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8364,
            "char": "€",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 8383,
            "char": "₿",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 162,
            "char": "¢",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 36,
            "char": "$",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 163,
            "char": "£",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 165,
            "char": "¥",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8722,
            "char": "−",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 215,
            "char": "×",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 247,
            "char": "÷",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 8800,
            "char": "≠",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 8805,
            "char": "≥",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 8804,
            "char": "≤",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 177,
            "char": "±",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 8776,
            "char": "≈",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 172,
            "char": "¬",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8734,
            "char": "∞",
            "width": 8,
            "height": 26
          ],
          [
            "code_point": 8747,
            "char": "∫",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8719,
            "char": "∏",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8721,
            "char": "∑",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8730,
            "char": "√",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8706,
            "char": "∂",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 8240,
            "char": "‰",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 8593,
            "char": "↑",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8599,
            "char": "↗",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8594,
            "char": "→",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 8600,
            "char": "↘",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8595,
            "char": "↓",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8601,
            "char": "↙",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8592,
            "char": "←",
            "width": 7,
            "height": 26
          ],
          [
            "code_point": 8598,
            "char": "↖",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 8596,
            "char": "↔",
            "width": 8,
            "height": 26
          ],
          [
            "code_point": 8597,
            "char": "↕",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 9676,
            "char": "◌",
            "width": 9,
            "height": 26
          ],
          [
            "code_point": 9674,
            "char": "◊",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 168,
            "char": "¨",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 729,
            "char": "˙",
            "width": 1,
            "height": 26
          ],
          [
            "code_point": 96,
            "char": "`",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 180,
            "char": "´",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 733,
            "char": "˝",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 710,
            "char": "ˆ",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 711,
            "char": "ˇ",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 728,
            "char": "˘",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 730,
            "char": "˚",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 732,
            "char": "˜",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 175,
            "char": "¯",
            "width": 3,
            "height": 26
          ],
          [
            "code_point": 184,
            "char": "¸",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 731,
            "char": "˛",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 306,
            "char": "Ĳ",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 307,
            "char": "ĳ",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 352,
            "char": "Š",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 353,
            "char": "š",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 381,
            "char": "Ž",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 382,
            "char": "ž",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 195,
            "char": "Ã",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 197,
            "char": "Å",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 198,
            "char": "Æ",
            "width": 8,
            "height": 26
          ],
          [
            "code_point": 204,
            "char": "Ì",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 208,
            "char": "Ð",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 210,
            "char": "Ò",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 213,
            "char": "Õ",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 216,
            "char": "Ø",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 221,
            "char": "Ý",
            "width": 6,
            "height": 26
          ],
          [
            "code_point": 222,
            "char": "Þ",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 227,
            "char": "ã",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 229,
            "char": "å",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 230,
            "char": "æ",
            "width": 8,
            "height": 26
          ],
          [
            "code_point": 236,
            "char": "ì",
            "width": 2,
            "height": 26
          ],
          [
            "code_point": 240,
            "char": "ð",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 242,
            "char": "ò",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 245,
            "char": "õ",
            "width": 4,
            "height": 26
          ],
          [
            "code_point": 248,
            "char": "ø",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 253,
            "char": "ý",
            "width": 5,
            "height": 26
          ],
          [
            "code_point": 254,
            "char": "þ",
            "width": 4,
            "height": 26
          ]
        ]
        
        // Map characters directly to FontGlyph objects
        for glyph in hardcodedGlyphs {
            guard let codePoint = glyph["code_point"] as? Int,
                  let width = glyph["width"] as? Int,
                  let height = glyph["height"] as? Int else {
                continue
            }
            
            let character = Character(UnicodeScalar(codePoint)!)
            fontMap[character] = FontGlyph(width: width, height: height)
        }
        
        print("Hardcoded font data loaded successfully! \(fontMap.count) glyphs mapped.")
    }
    
    func getGlyph(_ character: Character) -> FontGlyph {
        return fontMap[character] ?? FontGlyph(width: 6, height: 26) // Default width=6, height=26
    }
    
    struct FontGlyph {
        let width: Int
        let height: Int
        
        init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }
    }
}

import Foundation

/// Converts accented and extended Latin letters to base glyphs at the device boundary.
enum LatinTextSanitizer {
    private static let latinLettersWithMarks = try! NSRegularExpression(pattern: #"\p{Latin}\p{M}*"#)

    static func sanitizeForDisplay(_ text: String, preserveOtherScripts: Bool = false) -> String {
        if preserveOtherScripts {
            let output = NSMutableString(string: text)
            let range = NSRange(text.startIndex ..< text.endIndex, in: text)
            for match in latinLettersWithMarks.matches(in: text, range: range).reversed() {
                let cluster = output.substring(with: match.range)
                let expanded = cluster.unicodeScalars.map { expandLatinLetter(Character($0)) }.joined()
                output.replaceCharacters(in: match.range, with: stripDiacritics(expanded))
            }
            return output as String
        }
        // Preserve the established G1 folding behavior.
        let expanded = text.reduce(into: "") { result, character in
            result.append(expandLatinLetter(character))
        }
        return stripDiacritics(expanded)
    }

    private static func stripDiacritics(_ text: String) -> String {
        text.folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX"))
    }

    private static func expandLatinLetter(_ character: Character) -> String {
        switch character {
        case "Đ", "Ð": return "D"
        case "đ", "ð": return "d"
        case "Ł": return "L"
        case "ł": return "l"
        case "Ø": return "O"
        case "ø": return "o"
        case "Æ": return "AE"
        case "æ": return "ae"
        case "Œ": return "OE"
        case "œ": return "oe"
        case "ẞ": return "SS"
        case "ß": return "ss"
        case "Þ": return "TH"
        case "þ": return "th"
        default: return String(character)
        }
    }
}

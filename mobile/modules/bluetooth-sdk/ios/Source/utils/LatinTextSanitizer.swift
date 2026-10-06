import Foundation

/// Converts accented and extended Latin letters to base glyphs at the device boundary.
enum LatinTextSanitizer {
    static func sanitizeForDisplay(_ text: String) -> String {
        let expanded = text.reduce(into: "") { result, character in
            switch character {
            case "Đ", "Ð": result.append("D")
            case "đ", "ð": result.append("d")
            case "Ł": result.append("L")
            case "ł": result.append("l")
            case "Ø": result.append("O")
            case "ø": result.append("o")
            case "Æ": result.append("AE")
            case "æ": result.append("ae")
            case "Œ": result.append("OE")
            case "œ": result.append("oe")
            case "ẞ": result.append("SS")
            case "ß": result.append("ss")
            case "Þ": result.append("TH")
            case "þ": result.append("th")
            default: result.append(character)
            }
        }

        return expanded
            .folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX"))
    }
}

import Foundation

/// Empty interior rows shut down some EvenHub firmware pages. Keep the row
/// without exposing this protocol workaround to miniapps or other devices.
enum G2Text {
    static func containerContent(_ text: String) -> String {
        if text.isEmpty { return " " }
        return text.components(separatedBy: "\n")
            .map { $0.isEmpty ? "\u{200B}" : $0 }.joined(separator: "\n")
    }
}

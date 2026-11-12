import Foundation

/// What a loaded on-device speech model can do, decided from its files, never its folder name.
struct SttModelTraits: Equatable {
    enum Kind: String {
        /// Streaming transducer (encoder/decoder/joiner), e.g. Zipformer or Kroko.
        case transducer
        /// Streaming CTC (single model file).
        case ctc
    }

    let kind: Kind
    /// The vocabulary has no lowercase letters, so the model writes ALL CAPS.
    let uppercaseOnlyVocabulary: Bool

    init(kind: Kind, uppercaseOnlyVocabulary: Bool) {
        self.kind = kind
        self.uppercaseOnlyVocabulary = uppercaseOnlyVocabulary
    }

    init(kind: Kind, tokensFileContents: String) {
        self.init(kind: kind, uppercaseOnlyVocabulary: Self.isUppercaseOnly(tokensFileContents: tokensFileContents))
    }

    /// Any streaming transducer can end its utterance early by flushing its stream.
    var canFinalizeEarly: Bool {
        kind == .transducer
    }

    /// Same rule as Android: streaming transducers get four CPU threads, other models one.
    var numThreads: Int {
        kind == .transducer ? 4 : 1
    }

    /// Lowercase output from a model that can only write capitals; keep everything else as the
    /// model wrote it, including its punctuation and capitalization.
    func format(_ text: String) -> String {
        uppercaseOnlyVocabulary ? text.lowercased() : text
    }

    /// `tokens.txt` holds one `<token> <id>` per line. Special tokens such as `<blk>` or `<0x41>`
    /// are ignored. A vocabulary with capital letters and no lowercase letters is uppercase-only.
    static func isUppercaseOnly(tokensFileContents: String) -> Bool {
        var sawUppercase = false
        for rawLine in tokensFileContents.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            let token: Substring
            if let separator = line.lastIndex(where: { $0 == " " || $0 == "\t" }) {
                token = line[..<separator]
            } else {
                token = Substring(line)
            }
            if token.hasPrefix("<"), token.hasSuffix(">") { continue }
            for character in token where character.isLetter {
                if character.isLowercase { return false }
                if character.isUppercase { sawUppercase = true }
            }
        }
        return sawUppercase
    }
}

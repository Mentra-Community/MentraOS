import Foundation

/// Preserves the embedded G1 1.5.6 Latin glyphs; see notes/g1-character-support.md.
enum G1TextSanitizer {
    private static let supportedLatin = Set("ÀÂÇÈÉÊËÎÏÔÙÛÜàçèéêëîïôùûüÿŸÄäÖößẞâÁáÍíÑñúÓóÚⁱĲĳŠšŽžÃÅÆÌÐÒÕØÝÞãåæìðòõøýþĄąĆćČčĎďĘęĚěĞğŁłŃńŇňŘřŚśŞşŤťŮůŹźŻżĂăıȘșȚțǖǘǚǜǎǐǒǔŐőŰű".unicodeScalars)
    private static let latinClusters = try! NSRegularExpression(pattern: #"\p{Latin}\p{M}*"#)

    static func sanitizeForDisplay(_ text: String) -> String {
        let output = NSMutableString(string: text)
        let range = NSRange(text.startIndex ..< text.endIndex, in: text)
        for match in latinClusters.matches(in: text, range: range).reversed() {
            let cluster = output.substring(with: match.range)
            let composed = cluster.precomposedStringWithCanonicalMapping
            let scalars = composed.unicodeScalars
            let replacement: String
            if scalars.count == 1, let scalar = scalars.first,
               (0x20 ... 0x7E).contains(scalar.value) || supportedLatin.contains(scalar)
            {
                replacement = composed
            } else {
                replacement = LatinTextSanitizer.sanitizeForDisplay(cluster, preserveOtherScripts: true)
            }
            output.replaceCharacters(in: match.range, with: replacement)
        }
        return output as String
    }
}

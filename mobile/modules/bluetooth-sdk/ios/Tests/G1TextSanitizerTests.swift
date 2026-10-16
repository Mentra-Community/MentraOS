@testable import MentraBluetoothSDK
import XCTest

final class G1TextSanitizerTests: XCTestCase {
    func testPreservesSwedishTextAndComposesDecomposedAccents() {
        let text = "“Hallå, hallå”\nÅÄÖ åäö"
        XCTAssertEqual(G1Text.sanitizeForDisplay(text), text)
        XCTAssertEqual(G1Text.sanitizeForDisplay("Halla\u{030A}, halla\u{030A}"), "Hallå, hallå")
        XCTAssertEqual(G1Text.sanitizeForDisplay("Cafe\u{0301}\nĐa Nang"), "Café\nDa Nang")
    }

    func testFallsBackOnlyForUnmappedLatinAndIsIdempotent() {
        let text = "Tiếng Việt: Đặng, Nguyễn, phở bò; Øresund Łódź Æsir Œuvre Straße Ðingvellir Þingvellir"
        let expected = "Tieng Viet: Dang, Nguyen, pho bò; Øresund Łódź Æsir OEuvre Straße Ðingvellir Þingvellir"
        XCTAssertEqual(G1Text.sanitizeForDisplay(text), expected)
        XCTAssertEqual(G1Text.sanitizeForDisplay(expected), expected)
    }

    func testPreservesOtherScriptsAndNimoKeepsItsOwnFallback() {
        let otherScripts = "が カ\u{3099} 한\u{302E} Α\u{0301} مُرَحَّبًا शि ❤️"
        XCTAssertEqual(G1Text.sanitizeForDisplay(otherScripts), otherScripts)
        XCTAssertEqual(LatinTextSanitizer.sanitizeForDisplay("Hallå Æsir Straße", preserveOtherScripts: true),
                       "Halla AEsir Strasse")
    }

    func testPreservesEveryEmbeddedExtendedLatinGlyphInComposedAndDecomposedForms() {
        let glyphs = "ÀÂÇÈÉÊËÎÏÔÙÛÜàçèéêëîïôùûüÿŸÄäÖößẞâÁáÍíÑñúÓóÚⁱĲĳŠšŽžÃÅÆÌÐÒÕØÝÞãåæìðòõøýþĄąĆćČčĎďĘęĚěĞğŁłŃńŇňŘřŚśŞşŤťŮůŹźŻżĂăıȘșȚțǖǘǚǜǎǐǒǔŐőŰű"
        XCTAssertEqual(Array(G1Text.sanitizeForDisplay(glyphs).utf8), Array(glyphs.utf8))
        let decomposed = glyphs.decomposedStringWithCanonicalMapping
        XCTAssertEqual(Array(G1Text.sanitizeForDisplay(decomposed).utf8), Array(glyphs.utf8))
    }
}

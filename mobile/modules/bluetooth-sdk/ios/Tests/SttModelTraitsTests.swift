@testable import MentraBluetoothSDK
import XCTest

final class SttModelTraitsTests: XCTestCase {
    private let zipformerTokens = "<blk> 0\n<sos/eos> 1\n<unk> 2\n▁THE 3\nS 4\n▁AND 5\n'S 6\n"
    private let krokoTokens = "<blk> 0\n▁the 1\n▁The 2\n, 3\n. 4\n▁Paris 5\n"

    func testStreamingTransducersFinalizeEarlyAndUseFourThreadsWhateverTheFolder() {
        let traits = SttModelTraits(kind: .transducer, tokensFileContents: krokoTokens)
        XCTAssertTrue(traits.canFinalizeEarly)
        XCTAssertEqual(traits.numThreads, 4)
    }

    func testCtcModelsCannotFinalizeEarlyAndUseOneThread() {
        let traits = SttModelTraits(kind: .ctc, tokensFileContents: krokoTokens)
        XCTAssertFalse(traits.canFinalizeEarly)
        XCTAssertEqual(traits.numThreads, 1)
    }

    func testUppercaseOnlyVocabularyIsLowercased() {
        let traits = SttModelTraits(kind: .transducer, tokensFileContents: zipformerTokens)
        XCTAssertTrue(traits.uppercaseOnlyVocabulary)
        XCTAssertEqual(traits.format("HELLO WORLD"), "hello world")
    }

    func testMixedCaseVocabularyKeepsModelFormatting() {
        let traits = SttModelTraits(kind: .transducer, tokensFileContents: krokoTokens)
        XCTAssertFalse(traits.uppercaseOnlyVocabulary)
        XCTAssertEqual(traits.format("Hello, Paris."), "Hello, Paris.")
    }

    func testSpecialTokensAndCaselessScriptsAreNotUppercaseOnly() {
        XCTAssertFalse(SttModelTraits.isUppercaseOnly(tokensFileContents: "<blk> 0\n<unk> 1\n<0x41> 2\n"))
        XCTAssertFalse(SttModelTraits.isUppercaseOnly(tokensFileContents: "<blk> 0\n你 1\n好 2\n"))
        XCTAssertTrue(SttModelTraits.isUppercaseOnly(tokensFileContents: "<blk> 0\n你 1\nA 2\n"))
        XCTAssertFalse(SttModelTraits.isUppercaseOnly(tokensFileContents: ""))
    }
}

final class BoundedWaitTests: XCTestCase {
    func testResolvesWithTheWorkResultBeforeTheTimeout() async {
        let value: String? = await withBoundedWait(timeout: 2, timeoutValue: nil) { resolver in
            DispatchQueue.global().async { resolver.resolve("final text") }
        }
        XCTAssertEqual(value, "final text")
    }

    func testTimeoutResolvesWithTheTimeoutValueAndLateWorkSeesItSettled() async {
        let late = expectation(description: "late work")
        var settledWhenLate = false
        let value: String? = await withBoundedWait(timeout: 0.05, timeoutValue: nil) { resolver in
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
                settledWhenLate = resolver.isSettled
                resolver.resolve("too late")
                late.fulfill()
            }
        }
        XCTAssertNil(value)
        await fulfillment(of: [late], timeout: 2)
        XCTAssertTrue(settledWhenLate)
    }
}

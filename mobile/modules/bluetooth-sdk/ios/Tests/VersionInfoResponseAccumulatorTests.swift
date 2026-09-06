@testable import MentraBluetoothSDK
import XCTest

final class VersionInfoResponseAccumulatorTests: XCTestCase {
    func testMergesCurrentChunksAndCompletesOnFirmwareChunk() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")

        guard case let .waiting(allowQuietPeriod) = accumulator.accept(
            chunk("version_info_1", "request-1", ["buildNumber": "42"])
        ), !allowQuietPeriod
        else {
            return XCTFail("Expected first chunk to wait")
        }
        XCTAssertNil(accumulator.finishAfterQuietPeriod())

        let outcome = accumulator.accept(
            chunk(
                "version_info_3",
                "request-1",
                [
                    "buildNumber": "",
                    "besFirmwareVersion": "26.8.27.0",
                    "mtkFirmwareVersion": "MentraLive_20260709",
                ]
            )
        )
        guard case let .complete(result) = outcome else {
            return XCTFail("Expected final chunk to complete")
        }

        XCTAssertEqual(result.buildNumber, "42")
        XCTAssertEqual(result.besFirmwareVersion, "26.8.27.0")
        XCTAssertEqual(result.mtkFirmwareVersion, "MentraLive_20260709")
    }

    func testIgnoresMismatchedAndTrailingStaleChunks() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")

        guard case .ignored = accumulator.accept(chunk("version_info_1", "other", ["buildNumber": "old"]))
        else {
            return XCTFail("Expected mismatched response to be ignored")
        }
        guard case .ignored = accumulator.accept(chunk("version_info_3", nil, ["besFirmwareVersion": "stale"]))
        else {
            return XCTFail("Expected stale trailing chunk to be ignored")
        }
        XCTAssertNil(accumulator.finishAfterQuietPeriod())
    }

    func testDoesNotMixCorrelatedAndUncorrelatedSequences() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        _ = accumulator.accept(chunk("version_info_1", "request-1", ["buildNumber": "42"]))

        guard case .ignored = accumulator.accept(
            chunk("version_info_3", nil, ["besFirmwareVersion": "stale"])
        ) else {
            return XCTFail("Expected uncorrelated trailing chunk to be ignored")
        }

        let outcome = accumulator.accept(
            chunk("version_info_3", "request-1", ["besFirmwareVersion": "current"])
        )
        guard case let .complete(result) = outcome else {
            return XCTFail("Expected correlated final chunk to complete")
        }
        XCTAssertEqual(result.besFirmwareVersion, "current")
    }

    func testStaleUncorrelatedResponsesCannotReplaceCorrelatedSequence() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        _ = accumulator.accept(chunk("version_info_1", "request-1", ["buildNumber": "42"]))

        guard case .ignored = accumulator.accept(chunk("version_info_1", nil, ["buildNumber": "stale"]))
        else {
            return XCTFail("Expected stale first chunk to be ignored")
        }
        guard case .ignored = accumulator.accept(chunk("version_info", nil, ["buildNumber": "legacy"]))
        else {
            return XCTFail("Expected stale legacy response to be ignored")
        }

        let outcome = accumulator.accept(
            chunk("version_info_3", "request-1", ["besFirmwareVersion": "current"])
        )
        guard case let .complete(result) = outcome else {
            return XCTFail("Expected correlated final chunk to complete")
        }
        XCTAssertEqual(result.buildNumber, "42")
        XCTAssertEqual(result.besFirmwareVersion, "current")
    }

    func testRepeatedFirstChunkResetsRatherThanMixingResponses() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        _ = accumulator.accept(chunk("version_info_1", nil, ["appVersion": "old"]))
        _ = accumulator.accept(chunk("version_info_1", nil, ["buildNumber": "43"]))

        guard case let .waiting(allowQuietPeriod) = accumulator.accept(
            chunk("version_info_3", nil, ["besFirmwareVersion": "new"])
        ), allowQuietPeriod
        else {
            return XCTFail("Expected uncorrelated fallback to wait for the quiet period")
        }
        guard let result = accumulator.finishAfterQuietPeriod() else {
            return XCTFail("Expected accumulated fallback result")
        }
        XCTAssertEqual(result.appVersion, "")
        XCTAssertEqual(result.buildNumber, "43")
        XCTAssertEqual(result.besFirmwareVersion, "new")
    }

    func testLegacySingleMessageCompletesImmediately() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")

        let outcome = accumulator.accept(chunk("version_info", nil, ["buildNumber": "7"]))
        guard case let .complete(result) = outcome else {
            return XCTFail("Expected legacy response to complete")
        }
        XCTAssertEqual(result.buildNumber, "7")
    }

    func testQuietPeriodCanFinishOlderPartialChunkResponse() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        _ = accumulator.accept(chunk("version_info_1", nil, ["buildNumber": "8"]))

        XCTAssertEqual(accumulator.finishAfterQuietPeriod()?.buildNumber, "8")
    }

    private func chunk(_ type: String, _ requestId: String?, _ values: [String: Any]) -> [String: Any] {
        var event = values
        event[VersionInfoResponseAccumulator.responseChunkKey] = type
        if let requestId {
            event[VersionInfoResponseAccumulator.responseRequestIdKey] = requestId
        }
        return event
    }
}

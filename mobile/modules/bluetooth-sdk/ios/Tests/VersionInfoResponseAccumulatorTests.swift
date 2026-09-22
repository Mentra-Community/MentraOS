@testable import MentraBluetoothSDK
import XCTest

final class VersionInfoResponseAccumulatorTests: XCTestCase {
    func testMergesCurrentChunksAndCompletesOnFirmwareChunk() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")

        guard case .waiting = accumulator.accept(
            chunk("version_info_1", "request-1", ["buildNumber": "42"])
        )
        else {
            return XCTFail("Expected first chunk to wait")
        }

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

        guard case let .complete(result) = accumulator.accept(
            chunk("version_info_3", nil, ["besFirmwareVersion": "new"])
        ) else { return XCTFail("Legacy final chunk must complete immediately") }
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

    func testLegacyFirstChunkDoesNotComplete() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        guard case .waiting = accumulator.accept(chunk("version_info_1", nil, ["buildNumber": "8"])) else {
            return XCTFail("Partial response must wait for final chunk or deadline")
        }
    }

    func testModernFinalChunkWaitsForMissingFirstChunk() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        guard case .waiting = accumulator.accept(chunk("version_info_3", "request-1", ["besFirmwareVersion": "new"])) else {
            return XCTFail("Missing first chunk")
        }
        guard case let .complete(result) = accumulator.accept(chunk("version_info_1", "request-1", ["buildNumber": "42"])) else {
            return XCTFail("Both chunks arrived")
        }
        XCTAssertEqual(result.buildNumber, "42")
        XCTAssertEqual(result.besFirmwareVersion, "new")
    }

    func testDuplicateDoesNotCountAsMissingChunk() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        let first = chunk("version_info_1", "request-1", ["buildNumber": "42"])
        _ = accumulator.accept(first)
        guard case .waiting = accumulator.accept(first) else { return XCTFail("Duplicate is not completion") }
    }

    func testRejectsMalformedModernMetadataAndMixedProcess() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        let first = chunk("version_info_1", "request-1", ["buildNumber": "42"])
        for (key, value) in [
            VersionInfoResponseAccumulator.responseCountKey: 2.5,
            VersionInfoResponseAccumulator.responseIndexKey: true,
            VersionInfoResponseAccumulator.responseFinalKey: true,
            VersionInfoResponseAccumulator.responseRequestIdKey: "",
        ] as [String: Any] {
            var invalid = first
            invalid[key] = value
            guard case .ignored = accumulator.accept(invalid) else { return XCTFail("Invalid " + key) }
        }
        _ = accumulator.accept(first)
        let last = chunk("version_info_3", "request-1", ["besFirmwareVersion": "new"])
        var restarted = last
        restarted[VersionInfoResponseAccumulator.responseSidKey] = "process-2"
        guard case .ignored = accumulator.accept(restarted) else { return XCTFail("Mixed process") }
        guard case .complete = accumulator.accept(last) else { return XCTFail("Matching final chunk") }
    }

    func testCorrelatedResponseWithoutCompletenessMetadataCannotComplete() {
        let accumulator = VersionInfoResponseAccumulator(expectedRequestId: "request-1")
        let event: [String: Any] = [
            VersionInfoResponseAccumulator.responseChunkKey: "version_info_3",
            VersionInfoResponseAccumulator.responseRequestIdKey: "request-1",
        ]
        guard case .ignored = accumulator.accept(event) else { return XCTFail("Incomplete modern metadata") }
    }

    private func chunk(_ type: String, _ requestId: String?, _ values: [String: Any]) -> [String: Any] {
        var event = values
        event[VersionInfoResponseAccumulator.responseChunkKey] = type
        if let requestId {
            event[VersionInfoResponseAccumulator.responseRequestIdKey] = requestId
            event[VersionInfoResponseAccumulator.responseIndexKey] = type == "version_info_1" ? 1 : 2
            event[VersionInfoResponseAccumulator.responseCountKey] = 2
            event[VersionInfoResponseAccumulator.responseFinalKey] = type == "version_info_3"
            event[VersionInfoResponseAccumulator.responseSidKey] = "process-1"
        }
        return event
    }
}

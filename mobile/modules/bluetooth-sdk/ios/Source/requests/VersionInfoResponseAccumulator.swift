import Foundation

enum VersionInfoAccumulatorOutcome {
    case ignored
    case waiting(allowQuietPeriod: Bool)
    case complete(VersionInfoResult)
}

/// Collects one version-info response without combining adjacent unsolicited or stale responses.
///
/// Current Mentra Live firmware sends `version_info_1` followed by `version_info_3`. A new chunk 1
/// always starts a fresh response, while later chunks are ignored until that boundary is observed.
/// New firmware also echoes the request id, which gives exact correlation; the chunk boundary keeps
/// the same request compatible with older firmware that does not echo it.
final class VersionInfoResponseAccumulator {
    static let responseChunkKey = "_responseChunk"
    static let responseRequestIdKey = "_responseRequestId"

    private static let legacyChunk = "version_info"
    private static let chunkPrefix = "version_info_"
    private static let firstChunk = "version_info_1"
    private static let finalChunk = "version_info_3"

    private let expectedRequestId: String
    private var values: [String: Any] = [:]
    private var started = false
    private var startedRequestId: String?

    init(expectedRequestId: String) {
        self.expectedRequestId = expectedRequestId
    }

    func accept(_ event: [String: Any]) -> VersionInfoAccumulatorOutcome {
        if let responseRequestId = event[Self.responseRequestIdKey] as? String,
           !responseRequestId.isEmpty,
           responseRequestId != expectedRequestId
        {
            return .ignored
        }
        let isCorrelated = event[Self.responseRequestIdKey] as? String == expectedRequestId

        let chunk = event[Self.responseChunkKey] as? String ?? Self.legacyChunk
        if chunk == Self.legacyChunk {
            return .complete(VersionInfoResult(values: event))
        }
        guard chunk.hasPrefix(Self.chunkPrefix) else { return .ignored }

        if chunk == Self.firstChunk {
            values.removeAll()
            started = true
            startedRequestId = event[Self.responseRequestIdKey] as? String
        } else if !started {
            // A trailing chunk can be left in the BLE queue from a boot-time or timed-out response.
            return .ignored
        } else if event[Self.responseRequestIdKey] as? String != startedRequestId {
            // Never combine an uncorrelated fallback sequence with a request-id-bearing sequence.
            return .ignored
        }

        mergeNonEmptyFields(event)
        let result = VersionInfoResult(values: values)
        return chunk == Self.finalChunk && isCorrelated
            ? .complete(result)
            : .waiting(allowQuietPeriod: !isCorrelated)
    }

    func finishAfterQuietPeriod() -> VersionInfoResult? {
        started && startedRequestId == nil ? VersionInfoResult(values: values) : nil
    }

    private func mergeNonEmptyFields(_ event: [String: Any]) {
        for (key, value) in event {
            if key == Self.responseChunkKey || key == Self.responseRequestIdKey || key == "type" {
                continue
            }
            if let string = value as? String, string.isEmpty {
                continue
            }
            values[key] = value
        }
    }
}

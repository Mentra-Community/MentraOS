import CoreFoundation
import Foundation

enum VersionInfoAccumulatorOutcome {
    case ignored
    case waiting
    case complete(VersionInfoResult)
}

/// One request, explicit modern completion, or the deployed legacy chunk-3 terminal boundary.
final class VersionInfoResponseAccumulator {
    static let responseChunkKey = "_responseChunk"
    static let responseRequestIdKey = "_responseRequestId"
    static let responseIndexKey = "_responseChunkIndex"
    static let responseCountKey = "_responseChunkCount"
    static let responseFinalKey = "_responseFinal"
    static let responseSidKey = "_responseSid"
    private static let modernKeys = [responseRequestIdKey, responseIndexKey, responseCountKey, responseFinalKey]

    private let expectedRequestId: String
    private var values: [String: Any] = [:]
    private var chunks: [Int: [String: Any]] = [:]
    private var count: Int?
    private var sid: String?
    private var legacyStarted = false
    private var completed = false

    init(expectedRequestId: String) {
        self.expectedRequestId = expectedRequestId
    }

    func accept(_ event: [String: Any]) -> VersionInfoAccumulatorOutcome {
        guard !completed else { return .ignored }
        if Self.modernKeys.contains(where: { event[$0] != nil }) {
            guard event[Self.responseRequestIdKey] as? String == expectedRequestId,
                  let index = integer(event[Self.responseIndexKey]),
                  let total = integer(event[Self.responseCountKey]),
                  let final = event[Self.responseFinalKey] as? NSNumber,
                  CFGetTypeID(final) == CFBooleanGetTypeID(),
                  let process = event[Self.responseSidKey] as? String, !process.isEmpty,
                  (1 ... 16).contains(total), (1 ... total).contains(index),
                  final.boolValue == (index == total)
            else { return .ignored }
            if let count, count != total || sid != process { return .ignored }
            if count == nil {
                values.removeAll()
                count = total
                sid = process
            }
            chunks[index] = event
            guard chunks.count == total else { return .waiting }
            for index in 1 ... total {
                merge(chunks[index]!)
            }
            return finish()
        }
        guard count == nil else { return .ignored }
        switch event[Self.responseChunkKey] as? String ?? "version_info" {
        case "version_info":
            values.removeAll()
            merge(event)
            return finish()
        case "version_info_1":
            values.removeAll()
            legacyStarted = true
            merge(event)
        case "version_info_2":
            guard legacyStarted else { return .ignored }
            merge(event)
        case "version_info_3":
            guard legacyStarted else { return .ignored }
            merge(event)
            return finish()
        default: return .ignored
        }
        // Silence is never evidence of completion. The request's normal deadline handles loss.
        return .waiting
    }

    private func finish() -> VersionInfoAccumulatorOutcome {
        completed = true
        return .complete(VersionInfoResult(values: values))
    }

    private func merge(_ event: [String: Any]) {
        for (key, value) in event where !key.hasPrefix("_response") && key != "type" {
            if let string = value as? String, string.isEmpty { continue }
            values[key] = value
        }
    }

    private func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue >= 1, number.doubleValue <= 16,
              number.doubleValue == Double(number.intValue)
        else { return nil }
        return number.intValue
    }
}

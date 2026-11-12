import Foundation

public struct BluetoothSdkError: Error, LocalizedError, CustomStringConvertible {
    public let code: String
    public let message: String
    /// Machine-readable reason a `pair_failure` carries (`pair_failure.code`), such as
    /// `ios_forget_pairing`. Nil for other errors.
    public let failureCode: String?

    public init(code: String, message: String, failureCode: String? = nil) {
        self.code = code
        self.message = message
        self.failureCode = failureCode
    }

    public var errorDescription: String? {
        message
    }

    public var description: String {
        "\(code): \(message)"
    }
}

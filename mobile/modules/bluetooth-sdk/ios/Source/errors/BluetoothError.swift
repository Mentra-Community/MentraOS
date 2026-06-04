import Foundation

public struct BluetoothError: Error, LocalizedError, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? {
        message
    }

    public var description: String {
        "\(code): \(message)"
    }
}

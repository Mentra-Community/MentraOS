import Foundation

@main
struct MacNimoBootstrapLaunchTests {
    static func main() throws {
        let birth = NimoBootstrapBirth(seconds: 1234, microseconds: 5678)
        let digest = String(repeating: "a", count: 64)
        let nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let valid: [String: Any] = ["version": 1, "ownerPid": 123, "ownerAuditToken": digest, "ownerBirth": ["seconds": 1234, "microseconds": 5678],
            "planSha256": digest, "grantSha256": digest, "bootstrapNonce": nonce, "appExecutableSha256": digest, "appBundleId": "com.mentra.mentra"]
        func text(_ object: [String: Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self) }
        func validate(_ object: [String: Any]) throws -> String { try validatedNimoBootstrap(text(object), bundleId: "com.mentra.mentra", executableSha256: digest, parentPid: 123, parentBirth: birth) }
        let normalized = try validate(valid)
        let decoded = try JSONDecoder().decode(NimoLaunchBootstrap.self, from: Data(normalized.utf8))
        precondition(decoded.bootstrapNonce == nonce)
        for change: [String: Any] in [
            ["environment": ["ANY_KEY": "anything"]], ["socketPath": "/tmp/other.sock"],
            ["ownerAuditToken": "bad"], ["ownerPid": 456], ["ownerPid": true], ["ownerBirth": ["seconds": 1234, "microseconds": 5679]],
            ["ownerBirth": ["seconds": 1234, "microseconds": 5678, "extra": true]],
            ["appBundleId": "other.app"], ["appExecutableSha256": String(repeating: "b", count: 64)],
            ["planSha256": "not-a-digest"], ["grantSha256": digest.uppercased()], ["bootstrapNonce": nonce.uppercased()], ["version": 2],
        ] {
            do {
                _ = try validate(valid.merging(change) { _, value in value })
                fatalError("Invalid bootstrap accepted: \(change.keys.sorted())")
            } catch {}
        }
        do {
            _ = try validatedNimoBootstrap(String(repeating: " ", count: 4097), bundleId: "com.mentra.mentra", executableSha256: digest, parentPid: 123, parentBirth: birth)
            fatalError("Unbounded bootstrap accepted")
        } catch {}
        print("Mac NIMO bootstrap validation: valid pin and 14 negative cases passed; no app launched")
    }
}

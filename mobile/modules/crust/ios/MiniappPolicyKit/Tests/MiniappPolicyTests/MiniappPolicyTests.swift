import Foundation
@testable import MiniappPolicy
import XCTest

final class MiniappNetworkPolicyTests: XCTestCase {
    func testFetchReachesOnlyHttpAndHttps() {
        for url in ["http://example.com", "https://example.com/a?b", "HTTPS://EXAMPLE.COM", "http://192.168.1.20:8080/x"] {
            XCTAssertTrue(MiniappNetworkPolicy.allowsFetch(URL(string: url)!), url)
        }
        // URLSession reads file: URLs, so this is what keeps miniapp code out of the app's files.
        for url in [
            "file:///var/mobile/Containers/Data/Application/X/Documents/mmkv/mmkv.default",
            "FILE:///etc/hosts",
            "file:/etc/hosts",
            "data:text/plain,hi",
            "ftp://example.com/x",
            "ws://example.com",
            "/etc/hosts",
            "relative/path",
        ] {
            XCTAssertFalse(MiniappNetworkPolicy.allowsFetch(URL(string: url)!), url)
        }
    }

    /// Why the gate exists: the session the bridge uses hands back a local file's bytes.
    func testUrlSessionWouldReadAFileUrl() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).txt")
        try Data("refresh-token".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let done = expectation(description: "read")
        var body: Data?
        URLSession(configuration: .default).dataTask(with: file) { data, _, _ in
            body = data
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        XCTAssertEqual(body, Data("refresh-token".utf8))
        XCTAssertFalse(MiniappNetworkPolicy.allowsFetch(file))
    }

    /// The host's own downloads (blob.setFromUrl, system.download, meeting stills) check only
    /// the first URL and rely on this: URLSession does not follow a redirect to a file: URL.
    func testUrlSessionRefusesARedirectToAFileUrl() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).txt")
        try Data("refresh-token".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let server = try RedirectServer(location: file.absoluteString)
        defer { server.stop() }

        for kind in ["data", "download"] {
            let done = expectation(description: kind)
            var read: String?
            var failure: NSError?
            let session = URLSession(configuration: .ephemeral)
            let finish: (Data?, Error?) -> Void = { data, error in
                read = data.map { String(decoding: $0, as: UTF8.self) }
                failure = error as NSError?
                done.fulfill()
            }
            if kind == "data" {
                session.dataTask(with: server.url) { data, _, error in finish(data, error) }.resume()
            } else {
                session.downloadTask(with: server.url) { location, _, error in
                    finish(location.flatMap { try? Data(contentsOf: $0) }, error)
                }.resume()
            }
            wait(for: [done], timeout: 10)
            XCTAssertNotEqual(read, "refresh-token", kind)
            XCTAssertEqual(failure?.code, NSURLErrorNoPermissionsToReadFile, kind)
        }
    }

    func testWebSocketsReachOnlyNetworkSchemes() {
        for url in ["ws://10.0.0.2:9000", "WSS://example.com/s", "http://example.com", "https://example.com"] {
            XCTAssertTrue(MiniappNetworkPolicy.allowsWebSocket(URL(string: url)!), url)
        }
        for url in ["file:///etc/hosts", "data:,x", "/socket"] {
            XCTAssertFalse(MiniappNetworkPolicy.allowsWebSocket(URL(string: url)!), url)
        }
    }
}

final class CanonicalFilePathTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testResolvesDotSegmentsAndSymlinks() throws {
        let sandbox = root.appendingPathComponent("sandbox")
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        let outside = root.appendingPathComponent("outside.txt")
        try Data("secret".utf8).write(to: outside)
        let link = sandbox.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)

        let realOutside = try XCTUnwrap(CanonicalFilePath.of(outside.path))
        XCTAssertEqual(CanonicalFilePath.of(link.path), realOutside)
        XCTAssertEqual(CanonicalFilePath.of(sandbox.path + "/../outside.txt"), realOutside)
        // The temporary directory sits under /var, itself a symlink to /private/var, like an
        // iOS app's container: both sides of a containment check must be resolved.
        XCTAssertTrue(realOutside.hasPrefix("/private/"), realOutside)
    }

    func testNilForMissingRelativeOrMalformedPaths() {
        XCTAssertNil(CanonicalFilePath.of(root.appendingPathComponent("missing.txt").path))
        XCTAssertNil(CanonicalFilePath.of("relative/path"))
        XCTAssertNil(CanonicalFilePath.of(root.path + "/a\u{0}b"))
        XCTAssertNil(CanonicalFilePath.of(""))
    }
}

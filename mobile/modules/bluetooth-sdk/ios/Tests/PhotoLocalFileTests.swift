@testable import MentraBluetoothSDK
import XCTest

final class PhotoLocalFileTests: XCTestCase {
    func testLocalFileIsOptInAndSurvivesRequestRouting() throws {
        XCTAssertFalse(try PhotoRequest.from(params: ["size": "low"]).localFile)
        let request = try PhotoRequest.from(params: ["size": "low", "localFile": true])
        XCTAssertTrue(request.localFile)
        XCTAssertTrue(request.withRequestId("routed").localFile)
    }

    func testSavingKeepsAJpegOnThePhoneUnchanged() throws {
        let jpeg = Data([0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9])
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("photo-local-file-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("nested", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }

        let saved = expectation(description: "photo saved")
        var savedFile: URL?
        var savedBytes: Int?
        BlePhotoUploadService.processAndSavePhoto(
            imageData: jpeg, requestId: "0001", directory: directory
        ) { requestId, file, byteCount in
            XCTAssertEqual(requestId, "0001")
            savedFile = file
            savedBytes = byteCount
            saved.fulfill()
        } onError: { _, error in
            XCTFail("save failed: \(error)")
            saved.fulfill()
        }
        wait(for: [saved], timeout: 10)

        let file = try XCTUnwrap(savedFile)
        XCTAssertEqual(file.deletingLastPathComponent().path, directory.path)
        XCTAssertEqual(file.pathExtension, "jpg")
        XCTAssertEqual(savedBytes, jpeg.count)
        XCTAssertEqual(try Data(contentsOf: file), jpeg)
    }
}

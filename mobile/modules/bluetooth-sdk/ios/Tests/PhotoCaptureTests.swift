@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class PhotoCaptureTests: XCTestCase {
    private var calls: [String] = []

    private func capture(preview: Bool = true) -> PhotoCapture {
        PhotoCapture(
            request: PhotoRequest(requestId: "p1", size: .medium, sound: true, preview: preview),
            deferred: true,
            glasses: PhotoCapture.Glasses(
                fetch: { [unowned self] _, preview in calls.append(preview ? "preview" : "fetch") },
                release: { [unowned self] _ in calls.append("release") },
                forget: { [unowned self] _ in calls.append("forget") }
            )
        )
    }

    func testAFetchedPhotoIsStillDeletedFromTheGlassesOnRelease() async throws {
        let capture = capture()
        capture.onStatus(PhotoStatusEvent(values: ["requestId": "p1", "status": "captured"]))
        capture.onResponse(PhotoResponseEvent(values: [
            "requestId": "p1", "state": "success", "photoUrl": "file:///cache/photo.jpg", "timestamp": 1,
        ]))
        _ = try await capture.photo()
        capture.release()
        XCTAssertEqual(calls, ["fetch", "forget", "release"])
    }

    func testAfterAReconnectOnlyWhatIsStillAwaitedIsAskedAgain() {
        let capture = capture()
        capture.onStatus(PhotoStatusEvent(values: ["requestId": "p1", "status": "captured"]))
        capture.resume()
        capture.onPreview(PhotoPreview(url: "data:image/jpeg;base64,AA==", width: 500, height: 375))
        capture.resume()
        XCTAssertEqual(calls, ["preview"])
    }

    func testWithoutAPreviewAskedForThereIsNone() async {
        let capture = capture(preview: false)
        capture.onStatus(PhotoStatusEvent(values: ["requestId": "p1", "status": "captured"]))
        capture.resume()
        XCTAssertEqual(calls, [])
        do {
            _ = try await capture.preview()
            XCTFail("preview() should throw")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "preview_not_requested")
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

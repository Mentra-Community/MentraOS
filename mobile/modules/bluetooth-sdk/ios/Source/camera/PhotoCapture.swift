import Foundation
import ImageIO

/// One photo kept on the phone, in stages. `captured()`: the camera is done and free for the next
/// one. `preview()`: the glasses' at most 500 px preview, when the request asked for one
/// (`PhotoRequest.preview`). `photo()`: the full photo as a file; the
/// first call asks the glasses to send it, and until then it waits on the glasses ("deferred
/// delivery"). `release()`: the full photo isn't needed, and the glasses delete it. Glasses without
/// deferred photos send the whole photo at once; it is then also the preview, if one was asked for.
@MainActor
public final class PhotoCapture {
    struct Glasses {
        let fetch: (PhotoRequest, _ preview: Bool) -> Void
        let release: (String) -> Void
        let forget: (String) -> Void
    }

    public let request: PhotoRequest
    public var requestId: String { request.requestId }
    let createdAt = Date()
    private let deferred: Bool
    private let glasses: Glasses
    private let capturedStage = PendingResponse<Void>(operation: "photo capture")
    private let previewStage = PendingResponse<PhotoPreview>(operation: "photo preview")
    private let photoStage = PendingResponse<PhotoResponseEvent>(operation: "photo")
    private var photoAsked: Bool

    /// Glasses from this `deferred_photos` version on keep the full photo and send a preview only when asked.
    static let deferredPhotosVersion = 2
    private static let capturedTimeoutMs = 45000
    // Capture, preview ACK and retries, then the send queue's wait behind other photos.
    private static let stageTimeoutMs = 110_000

    init(request: PhotoRequest, deferred: Bool, glasses: Glasses) {
        self.request = request
        self.deferred = deferred
        self.glasses = glasses
        photoAsked = !deferred
        if !request.preview {
            previewStage.reject(BluetoothSdkError(
                code: "preview_not_requested",
                message: "Ask for a preview with preview: true when capturing."
            ))
        }
    }

    /// Returns once the glasses wrote the photo: the camera takes the next request.
    public func captured() async throws {
        try await capturedStage.wait(timeoutMs: Self.capturedTimeoutMs)
    }

    /// The preview, if the request asked for one; else it throws `preview_not_requested`.
    public func preview() async throws -> PhotoPreview {
        try await previewStage.wait(timeoutMs: Self.stageTimeoutMs)
    }

    /// The full photo; `photoUrl` is a `file://` URL in the app's cache folder, the caller's to move.
    public func photo() async throws -> PhotoResponseEvent {
        if !photoAsked {
            photoAsked = true
            glasses.fetch(request, false)
        }
        return try await photoStage.wait(timeoutMs: Self.stageTimeoutMs)
    }

    /// The full photo isn't needed: the glasses delete it. Stages not reached yet fail.
    public func release() {
        glasses.forget(requestId)
        // The glasses keep the photo after sending it, so a released one goes even once fetched.
        if deferred { glasses.release(requestId) }
        fail(BluetoothSdkError(code: "photo_released", message: "The photo was released."))
    }

    var done: Bool { capturedStage.isCompleted && previewStage.isCompleted && photoStage.isCompleted }

    func onStatus(_ event: PhotoStatusEvent) {
        if event.status == "captured" { capturedStage.resolve(()) }
    }

    func onPreview(_ preview: PhotoPreview) {
        previewStage.resolve(preview)
    }

    func onResponse(_ event: PhotoResponseEvent) {
        switch event.response {
        case let .success(_, _, photoUrl, _, _, _, _):
            capturedStage.resolve(())
            if !deferred { previewStage.resolve(Self.previewOf(photoUrl ?? "")) }
            photoStage.resolve(event)
        case let .error(_, errorCode, errorMessage, _):
            let error = BluetoothSdkError(code: errorCode ?? "photo_request_failed", message: errorMessage)
            if !capturedStage.isCompleted {
                fail(error)
            } else if errorCode == "PREVIEW_FAILED" {
                // Only the preview failed: the photo is still on the glasses.
                previewStage.reject(error)
            } else {
                photoStage.reject(error)
            }
        }
    }

    /// The glasses are back after a reconnect or restart: ask again for what is still awaited.
    func resume() {
        guard deferred, capturedStage.isCompleted else { return }
        if !previewStage.isCompleted { glasses.fetch(request, true) }
        if photoAsked, !photoStage.isCompleted { glasses.fetch(request, false) }
    }

    private func fail(_ error: Error) {
        capturedStage.reject(error)
        previewStage.reject(error)
        photoStage.reject(error)
    }

    /// Older glasses send no preview: the whole photo stands in, with its pixel size.
    private static func previewOf(_ url: String) -> PhotoPreview {
        guard let fileUrl = URL(string: url),
              let source = CGImageSourceCreateWithURL(fileUrl as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return PhotoPreview(url: url, width: nil, height: nil) }
        return PhotoPreview(
            url: url,
            width: (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
            height: (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue
        )
    }
}

import CoreImage
import CoreVideo
import Foundation
import ImageIO

/// A photo taken from the glasses stream this phone is already decoding.
///
/// While the glasses stream, their camera cannot also take a photo. Every stream that passes
/// through this phone (an ACS call on either transport, the managed WebRTC relay) is decoded
/// here, so the next decoded frame is the photo: nothing is asked of the glasses and the stream
/// does not pause. A stream the glasses publish straight to the internet (RTMP, SRT) never
/// reaches `offer`, `isLive` stays false, and the caller's ordinary photo request gets the
/// glasses' CAMERA_BUSY.
///
/// The stream owns the decoder; the grab is a guest. `offer` only retains the buffer and hands it
/// to a worker queue. With nothing waiting it costs one uncontended lock.
public final class StreamFrameGrab {
    public static let shared = StreamFrameGrab()

    /// A stream that has not decoded a frame for this long is not one a photo can come from.
    public static let liveWindowMs: Double = 1000

    public struct Frame {
        public let jpeg: Data
        public let width: Int
        public let height: Int
    }

    /// `not_live`, `busy`, `no_frame` or `encode_failed`.
    public struct Unavailable: Error {
        public let reason: String
    }

    private final class Request {
        let onFrame: (CVPixelBuffer) -> Void
        let onFail: (String) -> Void
        init(onFrame: @escaping (CVPixelBuffer) -> Void, onFail: @escaping (String) -> Void) {
            self.onFrame = onFrame
            self.onFail = onFail
        }
    }

    private let lock = NSLock()
    private var lastFrameAt: UInt64?
    private var pending: Request?
    private let worker = DispatchQueue(label: "com.mentra.glassesmedia.stream-frame-grab", qos: .userInitiated)
    private lazy var context = CIContext()

    public init() {}

    /// Milliseconds since the last decoded frame, or -1 when there has never been one.
    public func frameAgeMs() -> Double {
        lock.lock()
        let at = lastFrameAt
        lock.unlock()
        guard let at else { return -1 }
        let now = DispatchTime.now().uptimeNanoseconds
        return now > at ? Double(now - at) / 1_000_000 : 0
    }

    public var isLive: Bool {
        let age = frameAgeMs()
        return age >= 0 && age <= Self.liveWindowMs
    }

    /// Called for every decoded glasses frame, on the source's delivery thread.
    public func offer(_ buffer: CVPixelBuffer) {
        lock.lock()
        lastFrameAt = DispatchTime.now().uptimeNanoseconds
        let request = pending
        pending = nil
        lock.unlock()
        // The closure retains the buffer, which keeps it out of the decoder's pool until encoded.
        request?.onFrame(buffer)
    }

    /// Encode the next decoded frame as a JPEG. `completion` is called exactly once, on the
    /// worker queue or the caller's.
    public func grab(quality: Double, timeoutMs: Int, completion: @escaping (Result<Frame, Unavailable>) -> Void) {
        guard isLive else {
            completion(.failure(Unavailable(reason: "not_live")))
            return
        }
        let request = Request(
            onFrame: { [weak self] buffer in
                guard let self else {
                    completion(.failure(Unavailable(reason: "no_frame")))
                    return
                }
                self.worker.async {
                    if let frame = self.encode(buffer, quality: quality) {
                        completion(.success(frame))
                    } else {
                        completion(.failure(Unavailable(reason: "encode_failed")))
                    }
                }
            },
            onFail: { reason in completion(.failure(Unavailable(reason: reason))) }
        )
        lock.lock()
        let busy = pending != nil
        if !busy { pending = request }
        lock.unlock()
        if busy {
            completion(.failure(Unavailable(reason: "busy")))
            return
        }
        worker.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
            guard let self else { return }
            // Still waiting means no frame claimed it. A claimed request is no longer `pending`,
            // so a frame and this timeout can never both answer.
            self.lock.lock()
            let expired = self.pending === request
            if expired { self.pending = nil }
            self.lock.unlock()
            if expired { request.onFail("no_frame") }
        }
    }

    private func encode(_ buffer: CVPixelBuffer, quality: Double) -> Frame? {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let image = CIImage(cvPixelBuffer: buffer)
        let options: [CIImageRepresentationOption: Any] = [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality,
        ]
        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: options) else {
            return nil
        }
        return Frame(jpeg: jpeg, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer))
    }
}

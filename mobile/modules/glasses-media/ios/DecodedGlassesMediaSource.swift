import CoreVideo
import Foundation

/// Publishers consume native buffers. No bridge serialization or dependency on ACS.
public protocol DecodedGlassesMediaSource: GlassesMediaSource {
    var onFrame: ((CVPixelBuffer) -> Void)? { get set }
    var onPcm: ((Data, Int, Int) -> Void)? { get set }
    var onStateChange: ((SourceState, String) -> Void)? { get set }
}

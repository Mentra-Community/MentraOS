import AzureCommunicationCalling
import CoreVideo
import Foundation

/// Fresh Swift sender on ACS iOS RawOutgoingVideoStream + CVPixelBuffer.
/// No RealWear code (they have no iOS equivalent).
final class AcsFrameSender {
  private var stream: RawOutgoingVideoStream?
  private var running = false
  private var lastSent: CFTimeInterval = 0

  func attach(_ stream: VirtualOutgoingVideoStream) {
    self.stream = stream
    stream.delegate = self
  }

  func send(_ pixelBuffer: CVPixelBuffer) {
    guard running, let stream else { return }
    let fps = stream.format?.framesPerSecond ?? 15
    let now = CFAbsoluteTimeGetCurrent()
    if lastSent > 0, now - lastSent < 1.0 / max(fps, 1) { return }
    lastSent = now
    do {
      let frame = RawVideoFrameBuffer(pixelBuffer, streamFormat: stream.format)
      try stream.send(frame)
    } catch {
      NSLog("ACS-SPIKE send frame failed: \(error)")
    }
  }

  func detach() {
    running = false
    stream = nil
  }
}

extension AcsFrameSender: RawOutgoingVideoStreamDelegate {
  func rawOutgoingVideoStream(_ rawOutgoingVideoStream: RawOutgoingVideoStream, didChangeState args: VideoStreamStateChangedEventArgs) {
    running = rawOutgoingVideoStream.state == .started
    NSLog("ACS-SPIKE iOS raw video state=\(rawOutgoingVideoStream.state)")
  }
}

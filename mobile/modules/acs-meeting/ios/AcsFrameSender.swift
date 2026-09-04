import AzureCommunicationCalling
import CoreVideo
import Foundation

/// Fresh Swift sender on ACS iOS RawOutgoingVideoStream + CVPixelBuffer.
/// No RealWear code (they have no iOS equivalent).
final class AcsFrameSender: NSObject {
  private var stream: VirtualOutgoingVideoStream?
  private var running = false
  private var lastSent: CFTimeInterval = 0

  func attach(_ stream: VirtualOutgoingVideoStream) {
    detach()
    self.stream = stream
    stream.delegate = self
  }

  func send(_ pixelBuffer: CVPixelBuffer) {
    guard running, let stream else { return }
    let fps = Double(stream.format.framesPerSecond)
    let now = CFAbsoluteTimeGetCurrent()
    if lastSent > 0, now - lastSent < 1.0 / max(fps, 1) { return }
    lastSent = now
    let frame = RawVideoFrameBuffer()
    frame.buffer = pixelBuffer
    frame.streamFormat = stream.format
    stream.send(frame: frame) { error in
      if let error {
        NSLog("ACS-SPIKE send frame failed: \(error)")
      }
      frame.dispose()
    }
  }

  func detach() {
    running = false
    // Drop the delegate on the previous stream so a late STOPPED from a prior
    // call cannot freeze outgoing video for the current meeting.
    stream?.delegate = nil
    stream = nil
  }
}

extension AcsFrameSender: VirtualOutgoingVideoStreamDelegate {
  func virtualOutgoingVideoStream(_ virtualOutgoingVideoStream: VirtualOutgoingVideoStream, didChangeState args: VideoStreamStateChangedEventArgs) {
    guard virtualOutgoingVideoStream === stream else { return }
    running = virtualOutgoingVideoStream.state == .started
    NSLog("ACS-SPIKE iOS raw video state=\(virtualOutgoingVideoStream.state)")
  }
}

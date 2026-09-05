import AzureCommunicationCalling
import CoreVideo
import Foundation

/// Fresh Swift sender on ACS iOS RawOutgoingVideoStream + CVPixelBuffer.
/// No RealWear code (they have no iOS equivalent).
final class AcsFrameSender: NSObject {
  private var stream: VirtualOutgoingVideoStream?
  private var running = false
  private var lastSent: CFTimeInterval = 0
  private let sendGate = VideoSendGate()
  private let stateLock = NSLock()

  func attach(_ stream: VirtualOutgoingVideoStream) {
    detach()
    stateLock.lock()
    self.stream = stream
    lastSent = 0
    stateLock.unlock()
    stream.delegate = self
  }

  func send(_ pixelBuffer: CVPixelBuffer) {
    stateLock.lock()
    guard running, let stream else {
      stateLock.unlock()
      return
    }
    let fps = stream.format.framesPerSecond
    let now = CFAbsoluteTimeGetCurrent()
    if lastSent > 0, now - lastSent < 1.0 / Double(max(fps, 1)) {
      stateLock.unlock()
      return
    }
    guard let token = sendGate.acquire() else {
      stateLock.unlock()
      return
    }
    lastSent = now
    stateLock.unlock()
    let frame = RawVideoFrameBuffer()
    frame.buffer = pixelBuffer
    frame.streamFormat = stream.format
    frame.timestampInTicks = stream.timestampInTicks
    stream.send(frame: frame) { [sendGate] error in
      // Keep the source pixels alive until ACS finishes reading the frame.
      withExtendedLifetime(pixelBuffer) { frame.dispose() }
      sendGate.release(token)
      if let error { NSLog("ACS-SPIKE send frame failed: \(error)") }
    }
  }

  func detach() {
    stateLock.lock()
    running = false
    // Drop the delegate on the previous stream so a late STOPPED from a prior
    // call cannot freeze outgoing video for the current meeting.
    let previous = stream
    stream = nil
    sendGate.reset()
    stateLock.unlock()
    previous?.delegate = nil
  }
}

extension AcsFrameSender: VirtualOutgoingVideoStreamDelegate {
  func virtualOutgoingVideoStream(_ virtualOutgoingVideoStream: VirtualOutgoingVideoStream, didChangeState _: VideoStreamStateChangedEventArgs) {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard virtualOutgoingVideoStream === stream else { return }
    running = virtualOutgoingVideoStream.state == .started
    NSLog("ACS-SPIKE iOS raw video state=\(virtualOutgoingVideoStream.state)")
  }
}

// Offline generated-frame test. No SCStream, desktop capture, device or app is opened.
import AVFoundation
import AppKit
import ScreenCaptureKit

struct DriverFailure: Error { let message: String; init(_ message: String) { self.message = message } }
func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  guard condition() else { throw DriverFailure(message) }
}
func frame(at pts: CMTime, shade: UInt8, width: Int = 64, status: SCFrameStatus = .complete) throws -> CMSampleBuffer {
  var pixel: CVPixelBuffer?
  try require(CVPixelBufferCreate(kCFAllocatorDefault, width, 64, kCVPixelFormatType_32BGRA, nil, &pixel) == kCVReturnSuccess, "pixel allocation")
  CVPixelBufferLockBaseAddress(pixel!, [])
  memset(CVPixelBufferGetBaseAddress(pixel!), Int32(shade), 64 * CVPixelBufferGetBytesPerRow(pixel!))
  CVPixelBufferUnlockBaseAddress(pixel!, [])
  var format: CMVideoFormatDescription?
  try require(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixel!, formatDescriptionOut: &format) == noErr, "format")
  var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
  var sample: CMSampleBuffer?
  try require(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixel!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, "sample")
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)!
  let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
  let key = SCStreamFrameInfo.status.rawValue as NSString, value = NSNumber(value: status.rawValue)
  CFDictionarySetValue(dictionary, Unmanaged.passUnretained(key).toOpaque(), Unmanaged.passUnretained(value).toOpaque())
  return sample!
}
func finished(_ observer: RecordingObserver) async throws {
  for _ in 0 ..< 500 {
    let state = observer.state()
    if let failure = state.2 { throw DriverFailure(failure) }
    if state.1 { return }
    try await Task.sleep(for: .milliseconds(10))
  }
  throw DriverFailure("offline finalize timeout")
}
@main struct RecorderWriterTests {
  static func main() async throws {
    let directory = CommandLine.arguments[1]
    let origin = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), CMTime(seconds: 8, preferredTimescale: 60_000))
    func at(_ offset: Double) -> CMTime { CMTimeAdd(origin, CMTime(seconds: offset, preferredTimescale: 60_000)) }
    let path = directory + "/relaunch.mp4"
    let recorder = try RecordingObserver(path: path, width: 64, height: 64)
    recorder.accept(try frame(at: at(0), shade: 20), of: .screen)
    try require(recorder.state().0 && recorder.state().2 == nil, "first frame did not enter writer")
    try require(abs(recorder.state().3! - origin.seconds) < 0.0001, "first frame differs from video origin")
    do { _ = try recorder.screenshot(path: directory + "/late.png"); throw DriverFailure("delayed frame labeled fresh") }
    catch let failure as DriverFailure { try require(!failure.message.contains("delayed frame labeled fresh"), failure.message) }
    recorder.accept(try frame(at: at(3), shade: 90), of: .screen)
    recorder.invalidateSource()
    do { _ = try recorder.screenshot(path: directory + "/stale.png"); throw DriverFailure("stale screenshot accepted") }
    catch let failure as DriverFailure { try require(!failure.message.contains("stale screenshot accepted"), failure.message) }
    // An old queued callback cannot restore screenshot readiness after park.
    recorder.accept(try frame(at: at(2), shade: 100), of: .screen)
    let reattachedPTS = CMClockGetTime(CMClockGetHostTimeClock())
    let reattachedOffset = CMTimeSubtract(reattachedPTS, origin).seconds
    recorder.accept(try frame(at: reattachedPTS, shade: 180), of: .screen)
    let last = try recorder.screenshot(path: directory + "/last.png")
    try require(abs((last["frameTime"] as! Double) - reattachedOffset) < 0.0001, "reattached screenshot reset the source clock")
    recorder.finish(at: at(10))
    try await finished(recorder)
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let duration = try await asset.load(.duration).seconds
    try require(abs(duration - 10) < 0.01, "MP4 omitted the post-reattach timeline or idle tail")
    let tracks = try await asset.loadTracks(withMediaType: .video)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    try require(reader.startReading(), "reader start")
    var times: [Double] = [], pixels: [Int] = []
    while let sample = output.copyNextSampleBuffer() {
      times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
      let pixel = CMSampleBufferGetImageBuffer(sample)!
      CVPixelBufferLockBaseAddress(pixel, .readOnly)
      pixels.append(Int(CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self).pointee))
      CVPixelBufferUnlockBaseAddress(pixel, .readOnly)
    }
    try require(reader.status == .completed && times.count == 3, "encoded frames were lost")
    try require(zip(times, [0.0, 3.0, reattachedOffset]).allSatisfy { abs($0 - $1) < 0.0001 }, "source timestamps were retimed")
    try require(pixels[0] < pixels[1] && pixels[1] < pixels[2], "post-reattach image pixels were not written")

    let wrongSize = try RecordingObserver(path: directory + "/wrong-size.mp4", width: 64, height: 64)
    wrongSize.accept(try frame(at: at(0), shade: 20, width: 32), of: .screen)
    try require(wrongSize.state().2 != nil && !wrongSize.state().0, "wrong canvas accepted")
    let backwards = try RecordingObserver(path: directory + "/backwards.mp4", width: 64, height: 64)
    backwards.accept(try frame(at: at(0), shade: 20), of: .screen)
    backwards.accept(try frame(at: at(0), shade: 30), of: .screen)
    try require(backwards.state().2 != nil, "duplicate timestamp accepted")
    backwards.finish(at: at(1))
    try require(!backwards.state().1, "failed writer falsely finalized")
    print("{\"status\":\"passed\",\"scope\":\"generated frames only\",\"frames\":3,\"duration\":\(duration),\"times\":\(times),\"pixels\":\(pixels)}")
  }
}

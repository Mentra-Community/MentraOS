import Foundation

/// Background-capable, native artifact staging for hotspot OTA.
final class BackgroundOtaArtifactDownloader: NSObject, URLSessionDownloadDelegate, URLSessionTaskDelegate {
  typealias ProgressHandler = (_ destination: String, _ written: Int64, _ total: Int64) -> Void

  private struct Pending {
    let continuation: CheckedContinuation<[String: Any], Error>
  }

  private let lock = NSLock()
  private let onProgress: ProgressHandler
  private var pending: [Int: Pending] = [:]
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.background(
      withIdentifier: "com.mentra.bluetooth-sdk.hotspot-ota-artifacts"
    )
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.waitsForConnectivity = true
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  init(onProgress: @escaping ProgressHandler) {
    self.onProgress = onProgress
    super.init()
  }

  func download(from source: String, to destination: String) async throws -> [String: Any] {
    guard let sourceUrl = URL(string: source),
          sourceUrl.scheme == "https" || sourceUrl.scheme == "http"
    else {
      throw OtaServerError("Invalid artifact URL")
    }

    if FileManager.default.fileExists(atPath: destination) {
      let size = fileSize(atPath: destination)
      return ["statusCode": 200, "bytesWritten": size]
    }

    try FileManager.default.createDirectory(
      at: URL(fileURLWithPath: destination).deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    return try await withCheckedThrowingContinuation { continuation in
      let task = session.downloadTask(with: sourceUrl)
      task.taskDescription = destination
      lock.lock()
      pending[task.taskIdentifier] = Pending(continuation: continuation)
      lock.unlock()
      task.resume()
    }
  }

  func urlSession(
    _: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData _: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    guard let destination = downloadTask.taskDescription else { return }
    onProgress(destination, totalBytesWritten, totalBytesExpectedToWrite)
  }

  func urlSession(
    _: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    guard let destination = downloadTask.taskDescription else { return }
    guard let response = downloadTask.response as? HTTPURLResponse,
          (200 ... 299).contains(response.statusCode)
    else {
      let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
      reject(
        taskId: downloadTask.taskIdentifier,
        error: OtaServerError("Artifact download failed with HTTP \(status)")
      )
      return
    }
    let destinationUrl = URL(fileURLWithPath: destination)
    do {
      try? FileManager.default.removeItem(at: destinationUrl)
      try FileManager.default.moveItem(at: location, to: destinationUrl)
      let size = fileSize(atPath: destination)
      resolve(
        taskId: downloadTask.taskIdentifier,
        result: ["statusCode": response.statusCode, "bytesWritten": size]
      )
    } catch {
      reject(taskId: downloadTask.taskIdentifier, error: error)
    }
  }

  func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error {
      reject(taskId: task.taskIdentifier, error: error)
    }
  }

  private func resolve(taskId: Int, result: [String: Any]) {
    lock.lock()
    let item = pending.removeValue(forKey: taskId)
    lock.unlock()
    item?.continuation.resume(returning: result)
  }

  private func reject(taskId: Int, error: Error) {
    lock.lock()
    let item = pending.removeValue(forKey: taskId)
    lock.unlock()
    item?.continuation.resume(throwing: error)
  }

  private func fileSize(atPath path: String) -> Int64 {
    guard let value = try? FileManager.default.attributesOfItem(atPath: path)[.size],
          let number = value as? NSNumber
    else {
      return 0
    }
    return number.int64Value
  }
}

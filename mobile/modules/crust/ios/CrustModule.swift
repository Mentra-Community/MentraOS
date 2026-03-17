import ExpoModulesCore
import AVKit
import Photos

public class CrustModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Crust")

    Constant("PI") {
      Double.pi
    }

    Events("onChange")

    Function("hello") {
      return "Hello world! 👋"
    }

    AsyncFunction("setValueAsync") { (value: String) in
      self.sendEvent("onChange", [
        "value": value
      ])
    }

    Function("showAVRoutePicker") { (tintColor: String?) in
      DispatchQueue.main.async {
        let picker = AVRoutePickerView()
        picker.prioritizesVideoDevices = false

        if let colorString = tintColor {
          picker.tintColor = UIColor(hexString: colorString)
        } else {
          picker.tintColor = .label
        }

        if let button = picker.subviews.first(where: { $0 is UIButton }) as? UIButton {
          button.sendActions(for: .touchUpInside)
        }
      }
    }

    View(CrustView.self) {
      Prop("url") { (view: CrustView, url: URL) in
        if view.webView.url != url {
          view.webView.load(URLRequest(url: url))
        }
      }

      Events("onLoad")
    }

    // MARK: - Image Processing Commands

    AsyncFunction("processGalleryImage") {
      (inputPath: String, outputPath: String, options: [String: Any]) -> [String: Any] in
      let lensCorrection = options["lensCorrection"] as? Bool ?? true
      let colorCorrection = options["colorCorrection"] as? Bool ?? true

      guard FileManager.default.fileExists(atPath: inputPath) else {
        return ["success": false, "error": "Input file does not exist"]
      }

      let processingTimeMs = ImageProcessor.process(
        inputPath: inputPath,
        outputPath: outputPath,
        lensCorrection: lensCorrection,
        colorCorrection: colorCorrection
      )

      if processingTimeMs >= 0 {
        return [
          "success": true,
          "outputPath": outputPath,
          "processingTimeMs": processingTimeMs,
        ]
      } else {
        return ["success": false, "error": "Processing failed"]
      }
    }

    // MARK: - HDR Merge Commands

    AsyncFunction("mergeHdrBrackets") {
      (underPath: String, normalPath: String, overPath: String, outputPath: String)
        -> [String: Any] in
      let processingTimeMs = ImageProcessor.mergeHdr(
        underPath: underPath,
        normalPath: normalPath,
        overPath: overPath,
        outputPath: outputPath
      )
      if processingTimeMs >= 0 {
        return [
          "success": true,
          "outputPath": outputPath,
          "processingTimeMs": processingTimeMs,
        ]
      } else {
        return ["success": false, "error": "HDR merge failed"]
      }
    }

    // MARK: - Video Stabilization Commands

    AsyncFunction("stabilizeVideo") {
      (inputPath: String, imuPath: String, outputPath: String) -> [String: Any] in

      guard FileManager.default.fileExists(atPath: inputPath) else {
        return ["success": false, "error": "Input video does not exist"]
      }
      guard FileManager.default.fileExists(atPath: imuPath) else {
        return ["success": false, "error": "IMU sidecar does not exist"]
      }

      let processingTimeMs = VideoStabilizer.stabilize(
        inputPath: inputPath,
        imuPath: imuPath,
        outputPath: outputPath
      )

      if processingTimeMs >= 0 {
        return [
          "success": true,
          "outputPath": outputPath,
          "processingTimeMs": processingTimeMs,
        ]
      } else {
        return ["success": false, "error": "Stabilization failed"]
      }
    }

    // MARK: - Media Library Commands

    AsyncFunction("saveToGalleryWithDate") {
      (filePath: String, captureTimeMillis: Int64?) -> [String: Any] in
      let fileURL = URL(fileURLWithPath: filePath)

      guard FileManager.default.fileExists(atPath: filePath) else {
        return ["success": false, "error": "File does not exist"]
      }

      var assetIdentifier: String?
      let semaphore = DispatchSemaphore(value: 0)
      var resultError: Error?

      PHPhotoLibrary.shared().performChanges {
        let creationRequest: PHAssetChangeRequest
        let pathExtension = fileURL.pathExtension.lowercased()

        if ["mp4", "mov", "avi", "m4v"].contains(pathExtension) {
          creationRequest = PHAssetChangeRequest.creationRequestForAssetFromVideo(
            atFileURL: fileURL)!
        } else {
          creationRequest = PHAssetChangeRequest.creationRequestForAssetFromImage(
            atFileURL: fileURL)!
        }

        if let captureMillis = captureTimeMillis {
          let captureDate = Date(
            timeIntervalSince1970: TimeInterval(captureMillis) / 1000.0)
          creationRequest.creationDate = captureDate
          NSLog("CrustModule: Setting creation date to: \(captureDate)")
        }

        assetIdentifier = creationRequest.placeholderForCreatedAsset?.localIdentifier
      } completionHandler: { _, error in
        resultError = error
        semaphore.signal()
      }

      semaphore.wait()

      if let error = resultError {
        NSLog("CrustModule: Error saving to gallery: \(error.localizedDescription)")
        return ["success": false, "error": error.localizedDescription]
      }

      NSLog("CrustModule: Successfully saved to gallery with proper creation date")
      return ["success": true, "identifier": assetIdentifier ?? ""]
    }
  }
}

extension UIColor {
  convenience init?(hexString: String) {
    var hex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
    hex = hex.replacingOccurrences(of: "#", with: "")

    var rgb: UInt64 = 0
    guard Scanner(string: hex).scanHexInt64(&rgb) else { return nil }

    let length = hex.count
    let r, g, b, a: CGFloat

    if length == 6 {
      r = CGFloat((rgb & 0xFF0000) >> 16) / 255.0
      g = CGFloat((rgb & 0x00FF00) >> 8) / 255.0
      b = CGFloat(rgb & 0x0000FF) / 255.0
      a = 1.0
    } else if length == 8 {
      r = CGFloat((rgb & 0xFF000000) >> 24) / 255.0
      g = CGFloat((rgb & 0x00FF0000) >> 16) / 255.0
      b = CGFloat((rgb & 0x0000FF00) >> 8) / 255.0
      a = CGFloat(rgb & 0x000000FF) / 255.0
    } else {
      return nil
    }

    self.init(red: r, green: g, blue: b, alpha: a)
  }
}

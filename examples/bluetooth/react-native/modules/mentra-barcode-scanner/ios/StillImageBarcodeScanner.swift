import CoreGraphics
import Foundation
import ImageIO
import Vision

final class StillImageBarcodeScanner {
  private let imageData: Data

  init(imageData: Data) {
    self.imageData = imageData
  }

  func scan() throws -> [[String: Any]] {
    guard
      let source = CGImageSourceCreateWithData(imageData as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
      throw BarcodeScannerError("Could not decode image.")
    }

    let fullImageResults = try process(image: image, transform: ScanTransform())
    if !fullImageResults.isEmpty {
      return fullImageResults
    }

    return try scanFallbackVariants(image: image)
  }

  private func scanFallbackVariants(image: CGImage) throws -> [[String: Any]] {
    for variant in fallbackVariants {
      guard let crop = variant.crop(image: image) else {
        continue
      }

      let transform = ScanTransform(
        left: variant.left,
        top: variant.top,
        width: variant.width,
        height: variant.height
      )
      let results = try process(image: crop, transform: transform)
      if !results.isEmpty {
        NSLog("MentraBarcodeScanner: barcode decoded from fallback crop \(variant.name)")
        return results
      }
    }
    return []
  }

  private func process(image: CGImage, transform: ScanTransform) throws -> [[String: Any]] {
    let request = VNDetectBarcodesRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try handler.perform([request])
    return (request.results ?? []).map { barcodeToDictionary($0, transform: transform) }
  }

  private func barcodeToDictionary(_ observation: VNBarcodeObservation, transform: ScanTransform) -> [String: Any] {
    [
      "rawValue": observation.payloadStringValue as Any,
      "displayValue": observation.payloadStringValue as Any,
      "format": formatName(observation.symbology),
      "valueType": "TEXT",
      "bounds": transform.bounds(observation.boundingBox),
    ]
  }

  private func formatName(_ symbology: VNBarcodeSymbology) -> String {
    switch symbology {
    case .code128:
      return "CODE_128"
    case .code39:
      return "CODE_39"
    case .code93:
      return "CODE_93"
    case .codabar:
      return "CODABAR"
    case .dataMatrix:
      return "DATA_MATRIX"
    case .ean13:
      return "EAN_13"
    case .ean8:
      return "EAN_8"
    case .i2of5, .itf14:
      return "ITF"
    case .qr:
      return "QR_CODE"
    case .upce:
      return "UPC_E"
    case .pdf417:
      return "PDF417"
    case .aztec:
      return "AZTEC"
    default:
      return symbology.rawValue
    }
  }
}

private struct ScanTransform {
  let left: CGFloat
  let bottom: CGFloat
  let width: CGFloat
  let height: CGFloat

  init(left: CGFloat = 0, top: CGFloat = 0, width: CGFloat = 1, height: CGFloat = 1) {
    self.left = left
    self.bottom = 1 - top - height
    self.width = width
    self.height = height
  }

  func bounds(_ rect: CGRect) -> [String: Any] {
    [
      "x": left + rect.origin.x * width,
      "y": bottom + rect.origin.y * height,
      "width": rect.size.width * width,
      "height": rect.size.height * height,
    ]
  }

  func point(_ point: CGPoint) -> [String: Any] {
    [
      "x": left + point.x * width,
      "y": bottom + point.y * height,
    ]
  }
}

private struct CropVariant {
  let name: String
  let left: CGFloat
  let top: CGFloat
  let width: CGFloat
  let height: CGFloat
  let scale: Int

  func crop(image: CGImage) -> CGImage? {
    let rect = CGRect(
      x: left * CGFloat(image.width),
      y: top * CGFloat(image.height),
      width: width * CGFloat(image.width),
      height: height * CGFloat(image.height)
    ).integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
    guard rect.width >= 160, rect.height >= 160, let cropped = image.cropping(to: rect) else {
      return nil
    }
    guard scale > 1 else {
      return cropped
    }

    let scaledWidth = cropped.width * scale
    let scaledHeight = cropped.height * scale
    guard
      let context = CGContext(
        data: nil,
        width: scaledWidth,
        height: scaledHeight,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
      )
    else {
      return cropped
    }
    context.interpolationQuality = .none
    context.draw(cropped, in: CGRect(x: 0, y: 0, width: scaledWidth, height: scaledHeight))
    return context.makeImage() ?? cropped
  }
}

// iOS Vision already handles the barcode photos we tested in a full-frame pass.
// Keep this fallback intentionally small: it catches distant labels without adding
// the full Android crop grid's worst-case cost to every miss.
private let fallbackVariants = [
  CropVariant(name: "center-wide-2x", left: 0.12, top: 0.18, width: 0.76, height: 0.58, scale: 2),
  CropVariant(name: "upper-band-2x", left: 0.06, top: 0.10, width: 0.88, height: 0.42, scale: 2),
  CropVariant(name: "middle-band-2x", left: 0.06, top: 0.28, width: 0.88, height: 0.42, scale: 2),
  CropVariant(name: "lower-band-2x", left: 0.06, top: 0.46, width: 0.88, height: 0.42, scale: 2),
]

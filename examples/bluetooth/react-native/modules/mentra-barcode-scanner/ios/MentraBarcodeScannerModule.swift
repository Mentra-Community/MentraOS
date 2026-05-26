import CoreImage
import ExpoModulesCore
import UIKit
import Vision

public class MentraBarcodeScannerModule: Module, UIDocumentInteractionControllerDelegate {
  private var documentInteractionController: UIDocumentInteractionController?

  public func definition() -> ModuleDefinition {
    Name("MentraBarcodeScanner")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("scanImage") { (imageUri: String) -> [[String: Any]] in
      try scanImage(imageUri: imageUri)
    }

    AsyncFunction("createTestBarcodeImage") { (value: String) -> [String: Any] in
      try createTestBarcodeImage(value: value)
    }

    AsyncFunction("openImage") { (imageUri: String) in
      try openImage(imageUri: imageUri)
    }.runOnQueue(.main)
  }

  private func scanImage(imageUri: String) throws -> [[String: Any]] {
    guard let url = URL(string: imageUri) else {
      throw BarcodeScannerError("Invalid image URI.")
    }
    let data = try Data(contentsOf: url)
    guard let image = UIImage(data: data), let cgImage = image.cgImage else {
      throw BarcodeScannerError("Could not decode image.")
    }

    let request = VNDetectBarcodesRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
    try handler.perform([request])
    return (request.results ?? []).map(barcodeToDictionary)
  }

  private func createTestBarcodeImage(value: String) throws -> [String: Any] {
    let safeValue = value.isEmpty ? "MENTRA-BARCODE-12345" : value
    guard let filter = CIFilter(name: "CICode128BarcodeGenerator") else {
      throw BarcodeScannerError("Code 128 barcode generator is unavailable.")
    }
    filter.setValue(Data(safeValue.utf8), forKey: "inputMessage")
    filter.setValue(16.0, forKey: "inputQuietSpace")
    guard let outputImage = filter.outputImage else {
      throw BarcodeScannerError("Could not generate barcode image.")
    }

    let scaledImage = outputImage.transformed(by: CGAffineTransform(scaleX: 3, y: 3))
    let context = CIContext()
    guard let cgImage = context.createCGImage(scaledImage, from: scaledImage.extent) else {
      throw BarcodeScannerError("Could not render barcode image.")
    }
    guard let pngData = UIImage(cgImage: cgImage).pngData() else {
      throw BarcodeScannerError("Could not encode barcode image.")
    }

    let fileUrl = FileManager.default.temporaryDirectory
      .appendingPathComponent("mentra-barcode-test-\(UUID().uuidString).png")
    try pngData.write(to: fileUrl, options: .atomic)
    return [
      "fileUri": fileUrl.absoluteString,
      "value": safeValue,
      "byteCount": pngData.count,
    ]
  }

  private func openImage(imageUri: String) throws {
    guard let url = URL(string: imageUri) else {
      throw BarcodeScannerError("Invalid image URI.")
    }
    if !url.isFileURL {
      UIApplication.shared.open(url)
      return
    }
    guard let viewController = appContext?.utilities?.currentViewController() else {
      throw BarcodeScannerError("Could not find a view controller to open the image.")
    }
    let controller = UIDocumentInteractionController(url: url)
    controller.delegate = self
    documentInteractionController = controller
    if !controller.presentPreview(animated: true) {
      if !controller.presentOptionsMenu(from: viewController.view.bounds, in: viewController.view, animated: true) {
        throw BarcodeScannerError("No image viewer is available for this file.")
      }
    }
  }

  private func barcodeToDictionary(_ observation: VNBarcodeObservation) -> [String: Any] {
    var result: [String: Any] = [
      "rawValue": observation.payloadStringValue as Any,
      "displayValue": observation.payloadStringValue as Any,
      "format": formatName(observation.symbology),
      "valueType": "TEXT",
      "bounds": [
        "x": observation.boundingBox.origin.x,
        "y": observation.boundingBox.origin.y,
        "width": observation.boundingBox.size.width,
        "height": observation.boundingBox.size.height,
      ],
    ]
    if !observation.cornerPoints.isEmpty {
      result["cornerPoints"] = observation.cornerPoints.map { point in
        [
          "x": point.x,
          "y": point.y,
        ]
      }
    }
    return result
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

  public func documentInteractionControllerViewControllerForPreview(
    _ controller: UIDocumentInteractionController
  ) -> UIViewController {
    appContext?.utilities?.currentViewController() ?? UIViewController()
  }
}

final class BarcodeScannerError: Exception, @unchecked Sendable {
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}

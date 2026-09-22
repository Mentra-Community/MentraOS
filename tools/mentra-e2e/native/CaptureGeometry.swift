import CoreGraphics

struct WindowCapturePlacement {
  let displayIndex: Int
  let sourceRect: CGRect
}

func windowCapturePlacement(window: CGRect, displays: [CGRect]) throws -> WindowCapturePlacement {
  guard window.minX.isFinite, window.minY.isFinite, window.width.isFinite, window.height.isFinite,
        window.width > 0, window.height > 0 else { throw DriverFailure("Invalid capture window geometry") }
  let matches = displays.indices.filter { displays[$0].contains(window) }
  guard matches.count == 1, let index = matches.first else {
    throw DriverFailure("Keep the entire Mentra window on one display while recording")
  }
  return WindowCapturePlacement(displayIndex: index,
                                sourceRect: window.offsetBy(dx: -displays[index].minX, dy: -displays[index].minY))
}

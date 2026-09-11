import UIKit

/// Lets JS override `preferredScreenEdgesDeferringSystemGestures` on the
/// app's root view controllers. iOS 11+ requires a swipe across a screen
/// edge to first be "deferred" before the system gesture (Control Center,
/// Notification Center, Home indicator) fires — useful when an app wants
/// the user to confirm before backgrounding, e.g. a two-swipe exit.
///
/// Implemented via method swizzling because Expo creates the root view
/// controller internally — there is no host code path to subclass it
/// without forking ExpoModulesCore. The swizzle is installed lazily on
/// first call and is idempotent.
enum SystemGestures {
    /// Edges to defer. `[]` means default behavior (system gestures fire
    /// on first swipe). Read by the swizzled getter on every gesture.
    static var deferredEdges: UIRectEdge = []

    private static var swizzled = false

    static func setDeferredEdges(_ edges: UIRectEdge) {
        installSwizzleIfNeeded()
        deferredEdges = edges
        DispatchQueue.main.async {
            for scene in UIApplication.shared.connectedScenes {
                guard let windowScene = scene as? UIWindowScene else { continue }
                for window in windowScene.windows {
                    window.rootViewController?.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
                }
            }
        }
    }

    private static func installSwizzleIfNeeded() {
        guard !swizzled else { return }
        swizzled = true

        let cls: AnyClass = UIViewController.self
        let originalSel = #selector(getter: UIViewController.preferredScreenEdgesDeferringSystemGestures)
        let swizzledSel = #selector(getter: UIViewController.crust_preferredScreenEdgesDeferringSystemGestures)

        guard let original = class_getInstanceMethod(cls, originalSel),
              let replacement = class_getInstanceMethod(cls, swizzledSel)
        else { return }

        method_exchangeImplementations(original, replacement)
    }
}

extension UIViewController {
    @objc var crust_preferredScreenEdgesDeferringSystemGestures: UIRectEdge {
        SystemGestures.deferredEdges
    }
}

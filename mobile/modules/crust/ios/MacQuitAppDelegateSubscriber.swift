import ExpoModulesCore
import Foundation

/// Lets the iOS app on a Mac quit without running C++ static destructors.
///
/// Quitting the Mac app runs `-[NSApplication terminate:]`, which calls `exit()`.
/// `exit()` destroys C++ statics while React Native's threads are still running,
/// so a network response that lands during quit locks React Native's
/// already-destroyed `NetworkReporter` mutex. That throws `std::system_error`, and
/// Sentry's terminate handler (sentry-cocoa 8.58) suspends every thread before
/// it reads dyld's image list. The suspended main thread holds dyld's loader lock
/// inside `exit()`, so the handler waits forever. The app stays alive and hidden,
/// still connected to the glasses, until someone kills it.
///
/// On the Mac, once `applicationWillTerminate` has run, nothing is left to do but
/// exit, so the last `atexit` handler registered here ends the process with
/// `_exit` before any static destructor runs. `exit()` calls handlers in reverse
/// order of registration, so registering this last makes it run first. The
/// process exiting closes its Bluetooth connections.
public class MacQuitAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func applicationWillTerminate(_ application: UIApplication) {
    guard ProcessInfo.processInfo.isiOSAppOnMac else { return }
    NSLog("MacQuit: skipping static destructors on exit")
    atexit {
      fflush(nil)
      _exit(0)
    }
  }
}

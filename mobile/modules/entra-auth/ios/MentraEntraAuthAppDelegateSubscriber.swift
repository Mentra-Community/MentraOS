import ExpoModulesCore
import MSAL

public class MentraEntraAuthAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    let sourceApplication = options[.sourceApplication] as? String
    return MSALPublicClientApplication.handleMSALResponse(url, sourceApplication: sourceApplication)
  }
}

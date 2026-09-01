import ExpoModulesCore
import MSAL

public final class MentraEntraAuthModule: Module {
    private var application: MSALPublicClientApplication?
    private var applicationKey: String?

    public func definition() -> ModuleDefinition {
        Name("MentraEntraAuth")

        AsyncFunction("getAccount") { (configuration: [String: String], promise: Promise) in
            do {
                let app = try self.getApplication(configuration)
                try promise.resolve(self.singleAccount(app).map(self.accountMap))
            } catch {
                promise.reject("ENTRA_ERROR", error.localizedDescription)
            }
        }

        AsyncFunction("signIn") { (configuration: [String: String], scopes: [String], promise: Promise) in
            do {
                let app = try self.getApplication(configuration)
                guard let viewController = self.appContext?.utilities?.currentViewController() else {
                    promise.reject("ENTRA_NO_VIEW_CONTROLLER", "No foreground view controller is available")
                    return
                }
                let webParameters = MSALWebviewParameters(authPresentationViewController: viewController)
                let parameters = MSALInteractiveTokenParameters(scopes: scopes, webviewParameters: webParameters)
                app.acquireToken(with: parameters) { result, error in
                    if let account = result?.account {
                        do {
                            try self.removeOtherAccounts(app, keeping: account)
                        } catch {
                            promise.reject("ENTRA_CACHE_ERROR", error.localizedDescription)
                            return
                        }
                    }
                    self.resolveToken(result: result, error: error, promise: promise)
                }
            } catch {
                promise.reject("ENTRA_ERROR", error.localizedDescription)
            }
        }
        .runOnQueue(.main)

        AsyncFunction("acquireToken") {
            (configuration: [String: String], scopes: [String], forceRefresh: Bool?, promise: Promise) in
            do {
                let app = try self.getApplication(configuration)
                guard let account = try self.singleAccount(app) else {
                    promise.reject("ENTRA_NO_ACCOUNT", "No Microsoft account is signed in")
                    return
                }
                let parameters = MSALSilentTokenParameters(scopes: scopes, account: account)
                parameters.forceRefresh = forceRefresh ?? false
                app.acquireTokenSilent(with: parameters) { result, error in
                    self.resolveToken(result: result, error: error, promise: promise)
                }
            } catch {
                promise.reject("ENTRA_ERROR", error.localizedDescription)
            }
        }

        AsyncFunction("signOut") { (configuration: [String: String], promise: Promise) in
            do {
                let app = try self.getApplication(configuration)
                for account in try app.allAccounts() {
                    try app.remove(account)
                }
                promise.resolve(nil)
            } catch {
                promise.reject("ENTRA_ERROR", error.localizedDescription)
            }
        }
    }

    /// The workspace auth contract is intentionally single-account. Refuse an
    /// ambiguous cache instead of silently choosing another employee.
    private func singleAccount(_ app: MSALPublicClientApplication) throws -> MSALAccount? {
        let accounts = try app.allAccounts()
        guard accounts.count <= 1 else {
            throw NSError(domain: "MentraEntraAuth", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Multiple Microsoft accounts are cached; sign in again to select the workspace account",
            ])
        }
        return accounts.first
    }

    private func removeOtherAccounts(_ app: MSALPublicClientApplication, keeping selected: MSALAccount) throws {
        for account in try app.allAccounts() where account.identifier != selected.identifier {
            try app.remove(account)
        }
    }

    private func getApplication(_ configuration: [String: String]) throws -> MSALPublicClientApplication {
        guard let clientId = configuration["clientId"], !clientId.isEmpty,
              let authorityUrl = configuration["authorityUrl"], let url = URL(string: authorityUrl)
        else {
            throw NSError(domain: "MentraEntraAuth", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "clientId and authorityUrl are required",
            ])
        }
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.mentra.mentra"
        let key = "\(clientId)|\(authorityUrl)|\(bundleIdentifier)"
        if let application, applicationKey == key {
            return application
        }
        let authority = try MSALAADAuthority(url: url)
        let redirectUri = "msauth.\(bundleIdentifier)://auth"
        let config = MSALPublicClientApplicationConfig(
            clientId: clientId,
            redirectUri: redirectUri,
            authority: authority
        )
        let created = try MSALPublicClientApplication(configuration: config)
        application = created
        applicationKey = key
        return created
    }

    private func resolveToken(result: MSALResult?, error: Error?, promise: Promise) {
        if let error {
            promise.reject("ENTRA_ERROR", error.localizedDescription)
            return
        }
        guard let result else {
            promise.reject("ENTRA_EMPTY_RESULT", "Microsoft authentication returned no result")
            return
        }
        var response = accountMap(result.account)
        response["accessToken"] = result.accessToken
        response["expiresAt"] = (result.expiresOn?.timeIntervalSince1970 ?? 0) * 1000
        response["scopes"] = result.scopes
        promise.resolve(response)
    }

    private func accountMap(_ account: MSALAccount) -> [String: Any?] {
        let profile = account.tenantProfiles?.first
        let claims = profile?.claims
        return [
            "accountId": account.identifier ?? "",
            "subject": claims?["oid"] as? String ?? account.identifier ?? "",
            "tenantId": claims?["tid"] as? String ?? profile?.tenantId ?? "",
            "username": account.username,
            "displayName": claims?["name"] as? String,
        ]
    }
}

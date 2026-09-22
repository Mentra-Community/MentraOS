package com.mentra.entraauth

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.net.Uri
import com.microsoft.identity.client.AcquireTokenParameters
import com.microsoft.identity.client.AcquireTokenSilentParameters
import com.microsoft.identity.client.AuthenticationCallback
import com.microsoft.identity.client.IAccount
import com.microsoft.identity.client.IAuthenticationResult
import com.microsoft.identity.client.IPublicClientApplication
import com.microsoft.identity.client.ISingleAccountPublicClientApplication
import com.microsoft.identity.client.PublicClientApplication
import com.microsoft.identity.client.SilentAuthenticationCallback
import com.microsoft.identity.client.exception.MsalException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

class MentraEntraAuthModule : Module() {
  private var application: ISingleAccountPublicClientApplication? = null
  private var applicationKey: String? = null

  override fun definition() = ModuleDefinition {
    Name("MentraEntraAuth")

    AsyncFunction("getAccount") { configuration: Map<String, String>, promise: Promise ->
      withApplication(configuration, promise) { app ->
        withCurrentAccount(app, promise) { account -> promise.resolve(account?.let(::accountMap)) }
      }
    }

    AsyncFunction("signIn") { configuration: Map<String, String>, scopes: List<String>, promise: Promise ->
      withApplication(configuration, promise) { app ->
        val activity = appContext.currentActivity
        if (activity == null) {
          promise.reject("ENTRA_NO_ACTIVITY", "No foreground activity is available", null)
          return@withApplication
        }
        val parameters = AcquireTokenParameters.Builder()
          .startAuthorizationFromActivity(activity)
          .withScopes(scopes)
          .withCallback(interactiveCallback(promise))
          .build()
        app.acquireToken(parameters)
      }
    }

    AsyncFunction("acquireToken") {
        configuration: Map<String, String>, scopes: List<String>, forceRefresh: Boolean?, promise: Promise ->
      withApplication(configuration, promise) { app ->
        withCurrentAccount(app, promise) { account ->
          acquireSilent(app, configuration, account, scopes, forceRefresh == true, promise)
        }
      }
    }

    AsyncFunction("signOut") { configuration: Map<String, String>, promise: Promise ->
      withApplication(configuration, promise) { app ->
        app.signOut(object : ISingleAccountPublicClientApplication.SignOutCallback {
          override fun onSignOut() {
            promise.resolve(null)
          }

          override fun onError(exception: MsalException) {
            reject(promise, exception)
          }
        })
      }
    }
  }

  /**
   * MSAL may report both the initially loaded account and a subsequent account
   * change through the same callback. An Expo promise/token request is one-shot,
   * so accept only the first terminal callback for this invocation.
   */
  private fun withCurrentAccount(
    app: ISingleAccountPublicClientApplication,
    promise: Promise,
    block: (IAccount?) -> Unit,
  ) {
    val completed = AtomicBoolean(false)
    app.getCurrentAccountAsync(object : ISingleAccountPublicClientApplication.CurrentAccountCallback {
      private fun deliver(account: IAccount?) {
        if (completed.compareAndSet(false, true)) block(account)
      }

      override fun onAccountLoaded(activeAccount: IAccount?) = deliver(activeAccount)

      override fun onAccountChanged(priorAccount: IAccount?, currentAccount: IAccount?) = deliver(currentAccount)

      override fun onError(exception: MsalException) {
        if (completed.compareAndSet(false, true)) reject(promise, exception)
      }
    })
  }

  private fun withApplication(
    configuration: Map<String, String>,
    promise: Promise,
    block: (ISingleAccountPublicClientApplication) -> Unit,
  ) {
    val context = appContext.reactContext?.applicationContext
    if (context == null) {
      promise.reject("ENTRA_NO_CONTEXT", "Application context is unavailable", null)
      return
    }
    val clientId = configuration["clientId"]
    val authorityUrl = configuration["authorityUrl"]
    if (clientId.isNullOrBlank() || authorityUrl.isNullOrBlank()) {
      promise.reject("ENTRA_INVALID_CONFIG", "clientId and authorityUrl are required", null)
      return
    }
    val key = "$clientId|$authorityUrl|${context.packageName}"
    val cached = application
    if (cached != null && applicationKey == key) {
      block(cached)
      return
    }

    val configFile = writeConfiguration(context, clientId, authorityUrl)
    PublicClientApplication.createSingleAccountPublicClientApplication(
      context,
      configFile,
      object : IPublicClientApplication.ISingleAccountApplicationCreatedListener {
        override fun onCreated(created: ISingleAccountPublicClientApplication) {
          application = created
          applicationKey = key
          block(created)
        }

        override fun onError(exception: MsalException) {
          reject(promise, exception)
        }
      },
    )
  }

  private fun writeConfiguration(context: Context, clientId: String, authorityUrl: String): File {
    val tenantId = Uri.parse(authorityUrl).pathSegments.firstOrNull()
      ?: throw IllegalArgumentException("authorityUrl must include a tenant")
    val redirectUri = "msauth://${context.packageName}/${Uri.encode(signatureHash(context))}"
    val audience = JSONObject()
      .put("type", "AzureADMyOrg")
      .put("tenant_id", tenantId)
    val authority = JSONObject()
      .put("type", "AAD")
      .put("audience", audience)
      .put("default", true)
    val json = JSONObject()
      .put("client_id", clientId)
      .put("redirect_uri", redirectUri)
      .put("account_mode", "SINGLE")
      .put("authorization_user_agent", "DEFAULT")
      .put("broker_redirect_uri_registered", true)
      .put("authorities", JSONArray().put(authority))
    val file = File(context.cacheDir, "mentra-entra-${clientId}.json")
    file.writeText(json.toString())
    return file
  }

  private fun signatureHash(context: Context): String {
    val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
    }
    val signature = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.signingInfo?.apkContentsSigners?.firstOrNull()
    } else {
      @Suppress("DEPRECATION")
      packageInfo.signatures?.firstOrNull()
    } ?: throw IllegalStateException("Unable to read the application signing certificate")
    val digest = MessageDigest.getInstance("SHA").digest(signature.toByteArray())
    return Base64.encodeToString(digest, Base64.NO_WRAP)
  }

  private fun interactiveCallback(promise: Promise) = object : AuthenticationCallback {
    override fun onSuccess(authenticationResult: IAuthenticationResult) {
      promise.resolve(tokenMap(authenticationResult))
    }

    override fun onError(exception: MsalException) {
      reject(promise, exception)
    }

    override fun onCancel() {
      promise.reject("ENTRA_CANCELLED", "Microsoft sign-in was cancelled", null)
    }
  }

  private fun acquireSilent(
    app: ISingleAccountPublicClientApplication,
    configuration: Map<String, String>,
    account: IAccount?,
    scopes: List<String>,
    forceRefresh: Boolean,
    promise: Promise,
  ) {
    if (account == null) {
      promise.reject("ENTRA_NO_ACCOUNT", "No Microsoft account is signed in", null)
      return
    }
    val parameters = AcquireTokenSilentParameters.Builder()
      .forAccount(account)
      .withScopes(scopes)
      .fromAuthority(configuration.getValue("authorityUrl"))
      .forceRefresh(forceRefresh)
      .withCallback(object : SilentAuthenticationCallback {
        override fun onSuccess(authenticationResult: IAuthenticationResult) {
          promise.resolve(tokenMap(authenticationResult))
        }

        override fun onError(exception: MsalException) {
          reject(promise, exception)
        }
      })
      .build()
    app.acquireTokenSilentAsync(parameters)
  }

  private fun tokenMap(result: IAuthenticationResult): Map<String, Any?> =
    accountMap(result.account) + mapOf(
      "accessToken" to result.accessToken,
      "expiresAt" to result.expiresOn.time,
      "scopes" to result.scope.toList(),
    )

  private fun accountMap(account: IAccount): Map<String, Any?> {
    val claims = account.claims ?: emptyMap()
    return mapOf(
      "accountId" to account.id,
      "subject" to (claims["oid"]?.toString() ?: account.id),
      "tenantId" to (claims["tid"]?.toString() ?: account.tenantId),
      "username" to account.username,
      "displayName" to claims["name"]?.toString(),
    )
  }

  private fun reject(promise: Promise, exception: MsalException) {
    promise.reject(exception.errorCode ?: "ENTRA_ERROR", exception.message ?: "Microsoft authentication failed", exception)
  }
}

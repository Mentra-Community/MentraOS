package com.mentra.asg_client.utils;

import android.annotation.SuppressLint;
import android.util.Log;

import java.net.Socket;
import java.security.KeyStore;
import java.security.cert.CertPath;
import java.security.cert.CertPathValidator;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.PKIXParameters;
import java.security.cert.TrustAnchor;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;

/**
 * OkHttp TLS setup for incident log uploads from glasses.
 *
 * <p>Uses system trust anchors and full chain validation via {@link CertPathValidator}, but
 * disables PKIX revocation (OCSP/CRL) so TLS can complete on builds where OCSP is flaky.</p>
 */
@SuppressLint("CustomX509TrustManager")
public final class IncidentUploadOkHttp {

  private static final String TAG = "IncidentUploadOkHttp";

  private IncidentUploadOkHttp() {}

  /**
   * Applies a custom {@link SSLContext} to the builder. On failure, logs and leaves the builder
   * unchanged (platform defaults).
   */
  public static void applyRelaxedRevocation(OkHttpClient.Builder builder) {
    try {
      TrustManagerFactory tmf = TrustManagerFactory.getInstance(
          TrustManagerFactory.getDefaultAlgorithm());
      tmf.init((KeyStore) null);

      X509TrustManager trustManager = buildTrustManagerWithoutRevocation(tmf);
      SSLContext sslContext = SSLContext.getInstance("TLS");
      sslContext.init(null, new TrustManager[]{trustManager}, null);
      builder.sslSocketFactory(sslContext.getSocketFactory(), trustManager);
    } catch (Exception e) {
      Log.w(TAG, "Could not apply relaxed-revocation TLS; using platform defaults", e);
    }
  }

  private static X509TrustManager buildTrustManagerWithoutRevocation(TrustManagerFactory tmf)
      throws Exception {
    for (TrustManager tm : tmf.getTrustManagers()) {
      if (tm instanceof X509ExtendedTrustManager) {
        return wrapExtended((X509ExtendedTrustManager) tm);
      }
    }
    for (TrustManager tm : tmf.getTrustManagers()) {
      if (tm instanceof X509TrustManager) {
        return wrapBasic((X509TrustManager) tm);
      }
    }
    throw new IllegalStateException("No X509TrustManager from TrustManagerFactory");
  }

  private static X509TrustManager wrapExtended(final X509ExtendedTrustManager delegate) {
    return new X509ExtendedTrustManager() {
      @Override
      public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket)
          throws CertificateException {
        delegate.checkClientTrusted(chain, authType, socket);
      }

      @Override
      public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine)
          throws CertificateException {
        delegate.checkClientTrusted(chain, authType, engine);
      }

      @Override
      public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket)
          throws CertificateException {
        checkServerTrustedNoRevocation(chain, authType, delegate);
      }

      @Override
      public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine)
          throws CertificateException {
        checkServerTrustedNoRevocation(chain, authType, delegate);
      }

      @Override
      public void checkClientTrusted(X509Certificate[] chain, String authType)
          throws CertificateException {
        delegate.checkClientTrusted(chain, authType);
      }

      @Override
      public void checkServerTrusted(X509Certificate[] chain, String authType)
          throws CertificateException {
        checkServerTrustedNoRevocation(chain, authType, delegate);
      }

      @Override
      public X509Certificate[] getAcceptedIssuers() {
        return delegate.getAcceptedIssuers();
      }
    };
  }

  private static X509TrustManager wrapBasic(final X509TrustManager delegate) {
    return new X509TrustManager() {
      @Override
      public void checkClientTrusted(X509Certificate[] chain, String authType)
          throws CertificateException {
        delegate.checkClientTrusted(chain, authType);
      }

      @Override
      public void checkServerTrusted(X509Certificate[] chain, String authType)
          throws CertificateException {
        checkServerTrustedNoRevocation(chain, authType, delegate);
      }

      @Override
      public X509Certificate[] getAcceptedIssuers() {
        return delegate.getAcceptedIssuers();
      }
    };
  }

  private static void checkServerTrustedNoRevocation(
      X509Certificate[] chain, String authType, X509TrustManager platformTm)
      throws CertificateException {
    if (chain == null || chain.length == 0) {
      throw new CertificateException("Empty server chain");
    }

    // Let the platform delegate validate first (CA store, pinning, etc.).
    // Only bypass revocation if that is the specific reason for failure.
    try {
      platformTm.checkServerTrusted(chain, authType);
      return;
    } catch (CertificateException e) {
      String msg = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
      boolean isRevocationFailure = msg.contains("revoc") || msg.contains("ocsp") || msg.contains("crl");
      if (!isRevocationFailure) {
        throw e;
      }
      // Fall through to PKIX validation with revocation disabled.
    }

    X509Certificate[] trustedChain = platformTm.getAcceptedIssuers();
    Set<TrustAnchor> anchors = new HashSet<>();
    for (X509Certificate ca : trustedChain) {
      anchors.add(new TrustAnchor(ca, null));
    }
    try {
      CertificateFactory cf = CertificateFactory.getInstance("X.509");
      CertPath certPath = cf.generateCertPath(Arrays.asList(chain));
      PKIXParameters params = new PKIXParameters(anchors);
      params.setRevocationEnabled(false);
      CertPathValidator.getInstance("PKIX").validate(certPath, params);
    } catch (Exception e) {
      throw new CertificateException("Trust chain validation failed", e);
    }
  }
}

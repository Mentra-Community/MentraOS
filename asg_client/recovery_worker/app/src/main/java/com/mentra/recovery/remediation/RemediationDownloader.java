package com.mentra.recovery.remediation;

import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Downloads the remediation APK fresh (always overwriting any prior file, so the ASG OTA cache is
 * bypassed implicitly) and verifies its SHA-256 against the manifest before allowing install.
 */
public class RemediationDownloader {

  /**
   * Downloads {@code policy.apkUrl} to {@link RecoveryConstants#REMEDIATION_APK_PATH} and verifies
   * the SHA-256. Returns {@code true} only on a verified file; deletes the file on any failure.
   */
  public boolean download(RemediationPolicy policy) {
    if (policy == null) {
      return false;
    }
    File target = new File(RecoveryConstants.REMEDIATION_APK_PATH);
    deleteQuietly(target);

    File parent = target.getParentFile();
    if (parent != null && !parent.exists()) {
      parent.mkdirs();
    }

    HttpURLConnection conn = null;
    try {
      conn = (HttpURLConnection) new URL(policy.apkUrl).openConnection();
      conn.setConnectTimeout(RecoveryConstants.REMEDIATION_CONNECT_TIMEOUT_MS);
      conn.setReadTimeout(RecoveryConstants.REMEDIATION_READ_TIMEOUT_MS);
      conn.setRequestMethod("GET");
      conn.connect();
      int code = conn.getResponseCode();
      if (code < 200 || code >= 300) {
        Log.e(RecoveryConstants.TAG, "Remediation APK download HTTP " + code);
        return false;
      }
      try (InputStream is = conn.getInputStream();
          FileOutputStream fos = new FileOutputStream(target)) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = is.read(buffer)) != -1) {
          fos.write(buffer, 0, read);
        }
        fos.flush();
      }
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to download remediation APK", e);
      deleteQuietly(target);
      return false;
    } finally {
      if (conn != null) {
        conn.disconnect();
      }
    }

    if (!verifySha256(target, policy.sha256)) {
      Log.e(RecoveryConstants.TAG, "Remediation APK SHA-256 mismatch; deleting");
      deleteQuietly(target);
      return false;
    }
    return true;
  }

  /** SHA-256 integrity check mirroring ASG OtaHelper.verifyApkFile. */
  private boolean verifySha256(File apkFile, String expectedHash) {
    if (expectedHash == null || expectedHash.isEmpty()) {
      Log.e(RecoveryConstants.TAG, "No SHA-256 provided for remediation APK - rejecting");
      return false;
    }
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] buffer = new byte[8192];
      int read;
      try (FileInputStream is = new FileInputStream(apkFile)) {
        while ((read = is.read(buffer)) > 0) {
          digest.update(buffer, 0, read);
        }
      }
      byte[] hashBytes = digest.digest();
      StringBuilder sb = new StringBuilder(hashBytes.length * 2);
      for (byte b : hashBytes) {
        sb.append(String.format("%02x", b));
      }
      String calculated = sb.toString();
      boolean match = calculated.equalsIgnoreCase(expectedHash);
      Log.d(RecoveryConstants.TAG, "Remediation APK SHA-256 check " + (match ? "passed" : "failed"));
      return match;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Remediation APK SHA-256 check error", e);
      return false;
    }
  }

  private void deleteQuietly(File file) {
    if (file != null && file.exists()) {
      if (!file.delete()) {
        Log.w(RecoveryConstants.TAG, "Could not delete " + file.getAbsolutePath());
      }
    }
  }
}

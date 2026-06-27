package com.mentra.recovery.remediation;

import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Fetches the OTA manifest directly and extracts the {@code remediation} policy. */
public class RemediationManifestClient {

  /** GETs the manifest JSON, or returns {@code null} on any network/parse failure. */
  public JSONObject fetchManifest() {
    HttpURLConnection conn = null;
    try {
      conn = (HttpURLConnection) new URL(RecoveryConstants.VERSION_JSON_URL).openConnection();
      conn.setConnectTimeout(RecoveryConstants.REMEDIATION_CONNECT_TIMEOUT_MS);
      conn.setReadTimeout(RecoveryConstants.REMEDIATION_READ_TIMEOUT_MS);
      conn.setRequestMethod("GET");
      conn.connect();
      int code = conn.getResponseCode();
      if (code < 200 || code >= 300) {
        Log.e(RecoveryConstants.TAG, "Manifest fetch HTTP " + code);
        return null;
      }
      StringBuilder body = new StringBuilder();
      try (InputStream is = conn.getInputStream();
          BufferedReader reader =
              new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
        String line;
        while ((line = reader.readLine()) != null) {
          body.append(line);
        }
      }
      return new JSONObject(body.toString());
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to fetch remediation manifest", e);
      return null;
    } finally {
      if (conn != null) {
        conn.disconnect();
      }
    }
  }

  /** Returns the parsed {@code remediation} policy, or {@code null} when absent/malformed. */
  public RemediationPolicy parseRemediation(JSONObject root) {
    if (root == null) {
      return null;
    }
    JSONObject remediation = root.optJSONObject("remediation");
    if (remediation == null) {
      return null;
    }
    return RemediationPolicy.fromJson(remediation);
  }

  /** Convenience: fetch + parse in one call. */
  public RemediationPolicy fetchPolicy() {
    return parseRemediation(fetchManifest());
  }
}

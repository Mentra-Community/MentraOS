package com.mentra.recovery;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.mentra.recovery.remediation.RemediationPolicy;

import org.json.JSONObject;
import org.junit.Test;

public class RemediationPolicyTest {

  @Test
  public void parsesFullBlock() throws Exception {
    JSONObject json =
        new JSONObject(
            "{"
                + "\"enabled\":true,"
                + "\"packageName\":\"com.mentra.asg_client\","
                + "\"maxVersionCode\":38,"
                + "\"versionCode\":39,"
                + "\"versionName\":\"39.0\","
                + "\"apkUrl\":\"https://example.com/asg-client-39.apk\","
                + "\"sha256\":\"deadbeef\""
                + "}");
    RemediationPolicy policy = RemediationPolicy.fromJson(json);
    assertNotNull(policy);
    assertTrue(policy.enabled);
    assertEquals("com.mentra.asg_client", policy.packageName);
    assertEquals(38L, policy.maxVersionCode);
    assertEquals(39L, policy.versionCode);
    assertEquals("39.0", policy.versionName);
    assertEquals("https://example.com/asg-client-39.apk", policy.apkUrl);
    assertEquals("deadbeef", policy.sha256);
  }

  @Test
  public void defaultsPackageNameAndDisabled() throws Exception {
    JSONObject json =
        new JSONObject(
            "{\"maxVersionCode\":38,\"versionCode\":39,"
                + "\"apkUrl\":\"https://example.com/a.apk\",\"sha256\":\"ab\"}");
    RemediationPolicy policy = RemediationPolicy.fromJson(json);
    assertNotNull(policy);
    assertFalse(policy.enabled);
    assertEquals("com.mentra.asg_client", policy.packageName);
  }

  @Test
  public void returnsNullWhenApkUrlMissing() throws Exception {
    JSONObject json = new JSONObject("{\"enabled\":true,\"versionCode\":39,\"sha256\":\"ab\"}");
    assertNull(RemediationPolicy.fromJson(json));
  }

  @Test
  public void returnsNullWhenSha256Missing() throws Exception {
    JSONObject json =
        new JSONObject("{\"enabled\":true,\"versionCode\":39,\"apkUrl\":\"https://x/a.apk\"}");
    assertNull(RemediationPolicy.fromJson(json));
  }

  @Test
  public void returnsNullForNull() {
    assertNull(RemediationPolicy.fromJson(null));
  }
}

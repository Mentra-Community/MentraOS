package com.mentra.recovery.downgrade;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import com.mentra.recovery.util.RecoveryConstants;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class DowngradeOwnershipTest {
  Context context;
  DowngradeTransactionStore store;
  @Before public void setup() {
    context = RuntimeEnvironment.getApplication();
    store = new DowngradeTransactionStore(context);
    store.clear();
  }
  @Test public void transactionAndTerminalIdentitySurviveNewStoreInstance() {
    assertTrue(store.begin("attempt-a", 302010058L, "/tmp/staged.txn", "sha"));
    DowngradeTransactionStore restarted = new DowngradeTransactionStore(context);
    assertTrue(restarted.snapshot().getBoolean("active"));
    assertEquals("attempt-a", restarted.getRequestId());
    assertEquals(302010058L, restarted.snapshot().getLong("target_version"));
    assertTrue(restarted.finish("converged"));
    assertFalse(new DowngradeTransactionStore(context).isActive());
    assertEquals("attempt-a", store.snapshot().getString("transaction_id"));
    assertEquals("converged", store.snapshot().getString("terminal_reason"));
  }
  @Test public void duplicatePinReportsOwnershipWithoutClaimingOrReplacingArtifact() {
    store.begin("original", 302010058L, "/tmp/owned.txn", "sha");
    store.incrementInstallAttempts();
    DowngradeController.requestDowngrade(context, "retry", 302010058L, "/missing/retry.apk", "SHA");
    assertEquals("original", store.getRequestId());
    assertEquals("/tmp/owned.txn", store.getApkPath());
    assertEquals(1, store.getInstallAttempts());
    Intent reply = lastVerdict();
    assertTrue(reply.getBooleanExtra(RecoveryConstants.EXTRA_HANDOFF_ACCEPTED, false));
    assertEquals("retry", reply.getStringExtra(RecoveryConstants.EXTRA_REQUEST_ID));
  }
  @Test public void conflictingPinCannotReplaceActiveTransaction() {
    store.begin("original", 302010058L, "/tmp/owned.txn", "sha");
    DowngradeController.requestDowngrade(context, "conflict", 302010059L, "/missing/retry.apk", "other");
    assertEquals("original", store.getRequestId());
    assertEquals(302010058L, store.getTargetVersion());
    assertFalse(lastVerdict().getBooleanExtra(RecoveryConstants.EXTRA_HANDOFF_ACCEPTED, true));
  }
  private Intent lastVerdict() {
    return Shadows.shadowOf((android.app.Application) context).getBroadcastIntents().stream()
        .filter(i -> RecoveryConstants.ACTION_DOWNGRADE_HANDOFF_RESULT.equals(i.getAction()))
        .reduce((first, second) -> second).orElseThrow();
  }
}

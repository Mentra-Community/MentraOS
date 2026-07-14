package com.mentra.recovery.install;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

public class AsgInstallTransactionStoreTest {
  @Test
  public void parsesModernManifestMetadata() {
    assertEquals(48_332_721L, AsgInstallTransactionStore.parseMetadata("asg-48332721"));
    assertEquals(48_332_721L, AsgInstallTransactionStore.parseMetadata(48_332_721L));
  }

  @Test
  public void rejectsInvalidMetadata() {
    assertEquals(-1L, AsgInstallTransactionStore.parseMetadata("asg-invalid"));
    assertEquals(-1L, AsgInstallTransactionStore.parseMetadata(null));
  }

  @Test
  public void hashesPendingArtifactBytes() throws Exception {
    File apk = Files.createTempFile("asg-target", ".apk").toFile();
    Files.write(apk.toPath(), "exact target".getBytes(StandardCharsets.UTF_8));

    assertEquals(
        "6b8c7cbc10e07c5d0d81e83041ef4fe7ee23af5bdeb0f30a0cf4f2423b229fdf",
        AsgInstallTransactionStore.sha256(apk));
  }

  @Test
  public void expiresOnlyOldForwardMovingTransactions() {
    assertTrue(AsgInstallTransactionStore.isExpired(1_000L, 7_001L, 6_000L));
    assertFalse(AsgInstallTransactionStore.isExpired(1_000L, 7_000L, 6_000L));
    assertFalse(AsgInstallTransactionStore.isExpired(-1L, 7_001L, 6_000L));
    assertFalse(AsgInstallTransactionStore.isExpired(8_000L, 7_001L, 6_000L));
  }
}

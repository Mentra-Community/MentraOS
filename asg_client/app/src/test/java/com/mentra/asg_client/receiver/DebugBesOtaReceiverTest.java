package com.mentra.asg_client.receiver;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mentra.asg_client.AsgConstants;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

/** Source-only validation of the debug receiver's selected existing installer input. */
public class DebugBesOtaReceiverTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private String sha() {
        return "a".repeat(64);
    }

    private String path() {
        return AsgConstants.DEBUG_BES_OTA_STAGING_PREFIX + "b".repeat(32) + "/" + sha() + ".bin";
    }

    @Test
    public void omittedPathKeepsExistingScriptArtifactLocation() {
        assertThat(DebugBesOtaReceiver.selectArtifact(null, sha()).getPath())
                .isEqualTo(AsgConstants.DEBUG_BES_OTA_ARTIFACT_PREFIX + sha() + ".bin");
    }

    @Test
    public void ownedPathRequiresExactGrantDirectoryAndArtifactBasename() {
        assertThat(DebugBesOtaReceiver.selectArtifact(path(), sha()).getPath()).isEqualTo(path());
        for (String invalid :
                new String[] {
                    "",
                    path() + ".bak",
                    path().replace(sha(), "c".repeat(64)),
                    path().replace("b".repeat(32), "b".repeat(31)),
                    path().replace("/data/local/tmp/", "/tmp/"),
                    path().replace("/" + sha(), "/../" + sha())
                }) {
            assertThatThrownBy(() -> DebugBesOtaReceiver.selectArtifact(invalid, sha()))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    public void explicitArtifactMustBeAReadableRegularFile() throws Exception {
        File file = temporary.newFile("artifact.bin").getCanonicalFile();
        DebugBesOtaReceiver.requireReadableCanonicalFile(file);
        assertThatThrownBy(
                        () -> DebugBesOtaReceiver.requireReadableCanonicalFile(temporary.getRoot()))
                .isInstanceOf(IOException.class);
        assertThatThrownBy(
                        () ->
                                DebugBesOtaReceiver.requireReadableCanonicalFile(
                                        new File(file + ".missing")))
                .isInstanceOf(IOException.class);
    }

    @Test
    public void symlinkFileAndParentCannotPassCanonicalValidation() throws Exception {
        File file = temporary.newFile("artifact.bin").getCanonicalFile();
        File link = new File(temporary.getRoot(), "alias.bin");
        Files.createSymbolicLink(link.toPath(), file.toPath());
        assertThatThrownBy(() -> DebugBesOtaReceiver.requireReadableCanonicalFile(link))
                .isInstanceOf(IOException.class);
        File directory = temporary.newFolder("owned").getCanonicalFile();
        File nested = new File(directory, "nested.bin");
        Files.write(nested.toPath(), new byte[] {1});
        File parentLink = new File(temporary.getRoot(), "parent-alias");
        Files.createSymbolicLink(parentLink.toPath(), directory.toPath());
        assertThatThrownBy(
                        () ->
                                DebugBesOtaReceiver.requireReadableCanonicalFile(
                                        new File(parentLink, "nested.bin")))
                .isInstanceOf(IOException.class);
    }
}

package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertThrows;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Test;

public class MtkOtaArtifactValidatorTest {
    private File artifact(int minor, boolean wipe) throws Exception {
        File file = File.createTempFile("mtk-ota-", ".zip");
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(file))) {
            byte[] payload = ByteBuffer.allocate(26).putInt(0x43724155).putLong(2).putLong(2).putInt(0)
                    .put((byte) 0x60).put((byte) minor).array();
            for (String name : new String[]{"META-INF/com/android/metadata", "payload_properties.txt", "payload.bin"}) {
                byte[] bytes = name.equals("payload.bin") ? payload : (name.equals("payload_properties.txt")
                        ? "FILE_SIZE=" + payload.length + "\n" : "ota-type=AB\n" + (wipe ? "ota-wipe=yes\n" : ""))
                        .getBytes(StandardCharsets.UTF_8);
                ZipEntry entry = new ZipEntry(name);
                if (name.equals("payload.bin")) {
                    CRC32 crc = new CRC32(); crc.update(bytes);
                    entry.setMethod(ZipEntry.STORED); entry.setSize(bytes.length); entry.setCrc(crc.getValue());
                }
                zip.putNextEntry(entry); zip.write(bytes); zip.closeEntry();
            }
        }
        return file;
    }

    @Test public void exactSelectedPayloadKindAndNoWipeAreRequired() throws Exception {
        File full = artifact(0, false), delta = artifact(2, false), wipe = artifact(2, true);
        try {
            MtkOtaArtifactValidator.validate(full, false);
            MtkOtaArtifactValidator.validate(delta, true);
            assertThrows(IOException.class, () -> MtkOtaArtifactValidator.validate(full, true));
            assertThrows(IOException.class, () -> MtkOtaArtifactValidator.validate(delta, false));
            assertThrows(IOException.class, () -> MtkOtaArtifactValidator.validate(wipe, true));
        } finally {Files.delete(full.toPath()); Files.delete(delta.toPath()); Files.delete(wipe.toPath());}
    }
}

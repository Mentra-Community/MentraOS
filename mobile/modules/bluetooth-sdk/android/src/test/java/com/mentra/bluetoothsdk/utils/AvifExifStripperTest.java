package com.mentra.bluetoothsdk.utils;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31)
public class AvifExifStripperTest {

    @Test
    public void stripForDecode_removesExifMarkerAndShrinksFile() throws Exception {
        byte[] withExif =
                java.nio.file.Files.readAllBytes(
                        new File("src/test/resources/avif_with_exif.avif").toPath());
        assertThat(BlePhotoUploadService.containsExifMarkerInBytes(withExif)).isTrue();

        byte[] stripped = AvifExifStripper.stripForDecode(withExif);
        assertThat(stripped.length).isLessThan(withExif.length);
        assertThat(BlePhotoUploadService.describeContainer(stripped)).isEqualTo("iso_bmff/ftyp=avif");
        assertThat(exifMarkerOffsetInMdat(stripped)).isLessThan(0);
    }

    private static int exifMarkerOffsetInMdat(byte[] avif) throws Exception {
        byte[] marker = new byte[] {'E', 'x', 'i', 'f', 0, 0};
        int offset = 0;
        while (offset + 8 <= avif.length) {
            int size =
                    ((avif[offset] & 0xFF) << 24)
                            | ((avif[offset + 1] & 0xFF) << 16)
                            | ((avif[offset + 2] & 0xFF) << 8)
                            | (avif[offset + 3] & 0xFF);
            String type = new String(avif, offset + 4, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
            if ("mdat".equals(type)) {
                int payloadStart = offset + 8;
                int payloadEnd = payloadStart + size - 8;
                for (int i = payloadStart; i <= payloadEnd - marker.length; i++) {
                    boolean match = true;
                    for (int j = 0; j < marker.length; j++) {
                        if (avif[i + j] != marker[j]) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        return i;
                    }
                }
                return -1;
            }
            offset += size;
        }
        return -1;
    }

    @Test
    public void stripForDecode_isNoOpWithoutExifItem() throws Exception {
        byte[] plain =
                java.nio.file.Files.readAllBytes(
                        new File("src/test/resources/avif_with_exif.avif").toPath());
        byte[] stripped = AvifExifStripper.stripForDecode(plain);
        byte[] strippedAgain = AvifExifStripper.stripForDecode(stripped);
        assertThat(strippedAgain.length).isEqualTo(stripped.length);
    }
}

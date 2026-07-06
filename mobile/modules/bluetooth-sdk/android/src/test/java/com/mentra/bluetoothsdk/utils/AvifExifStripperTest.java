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
    public void stripForDecode_removesExifTailAndKeepsPrimaryIlocValid() throws Exception {
        byte[] withExif =
                java.nio.file.Files.readAllBytes(
                        new File("src/test/resources/avif_with_exif.avif").toPath());
        assertThat(BlePhotoUploadService.containsExifMarkerInBytes(withExif)).isTrue();
        int originalMarkerCount = countExifMarkers(withExif);

        byte[] stripped = AvifExifStripper.stripForDecode(withExif);
        assertThat(stripped.length).isLessThan(withExif.length);
        assertThat(countExifMarkers(stripped)).isLessThan(originalMarkerCount);

        byte[] jpeg = BlePhotoUploadService.convertToJpegPreservingExif(withExif);
        assertThat(jpeg.length).isGreaterThan(100);
    }

    private static int countExifMarkers(byte[] data) {
        byte[] marker = new byte[] {'E', 'x', 'i', 'f', 0, 0};
        int count = 0;
        outer:
        for (int i = 0; i <= data.length - marker.length; i++) {
            for (int j = 0; j < marker.length; j++) {
                if (data[i + j] != marker[j]) {
                    continue outer;
                }
            }
            count++;
        }
        return count;
    }
}

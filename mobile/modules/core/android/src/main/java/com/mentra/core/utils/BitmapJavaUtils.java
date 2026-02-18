package com.mentra.core.utils;

import java.io.File;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;
import android.graphics.Bitmap;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;

public class BitmapJavaUtils {
    private static final String TAG = "WearableAi_BitmapJavaUtils";

    public static Bitmap loadImageFromStorage(String path){
        File imgFile = new  File(path);
        if(imgFile.exists()){
            Bitmap myBitmap = BitmapFactory.decodeFile(imgFile.getAbsolutePath());
            return myBitmap;
        } else {
            Log.d(TAG, "Image doesn't exist");
            return null;
        }
    }

    /**
     * Converts a standard Android ARGB Bitmap into a 1-bit-per-pixel (monochrome) BMP file in memory.
     *
     * <p>This method:
     * <ul>
     *   <li>Thresholds each pixel to black or white (simple average-based threshold).
     *   <li>Packs the bits: leftmost pixel in the most significant bit.
     *   <li>Writes a BITMAPFILEHEADER + BITMAPINFOHEADER + 2-entry palette + raw 1-bpp data.
     * </ul>
     *
     * @param bitmap the Android Bitmap to convert. Its alpha channel is ignored.
     * @param invert if {@code false}, bits of 0 map to white, bits of 1 map to black;
     *               if {@code true}, the palette is reversed so 0 maps to black, 1 to white.
     * @return A byte[] containing a valid 1-bpp BMP file.
     * @throws IOException if an I/O error occurs writing to the buffer (unlikely in memory).
     */
    public static byte[] convertBitmapTo1BitBmpBytes(Bitmap bitmap, boolean invert) throws IOException {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();

        // Each row is padded to a multiple of 4 bytes (32 bits).
        int rowSizeBytes = ((width + 31) / 32) * 4;
        int imageSize = rowSizeBytes * height;

        // BMP header sizes for 1-bpp:
        //  - File header: 14 bytes
        //  - DIB header (BITMAPINFOHEADER): 40 bytes
        //  - Color table: 2 entries × 4 bytes each = 8 bytes
        // => Pixel data offset = 14 + 40 + 8 = 62
        int dataOffset = 62;
        int fileSize = dataOffset + imageSize;

        ByteArrayOutputStream baos = new ByteArrayOutputStream(fileSize);

        // ================== BMP FILE HEADER (14 bytes) ==================
        // Signature: "BM"
        baos.write('B');
        baos.write('M');
        // File size (4 bytes, LE)
        writeIntLE(baos, fileSize);
        // Reserved (4 bytes)
        writeShortLE(baos, 0);
        writeShortLE(baos, 0);
        // Offset to pixel data
        writeIntLE(baos, dataOffset);

        // ================== DIB HEADER: BITMAPINFOHEADER (40 bytes) ==================
        writeIntLE(baos, 40);        // DIB header size
        writeIntLE(baos, width);     // Width
        writeIntLE(baos, height);    // Height (positive => bottom-to-top)
        writeShortLE(baos, 1);       // Planes = 1
        writeShortLE(baos, 1);       // Bits per pixel = 1
        writeIntLE(baos, 0);         // Compression = BI_RGB (uncompressed)
        writeIntLE(baos, imageSize); // Image size
        writeIntLE(baos, 2835);      // X pixels per meter (72 DPI)
        writeIntLE(baos, 2835);      // Y pixels per meter (72 DPI)
        writeIntLE(baos, 2);         // # of colors in palette
        writeIntLE(baos, 0);         // # of important colors

        // ================== COLOR TABLE (8 bytes: 2 entries × 4 bytes each) ==================
        // Each color entry: (Blue, Green, Red, Reserved)
        // If invert=false, then 0 => White, 1 => Black. Otherwise, 0 => Black, 1 => White.
        if (!invert) {
            // color index 0 => white
            baos.write(0xFF); baos.write(0xFF); baos.write(0xFF); baos.write(0x00);
            // color index 1 => black
            baos.write(0x00); baos.write(0x00); baos.write(0x00); baos.write(0x00);
        } else {
            // color index 0 => black
            baos.write(0x00); baos.write(0x00); baos.write(0x00); baos.write(0x00);
            // color index 1 => white
            baos.write(0xFF); baos.write(0xFF); baos.write(0xFF); baos.write(0x00);
        }

        // ================== PIXEL DATA (1-bpp, bottom-to-top) ==================
        // We'll iterate from top row to bottom row in the Android sense,
        // but actually output from bottom row to top row in BMP format.
        int[] rowPixels = new int[width];

        for (int y = 0; y < height; y++) {
            int py = height - 1 - y; // "py" is the actual row index in the source
            bitmap.getPixels(rowPixels, 0, width, 0, py, width, 1);

            byte[] packedRow = new byte[rowSizeBytes];
            int bitIndex = 0;   // which bit within the current byte [0..7]
            int byteIndex = 0;  // which byte in packedRow

            for (int x = 0; x < width; x++) {
                int color = rowPixels[x];
                int r = (color >> 16) & 0xFF;
                int g = (color >> 8) & 0xFF;
                int b = (color) & 0xFF;

                // Simple threshold (tweak if you want better dithering)
                int gray = (r + g + b) / 3;
                // int pixelVal = (gray < 128) ? 1 : 0; // 0=white or 1=black depending on palette
                int pixelVal = 0;
                if (!invert) {
                    pixelVal = (gray < 128) ? 1 : 0; // Dark → 1 (black), Light → 0 (white)
                } else {
                    pixelVal = (gray < 128) ? 0 : 1; // Dark → 0 (black), Light → 1 (white)
                }

                // The leftmost pixel goes in the MSB of the byte => bit position = 7 - bitIndex
                packedRow[byteIndex] |= (pixelVal << (7 - bitIndex));

                bitIndex++;
                if (bitIndex == 8) {
                    bitIndex = 0;
                    byteIndex++;
                }
            }

            baos.write(packedRow, 0, rowSizeBytes);
        }

        return baos.toByteArray();
    }

    /**
     * Writes an integer as 4 little-endian bytes.
     */
    private static void writeIntLE(OutputStream out, int value) throws IOException {
        out.write(value & 0xFF);
        out.write((value >> 8) & 0xFF);
        out.write((value >> 16) & 0xFF);
        out.write((value >> 24) & 0xFF);
    }

    /**
     * Writes a short as 2 little-endian bytes.
     */
    private static void writeShortLE(OutputStream out, int value) throws IOException {
        out.write(value & 0xFF);
        out.write((value >> 8) & 0xFF);
    }

    public static Bitmap bytesToBitmap(byte[] imageData) {
        if (imageData == null || imageData.length == 0) {
            return null;
        }
        return BitmapFactory.decodeByteArray(imageData, 0, imageData.length);
    }
}

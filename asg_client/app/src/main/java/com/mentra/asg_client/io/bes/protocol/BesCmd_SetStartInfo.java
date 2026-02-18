package com.mentra.asg_client.io.bes.protocol;

import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;

import com.mentra.asg_client.io.bes.util.BesOtaUtil;

/**
 * Send file size and metadata to BES
 * Prepares BES for receiving firmware data
 */
public class BesCmd_SetStartInfo extends BesBaseCommand {
    private static final String TAG = "BesCmd_SetStartInfo";
    private byte[] data = new byte[12];

    public BesCmd_SetStartInfo() {
        super(BesProtocolConstants.SCMD_SET_START_INFO);
        setMagicCode(BesOtaUtil.MAGIC_CODE);
    }

    private void setMagicCode(byte[] magicCode)
    {
        System.arraycopy(magicCode, 0, data, 0, magicCode.length);
    }

    /**
     * Set the firmware file path and calculate metadata
     * @param filePath Path to firmware .bin file
     * @return true if successful, false if file not found or error
     */
    public boolean setFilePath(String filePath) {
        File f = new File(filePath);
        if(!f.exists())
            return false;
        FileInputStream inputStream = null;
        try {
            inputStream = new FileInputStream(f);
            int totalSize = inputStream.available();
            int dataSize = totalSize;
            byte[] iamgeBytes = new byte[dataSize];
            inputStream.read(iamgeBytes, 0, dataSize);
            inputStream.close();
            long crc32 = BesOtaUtil.crc32(iamgeBytes, 0, dataSize);
            byte[] imageSize = BesOtaUtil.int2Bytes(dataSize);
            byte[] crc32OfImage = BesOtaUtil.long2Bytes(crc32);

            // Detailed CRC32 logging for debugging
            Log.i(TAG, "========== SetStartInfo CRC32 Debug ==========");
            Log.i(TAG, "OTA file: " + filePath);
            Log.i(TAG, "File size: " + totalSize + " bytes");
            Log.i(TAG, "CRC32 (decimal): " + crc32);
            Log.i(TAG, "CRC32 (hex): 0x" + String.format("%08X", crc32));
            Log.i(TAG, "CRC32 bytes (little-endian): " +
                  String.format("%02X %02X %02X %02X",
                      crc32OfImage[0] & 0xFF, crc32OfImage[1] & 0xFF,
                      crc32OfImage[2] & 0xFF, crc32OfImage[3] & 0xFF));
            Log.i(TAG, "Image size bytes (little-endian): " +
                  String.format("%02X %02X %02X %02X",
                      imageSize[0] & 0xFF, imageSize[1] & 0xFF,
                      imageSize[2] & 0xFF, imageSize[3] & 0xFF));
            Log.i(TAG, "First 16 bytes of file: " + bytesToHex(iamgeBytes, 0, 16));
            Log.i(TAG, "Last 16 bytes of file: " + bytesToHex(iamgeBytes, dataSize - 16, 16));
            Log.i(TAG, "==============================================");

            System.arraycopy(imageSize, 0, data, 4, imageSize.length);
            System.arraycopy(crc32OfImage, 0, data, 8, crc32OfImage.length);
            return true;
        } catch (FileNotFoundException e) {
            e.printStackTrace();
        } catch (IOException e) {
            e.printStackTrace();
        }
        return false;
    }

    @Override
    public byte[] getSendData() {
        setPlayload(data);
        return super.getSendData();
    }

    private String bytesToHex(byte[] bytes, int offset, int length) {
        StringBuilder sb = new StringBuilder();
        int end = Math.min(offset + length, bytes.length);
        for (int i = offset; i < end; i++) {
            sb.append(String.format("%02X ", bytes[i] & 0xFF));
        }
        return sb.toString().trim();
    }
}


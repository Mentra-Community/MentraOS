package com.mentra.asg_client.io.bes.protocol;

import android.util.Log;

import com.mentra.asg_client.io.ota.utils.OtaUtils;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * Configure BT name, address, and other options
 * Allows customization during firmware update
 */
public class BesCmd_SetConfig extends BesBaseCommand {
    private static final String TAG = "BesCmd_SetConfig";
    
    private byte[] data = new byte[92];
    private boolean bClearUserData = false;
    private boolean bUpdateBtName = false;
    private boolean bUpdateBleName = false;
    private boolean bUpdateBtAddress = false;
    private boolean bUpdateBleAddress = false;

    private String btName;
    private String bleName;
    private String btAddress;
    private String bleAddress;
    
    public BesCmd_SetConfig() {
        super(BesProtocolConstants.SCMD_SET_CONFIG);
    }

    public void setClearUserData(boolean bClearUserData) {
        this.bClearUserData = bClearUserData;
    }

    public void setUpdateBtName(boolean bUpdateBtName, String btName) {
        this.bUpdateBtName = bUpdateBtName;
        this.btName = btName;
    }

    public void setUpdateBleName(boolean bUpdateBleName, String bleName) {
        this.bUpdateBleName = bUpdateBleName;
        this.bleName = bleName;
    }

    public void setUpdateBtAddress(boolean bUpdateBtAddress, String btAddress) {
        this.bUpdateBtAddress = bUpdateBtAddress;
        this.btAddress = btAddress;
    }

    public void setUpdateBleAddress(boolean bUpdateBleAddress, String bleAddress) {
        this.bUpdateBleAddress = bUpdateBleAddress;
        this.bleAddress = bleAddress;
    }

    /**
     * Set the firmware file path and build config payload
     * @param filePath Path to firmware .bin file
     * @return true if successful
     */
    public boolean setFilePath(String filePath) {
        File f = new File(filePath);
        if (!f.exists())
            return false;
        FileInputStream inputStream = null;
        try {
            inputStream = new FileInputStream(filePath);
            int totalSize = inputStream.available();
            int dataSize = totalSize;
            byte[] imageBytes = new byte[dataSize];
            inputStream.read(imageBytes, 0, dataSize);
            inputStream.close();

            byte[] followingLenBytes = OtaUtils.int2Bytes(data.length - 4);
            System.arraycopy(followingLenBytes, 0, data, 0, 4);

            data[4] = imageBytes[dataSize - 4];
            data[5] = imageBytes[dataSize - 3];
            data[6] = imageBytes[dataSize - 2];

            byte enable = 0x00;
            enable |= (bClearUserData ? 0x01 : 0x00);
            enable |= (bUpdateBtName ? (0x01 << 1) : 0x00);
            enable |= (bUpdateBleName ? (0x01 << 2) : 0x00);
            enable |= (bUpdateBtAddress ? (0x01 << 3) : 0x00);
            enable |= (bUpdateBleAddress ? (0x01 << 4) : 0x00);
            data[8] = enable;

            if (bUpdateBtName && btName != null && btName.length() > 0) {
                byte[] names = btName.getBytes();
                int namelen = names.length;
                if (namelen > 32)
                    namelen = 32;
                for (int i = 0; i < namelen; i++)
                    data[12 + i] = names[i];
            }

            if (bUpdateBleName && bleName != null && bleName.length() > 0) {
                byte[] names = bleName.getBytes();
                int namelen = names.length;
                if (namelen > 32)
                    namelen = 32;
                for (int i = 0; i < namelen; i++)
                    data[44 + i] = names[i];
            }

            if (bUpdateBtAddress && btAddress != null && btAddress.length() > 0) {
                for (int i = 0; i < 6; i++) {
                    data[76 + 5 - i] = Integer.valueOf(btAddress.substring(i * 2, i * 2 + 2), 16).byteValue();
                }
            }

            if (bUpdateBleAddress && bleAddress != null && bleAddress.length() > 0) {
                for (int i = 0; i < 6; i++) {
                    data[82 + 5 - i] = Integer.valueOf(bleAddress.substring(i * 2, i * 2 + 2), 16).byteValue();
                }
            }
            ////
            long crc32 = OtaUtils.crc32(data, 0, data.length - 4);
            byte[] crc32OfConfig = OtaUtils.long2Bytes(crc32);
            Log.e("_test_", "ota config file=" + filePath + ",size=" + totalSize + ",crc32=" + crc32);
            System.arraycopy(crc32OfConfig, 0, data, 88, crc32OfConfig.length);
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
}


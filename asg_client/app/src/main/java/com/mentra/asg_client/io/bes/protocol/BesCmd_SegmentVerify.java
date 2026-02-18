package com.mentra.asg_client.io.bes.protocol;

import com.mentra.asg_client.io.bes.util.BesOtaUtil;

/**
 * CRC32 verification per 16KB segment
 * Verifies data integrity after each segment
 * Payload: [4-byte magic code][4-byte CRC32]
 */
public class BesCmd_SegmentVerify extends BesBaseCommand {
    private byte[] data = new byte[8];
    
    public BesCmd_SegmentVerify() {
        super(BesProtocolConstants.SCMD_SEGMENT_VERIFY);
        setMagicCode(BesOtaUtil.MAGIC_CODE);
    }
    
    private void setMagicCode(byte[] magicCode) {
        System.arraycopy(magicCode, 0, data, 0, magicCode.length);
    }

    /**
     * Set the CRC32 checksum for the current segment
     * @param crc32 CRC32 value as 4-byte array (little-endian)
     */
    public void setSegmentCrc32(byte[] crc32) {
        if (crc32 != null && crc32.length == 4) {
            System.arraycopy(crc32, 0, this.data, 4, crc32.length);
        }
    }
    
    @Override
    public byte[] getSendData() {
        setPlayload(data);
        return super.getSendData();
    }
}


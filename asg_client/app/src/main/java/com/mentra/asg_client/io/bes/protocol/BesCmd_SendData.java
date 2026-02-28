package com.mentra.asg_client.io.bes.protocol;

/**
 * Transmit 504-byte firmware data packet
 * Main command for sending firmware data in chunks
 */
public class BesCmd_SendData extends BesBaseCommand {
    private byte[] data = null;
    
    public BesCmd_SendData() {
        super(BesProtocolConstants.SCMD_SEND_DATA);
    }

    /**
     * Set the firmware data chunk to send
     * @param data Firmware data (typically 504 bytes or less)
     */
    public void setFileData(byte[] data) {
        if (data != null) {
            this.data = new byte[data.length];
            System.arraycopy(data, 0, this.data, 0, data.length);
        }
    }

    @Override
    public byte[] getSendData() {
        setPlayload(data);
        return super.getSendData();
    }
}


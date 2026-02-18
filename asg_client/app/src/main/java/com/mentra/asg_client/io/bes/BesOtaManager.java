package com.mentra.asg_client.io.bes;

import android.util.Log;

import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import com.mentra.asg_client.io.bes.protocol.*;
import com.mentra.asg_client.io.bes.util.BesOtaUtil;
import com.mentra.asg_client.io.bluetooth.core.ComManager;
import com.mentra.asg_client.io.bluetooth.utils.ByteUtil;

import org.greenrobot.eventbus.EventBus;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * Manages BES2700 firmware OTA updates
 * Handles file loading, packet transmission, state tracking, and protocol state machine
 */
public class BesOtaManager implements BesOtaUartListener, BesOtaCommandListener {
    private static final String TAG = "BesOtaManager";
    
    // Static flag to track if BES OTA is in progress
    public static volatile boolean isBesOtaInProgress = false;
    
    private static BesOtaManager mInstance;
    private static byte[] sCurrentFirmwareVersion = null; // Store current firmware version bytes
    private String filePath;
    private boolean bInit = false;
    private byte[] fileData = null;
    private int fileLen = 0;
    private int sentPos = 0;
    private int curSentLen = 0;
    private int confirmTimes = 0;
    private int confirmSentPos = 0;
    private boolean bWait4Confirm = false;
    private boolean isWaitingForAuthorization = false;
    
    private ComManager comManager;
    private BesOtaCommandListener mListener;
    private static com.mentra.asg_client.service.core.handlers.K900CommandHandler sK900CommandHandler;

    /**
     * Constructor - receives ComManager instance from AsgClientService
     * @param comManager The ComManager instance for UART communication
     */
    public BesOtaManager(ComManager comManager) {
        this.comManager = comManager;
    }
    
    /**
     * Set K900CommandHandler for sending authorization requests
     * @param handler The K900CommandHandler instance
     */
    public static void setK900CommandHandler(com.mentra.asg_client.service.core.handlers.K900CommandHandler handler) {
        sK900CommandHandler = handler;
    }
    
    /**
     * Get singleton instance (for checking isBesOtaInProgress flag)
     * @return BesOtaManager instance
     */
    public static BesOtaManager getInstance() {
        return mInstance;
    }
    
    /**
     * Set singleton instance (called by AsgClientService)
     * @param instance The BesOtaManager instance
     */
    public static void setInstance(BesOtaManager instance) {
        mInstance = instance;
    }
    
    /**
     * Get current firmware version from BES device
     * @return byte array with [major, minor, patch, build] or null if not available
     */
    public static byte[] getCurrentFirmwareVersion() {
        return sCurrentFirmwareVersion;
    }
    
    /**
     * Convert server version code (long) to BES firmware version format (byte array)
     * Server version format: XYYYYZZ where X=major, Y=minor, Z=patch
     * BES format: [major, minor, patch, build]
     * @param versionCode Server version code
     * @return byte array [major, minor, patch, build]
     */
    public static byte[] parseServerVersionCode(long versionCode) {
        int major = (int)(versionCode / 1000000);
        int minor = (int)((versionCode / 1000) % 1000);
        int patch = (int)(versionCode % 1000);
        int build = 0; // Build not specified in version code
        
        return new byte[]{(byte)major, (byte)minor, (byte)patch, (byte)build};
    }
    
    /**
     * Compare two BES firmware versions
     * @param v1 First version
     * @param v2 Second version
     * @return true if v1 is newer than v2, false otherwise
     */
    public static boolean isNewerVersion(byte[] v1, byte[] v2) {
        if (v1 == null || v2 == null || v1.length < 4 || v2.length < 4) {
            return false;
        }
        
        // Compare major.minor.patch.build
        for (int i = 0; i < 4; i++) {
            int b1 = v1[i] & 0xFF;
            int b2 = v2[i] & 0xFF;
            if (b1 > b2) return true;
            if (b1 < b2) return false;
        }
        return false;
    }
    
    public void registerCmdListener(BesOtaCommandListener listener) {
        mListener = listener;
    }
    
    /**
     * Query current firmware version from BES device (without starting OTA)
     * This sends GET_FIRMWARE_VERSION command and waits for response
     * Response is stored in sCurrentFirmwareVersion
     * @return true if request sent successfully
     */
    public boolean queryFirmwareVersion() {
        if (comManager == null) {
            Log.e(TAG, "Cannot query firmware version - ComManager is null");
            return false;
        }
        
        if (isBesOtaInProgress) {
            Log.w(TAG, "Cannot query firmware version - OTA in progress");
            return false;
        }
        
        // Send GetFirmwareVersion command directly via ComManager
        BesCmd_GetFirmwareVersion cmd = new BesCmd_GetFirmwareVersion();
        byte[] data = cmd.getSendData();
        
        if (data != null) {
            Log.d(TAG, "Querying current firmware version...");
            return comManager.send(data);
        }
        return false;
    }
    
    /**
     * Callback for firmware version response (outside OTA context)
     * This is called directly from ComManager's normal data handling
     */
    public void onFirmwareVersionReceived(byte[] data, int size) {
        // Parse the firmware version from raw data
        if (size > 9) {
            if (BesOtaUtil.isMagicCodeValid(data, 0, 4)) {
                byte[] firmware = BesOtaUtil.getFirmwareVersion(data, 5, 4);
                if (firmware != null) {
                    sCurrentFirmwareVersion = firmware;
                    Log.i(TAG, "Current firmware version queried: " + 
                          (firmware[0] & 0xFF) + "." + (firmware[1] & 0xFF) + "." + 
                          (firmware[2] & 0xFF) + "." + (firmware[3] & 0xFF));
                }
            }
        }
    }
    
    /**
     * Initialize firmware file and prepare for OTA
     * @param filePath Path to firmware .bin file
     * @return true if initialized successfully, false otherwise
     */
    public boolean init(String filePath) {
        Log.i(TAG, "🔧 Initializing BES OTA with file: " + filePath);
        this.filePath = filePath;
        bInit = false;
        File f = new File(this.filePath);
        if (!f.exists()) {
            Log.e(TAG, "❌ BES firmware file not exist: " + this.filePath);
            return false;
        }
        Log.d(TAG, "✅ File exists, size: " + f.length() + " bytes");
        try {
            FileInputStream inputStream = new FileInputStream(filePath);
            fileLen = inputStream.available();
            Log.d(TAG, "📥 Loading firmware into memory, size=" + fileLen + " bytes");
            fileData = new byte[fileLen];
            int bytesRead = inputStream.read(fileData, 0, fileLen);
            inputStream.close();
            Log.i(TAG, "✅ Firmware loaded into memory: " + bytesRead + " bytes");

            // Calculate and log CRC32 for debugging
            long crc32 = BesOtaUtil.crc32(fileData, 0, fileLen);
            Log.i(TAG, "========== BesOtaManager CRC32 Debug ==========");
            Log.i(TAG, "Firmware CRC32 (decimal): " + crc32);
            Log.i(TAG, "Firmware CRC32 (hex): 0x" + String.format("%08X", crc32));
            Log.i(TAG, "================================================");

            bInit = true;
            if (fileLen > BesOtaUtil.MAX_FILE_SIZE) {
                Log.e(TAG, "❌ BES firmware file too big, len=" + fileLen + " (max: " + BesOtaUtil.MAX_FILE_SIZE + ")");
                return false;
            }
            Log.i(TAG, "✅ BES firmware initialization complete - ready to transmit " + fileLen + " bytes");
            return true;
        } catch (FileNotFoundException e) {
            Log.e(TAG, "❌ BES firmware file not found", e);
        } catch (IOException e) {
            Log.e(TAG, "❌ Error reading BES firmware file", e);
        }
        return false;
    }

    /**
     * Start firmware update process
     * @param filePath Path to firmware .bin file
     * @return true if started successfully
     */
    public boolean startFirmwareUpdate(String filePath) {
        Log.i(TAG, "startFirmwareUpdate: " + filePath);

        if (!init(filePath)) {
            Log.e(TAG, "Failed to initialize firmware update");
            return false;
        }
        
        // Set waiting for authorization flag (NOT in OTA mode yet!)
        isWaitingForAuthorization = true;
        isBesOtaInProgress = true;
        
        // DO NOT enable OTA mode yet - wait for authorization
        // DO NOT set fast mode yet - wait for authorization
        
        // Emit started event (for internal state management, not sent to phone)
        EventBus.getDefault().post(BesOtaProgressEvent.createStarted(fileLen));
        
        // STEP 1: Request authorization from BES chip via K900CommandHandler
        Log.i(TAG, "Requesting BES OTA authorization from BES chip");
        
        if (sK900CommandHandler != null) {
            sK900CommandHandler.sendBesOtaAuthorizationRequest();
            return true;
        } else {
            Log.e(TAG, "❌ K900CommandHandler not available - cannot send authorization request");
            EventBus.getDefault().post(BesOtaProgressEvent.createFailed("K900CommandHandler not available"));
            cleanup();
            return false;
        }
    }
    
    /**
     * Cleanup and reset state
     */
    private void cleanup() {
        isBesOtaInProgress = false;
        isWaitingForAuthorization = false;
        if (comManager != null) {
            comManager.setOtaUpdating(false);
            comManager.setFastMode(false);
        }
        bInit = false;
        fileData = null;
        sentPos = 0;
        confirmTimes = 0;
    }

    /**
     * Called when BES chip grants OTA authorization
     * This is the trigger to actually start the OTA protocol
     */
    public void onAuthorizationGranted() {
        if (!isWaitingForAuthorization) {
            Log.w(TAG, "Received authorization but not waiting for it");
            return;
        }
        
        Log.i(TAG, "BES OTA authorization GRANTED - starting protocol");
        isWaitingForAuthorization = false;
        
        // NOW enable OTA mode (routes UART to OTA listener)
        if (comManager != null) {
            comManager.setOtaUpdating(true);
            comManager.setFastMode(true);
        }
        
        // NOW start the actual OTA protocol
        byte[] data = SCmd_GetProtocolVersion();
        Log.d(TAG, "Sending GetProtocolVersion command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
        if (send(data)) {
            Log.i(TAG, "BES OTA protocol started successfully");
        } else {
            Log.e(TAG, "Failed to send first protocol command");
            EventBus.getDefault().post(BesOtaProgressEvent.createFailed("Failed to start protocol"));
            cleanup();
        }
    }

    /**
     * Called when BES chip denies OTA authorization
     */
    public void onAuthorizationDenied() {
        Log.e(TAG, "BES OTA authorization DENIED by BES chip");
        EventBus.getDefault().post(BesOtaProgressEvent.createFailed("BES chip denied OTA authorization"));
        cleanup();
    }

    // ========== Protocol Commands ==========
    
    public byte[] SCmd_GetProtocolVersion() {
        if (!bInit) return null;
        BesCmd_GetProtocolVersion cmd = new BesCmd_GetProtocolVersion();
        return cmd.getSendData();
    }

    public byte[] SCmd_SetUser() {
        if (!bInit) return null;
        BesCmd_SetUser cmd = new BesCmd_SetUser();
        return cmd.getSendData();
    }

    public byte[] SCmd_GetFirmwareVersion() {
        if (!bInit) return null;
        BesCmd_GetFirmwareVersion cmd = new BesCmd_GetFirmwareVersion();
        return cmd.getSendData();
    }

    public byte[] SCmd_SelectSide() {
        if (!bInit) return null;
        BesCmd_SelectSide cmd = new BesCmd_SelectSide();
        return cmd.getSendData();
    }

    public byte[] SCmd_CheckBreakPoint() {
        if (!bInit) return null;
        BesCmd_CheckBreakpoint cmd = new BesCmd_CheckBreakpoint();
        return cmd.getSendData();
    }

    public byte[] SCmd_SetStartInfo() {
        if (!bInit) return null;
        BesCmd_SetStartInfo cmd = new BesCmd_SetStartInfo();
        if (!cmd.setFilePath(filePath)) {
            return null;
        }
        return cmd.getSendData();
    }

    public byte[] SCmd_SetConfig(boolean bClearUserData, String btName, String bleName, String btAddress, String bleAddress) {
        if (!bInit) return null;
        BesCmd_SetConfig cmd = new BesCmd_SetConfig();
        cmd.setClearUserData(bClearUserData);
        if (btName != null && btName.length() > 0)
            cmd.setUpdateBtName(true, btName);
        if (bleName != null && bleName.length() > 0)
            cmd.setUpdateBleName(true, bleName);
        if (btAddress != null && btAddress.length() > 0)
            cmd.setUpdateBtAddress(true, btAddress);
        if (bleAddress != null && bleAddress.length() > 0)
            cmd.setUpdateBleAddress(true, bleAddress);
        if (!cmd.setFilePath(filePath)) {
            return null;
        }
        bWait4Confirm = false;
        return cmd.getSendData();
    }
    
    public byte[] SCmd_SendFileData() {
        if (!bInit) {
            Log.e(TAG, "❌ SCmd_SendFileData called but not initialized");
            return null;
        }
        BesCmd_SendData cmd = new BesCmd_SendData();
        int len = curSentLen;
        if (len > 0) {
            byte[] data = new byte[len];
            System.arraycopy(fileData, sentPos, data, 0, len);
            cmd.setFileData(data);
            return cmd.getSendData();
        }
        Log.w(TAG, "⚠️ curSentLen is 0 - no data to send");
        return null;
    }

    public void addSentSize(int size) {
        sentPos += size;
    }

    public void crc32ConfirmSuccess() {
        confirmTimes++;
        confirmSentPos = sentPos;
        bWait4Confirm = false;
        Log.i(TAG, "✅ CRC32 verification successful - confirmTimes=" + confirmTimes + ", confirmed " + confirmSentPos + "/" + fileLen + " bytes");
    }

    public int getConfirmLength() {
        return confirmSentPos;
    }
    
    public int getTotalLength() {
        return fileLen;
    }
    
    public boolean isSentFinish() {
        return confirmSentPos == fileLen;
    }

    public boolean isNeedSegmentVerify() {
        if (bWait4Confirm) {
            Log.d(TAG, "⏳ Waiting for segment verification confirmation");
            return true;
        }
        int minSize = Math.min(BesOtaUtil.SEGMENT_SIZE * (confirmTimes + 1), fileLen);
        if (sentPos + BesOtaUtil.PACKET_SIZE >= minSize) {
            curSentLen = minSize - sentPos;
            bWait4Confirm = true;
            Log.i(TAG, "🔍 Segment boundary reached - requesting verification (segment " + (confirmTimes + 1) + ", size=" + curSentLen + " bytes)");
        } else {
            curSentLen = BesOtaUtil.PACKET_SIZE;
        }
        return false;
    }

    public byte[] SCmd_SegmentVerify() {
        if (!bInit) return null;
        int srcPos = BesOtaUtil.SEGMENT_SIZE * confirmTimes;
        byte[] crcSegmentData = new byte[sentPos - srcPos];
        System.arraycopy(fileData, srcPos, crcSegmentData, 0, crcSegmentData.length);
        long crc32 = BesOtaUtil.crc32(crcSegmentData, 0, crcSegmentData.length);
        Log.i(TAG, "🔍 Computing segment CRC32 - segment=" + (confirmTimes + 1) + 
                   ", srcPos=" + srcPos + ", sentPos=" + sentPos + 
                   ", segmentLen=" + crcSegmentData.length + ", CRC32=0x" + Long.toHexString(crc32).toUpperCase());
        byte[] crcBytes = BesOtaUtil.long2Bytes(crc32);
        Log.d(TAG, "🔍 CRC32 bytes: " + ByteUtil.outputHexString(crcBytes, 0, crcBytes.length));
        BesCmd_SegmentVerify cmd = new BesCmd_SegmentVerify();
        cmd.setSegmentCrc32(crcBytes);
        return cmd.getSendData();
    }

    public byte[] SCmd_FinshSend() {
        if (!bInit) return null;
        BesCmd_FinishSend cmd = new BesCmd_FinishSend();
        return cmd.getSendData();
    }

    public byte[] SCmd_OtaApply() {
        if (!bInit) return null;
        BesCmd_Apply cmd = new BesCmd_Apply();
        return cmd.getSendData();
    }

    // ========== Receive Parser ==========
    
    private static final int RECV_BUFFER_SIZE = 512;
    private byte[] recvBuffer = new byte[512];
    private int curRecvLen = 0;

    public BesOtaMessage parseRecv(byte[] data, int offset, int len) {
        if (data == null) return null;
        
        BesOtaMessage m = new BesOtaMessage();
        
        if (curRecvLen > 0) {
            // Continuation of previous packet
            m.cmd = recvBuffer[0];
            if (curRecvLen + len > RECV_BUFFER_SIZE) {
                Log.e(TAG, "Receive buffer overflow, curRecvLen=" + curRecvLen + ", len=" + len);
                m.error = true;
                curRecvLen = 0;
                return m;
            }
            System.arraycopy(data, offset, recvBuffer, curRecvLen, len);
            curRecvLen += len;
            if (curRecvLen < BesBaseCommand.MIN_LENGTH) {
                Log.d(TAG, "Receive incomplete, curRecvLen=" + curRecvLen);
                return null;
            }
            m.len = BesOtaUtil.bytes2Int(recvBuffer, 1, 4);
            
            if (m.len + BesBaseCommand.MIN_LENGTH == curRecvLen) {
                m.error = false;
                curRecvLen = 0;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(recvBuffer, BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                return m;
            } else if (m.len + BesBaseCommand.MIN_LENGTH < curRecvLen) {
                // More bytes than expected - extract first message and log extra bytes
                int expectedLen = m.len + BesBaseCommand.MIN_LENGTH;
                int extraBytes = curRecvLen - expectedLen;
                Log.w(TAG, "Received " + curRecvLen + " bytes but expected " + expectedLen + " - extra " + extraBytes + " bytes will be ignored");
                Log.w(TAG, "Extra bytes: " + ByteUtil.outputHexString(recvBuffer, expectedLen, extraBytes));
                m.error = false;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(recvBuffer, BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                curRecvLen = 0;
                return m;
            } else if (curRecvLen > RECV_BUFFER_SIZE) {
                Log.e(TAG, "Receive error, curRecvLen=" + curRecvLen + " exceeds buffer size " + RECV_BUFFER_SIZE);
                m.error = true;
                curRecvLen = 0;
                return m;
            }
            return null;
        } else {
            // New packet
            if (len < BesBaseCommand.MIN_LENGTH) {
                System.arraycopy(data, offset, recvBuffer, 0, len);
                curRecvLen += len;
                return null;
            }
            m.cmd = data[0];
            m.len = BesOtaUtil.bytes2Int(data, 1, 4);
            if (m.len + BesBaseCommand.MIN_LENGTH == len) {
                m.error = false;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(data, offset + BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                return m;
            } else if (m.len + BesBaseCommand.MIN_LENGTH < len) {
                // More bytes than expected - extract first message and log extra bytes
                int expectedLen = m.len + BesBaseCommand.MIN_LENGTH;
                int extraBytes = len - expectedLen;
                Log.w(TAG, "Received " + len + " bytes but expected " + expectedLen + " - extra " + extraBytes + " bytes will be ignored");
                Log.w(TAG, "Extra bytes: " + ByteUtil.outputHexString(data, offset + expectedLen, extraBytes));
                m.error = false;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(data, offset + BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                curRecvLen = 0;
                return m;
            } else if (len > RECV_BUFFER_SIZE) {
                Log.e(TAG, "Receive error, len=" + len + " exceeds buffer size " + RECV_BUFFER_SIZE);
                m.error = true;
                curRecvLen = 0;
                return m;
            } else {
                System.arraycopy(data, offset, recvBuffer, 0, len);
                curRecvLen = len;
                return null;
            }
        }
    }

    // ========== BesOtaUartListener Implementation ==========
    
    @Override
    public void onOtaRecv(byte[] data, int size) {
        // Reduced logging - only log errors and non-data-ack commands
        BesOtaMessage otaMsg = parseRecv(data, 0, size);
        if (otaMsg != null) {
            if (!otaMsg.error) {
                dealOtaRecvCmd(otaMsg);
            } else {
                Log.e(TAG, "Received error in OTA message");
            }
        }
    }

    // ========== BesOtaCommandListener Implementation ==========
    
    @Override
    public void onParseResult(byte cmd, byte[] data) {
        // Callback for parsed commands (if needed)
        if (mListener != null) {
            mListener.onParseResult(cmd, data);
        }
    }

    // ========== Protocol State Machine ==========
    
    private void dealOtaRecvCmd(BesOtaMessage msg) {
        if (msg == null) return;

        // Only log non-data-ack commands to reduce spam (0x8B = data ack, very frequent)
        if (msg.cmd != BesProtocolConstants.RCMD_SEND_DATA) {
            Log.d(TAG, "dealOtaRecvCmd: cmd=0x" + String.format("%02X", msg.cmd & 0xFF) + ", len=" + msg.len);
        }
        
        if (msg.cmd == BesProtocolConstants.RCMD_GET_PROTOCOL_VERSION) {
            byte[] data = SCmd_SetUser();
            Log.d(TAG, "Sending SetUser command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
            send(data);
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_SET_USER) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                byte[] data = SCmd_GetFirmwareVersion();
                Log.d(TAG, "Sending GetFirmwareVersion command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
                send(data);
            } else {
                Log.e(TAG, "Set user type error");
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_GET_FIRMWARE_VERSION) {
            Log.d(TAG, "Received firmware version, len=" + msg.len);
            if (msg.len > 9 && msg.body != null) {
                if (BesOtaUtil.isMagicCodeValid(msg.body, 0, 4)) {
                    byte[] firmware = BesOtaUtil.getFirmwareVersion(msg.body, 5, 4);
                    if (firmware != null) {
                        // Store current firmware version for comparison
                        sCurrentFirmwareVersion = firmware;
                        Log.i(TAG, "Current firmware version: " + firmware[0] + "." + firmware[1] + "." + firmware[2] + "." + firmware[3]);
                    }
                    byte[] data = SCmd_SelectSide();
                    Log.d(TAG, "Sending SelectSide command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
                    send(data);
                } else {
                    Log.e(TAG, "Invalid magic code in firmware version");
                }
            } else {
                Log.e(TAG, "Invalid firmware version length");
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_SELECT_SIDE) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                byte[] data = SCmd_CheckBreakPoint();
                Log.d(TAG, "Sending CheckBreakPoint command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
                send(data);
            } else {
                Log.e(TAG, "Select side error");
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_GET_BREAKPOINT) {
            if (msg.len == 40) {
                byte[] data = SCmd_SetStartInfo();
                Log.d(TAG, "Sending SetStartInfo command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
                send(data);
            } else {
                Log.e(TAG, "Get breakpoint error");
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_SET_START_INFO) {
            if (msg.len == 10 && msg.body != null) {
                if (BesOtaUtil.isMagicCodeValid(msg.body, 0, 4)) {
                    byte[] data = SCmd_SetConfig(false, null, null, null, null);
                    Log.d(TAG, "Sending SetConfig command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, Math.min(data.length, 100)) : "null"));
                    send(data);
                } else {
                    Log.e(TAG, "Set start info: invalid magic code");
                }
            } else {
                Log.e(TAG, "Set start info error");
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_SET_CONFIG) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                sendOtaData();
            } else {
                Log.e(TAG, "Set config error");
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_SEND_DATA) {
            sendOtaData();
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_SEGMENT_VERIFY) {
            Log.d(TAG, "Received SegmentVerify command, len=" + msg.len);
            Log.d(TAG, "Received SegmentVerify command, body=" + (msg.body != null ? ByteUtil.outputHexString(msg.body, 0, msg.body.length) : "null"));
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                int sent = getConfirmLength();
                int percent = 100 * sent / getTotalLength();
                Log.i(TAG, "OTA progress: " + percent + "% (" + sent + "/" + getTotalLength() + " bytes)");
                
                // Note: BES install progress is sent to phone via sr_adota from BES chip directly
                // We don't post PROGRESS events here because UART is busy and can't send to phone anyway
                // The phone converts sr_adota messages to ota_progress for display
                Log.d(TAG, "BES install progress: " + percent + "% (" + sent + "/" + getTotalLength() + " bytes)");
                
                crc32ConfirmSuccess();
                if (isSentFinish()) {
                    // Calculate CRC32 of all sent data for comparison
                    long sentCrc32 = BesOtaUtil.crc32(fileData, 0, sentPos);
                    Log.i(TAG, "========== FinishSend CRC32 Debug ==========");
                    Log.i(TAG, "Total bytes sent: " + sentPos);
                    Log.i(TAG, "File length: " + fileLen);
                    Log.i(TAG, "Sent data CRC32 (decimal): " + sentCrc32);
                    Log.i(TAG, "Sent data CRC32 (hex): 0x" + String.format("%08X", sentCrc32));
                    Log.i(TAG, "First 16 bytes of sent data: " + ByteUtil.outputHexString(fileData, 0, Math.min(16, sentPos)));
                    Log.i(TAG, "Last 16 bytes of sent data: " + ByteUtil.outputHexString(fileData, Math.max(0, sentPos - 16), Math.min(16, sentPos)));
                    Log.i(TAG, "============================================");

                    byte[] data = SCmd_FinshSend();
                    Log.d(TAG, "Sending FinishSend command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
                    send(data);
                } else {
                    sendOtaData();
                }
            } else {
                Log.e(TAG, "Segment verify error");
                EventBus.getDefault().post(BesOtaProgressEvent.createFailed("Segment verification failed"));
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_SEND_FINISH) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                byte[] data = SCmd_OtaApply();
                Log.d(TAG, "Sending OtaApply command, data=" + (data != null ? ByteUtil.outputHexString(data, 0, data.length) : "null"));
                send(data);
            } else {
                Log.e(TAG, "❌ ========== WHOLE CRC32 CHECK FAILED ==========");
                Log.e(TAG, "❌ Response: len=" + msg.len + ", body=" + (msg.body != null ? ByteUtil.outputHexString(msg.body, 0, msg.body.length) : "null"));
                Log.e(TAG, "❌ Expected body[0]=1 (CRC match), got body[0]=" + (msg.body != null && msg.body.length > 0 ? msg.body[0] : "null"));
                Log.e(TAG, "❌ This means the BES chip computed a different CRC32 than what we sent in SetStartInfo");
                Log.e(TAG, "❌ Possible causes:");
                Log.e(TAG, "❌   1. Data corruption during UART transfer");
                Log.e(TAG, "❌   2. File changed between SetStartInfo and data transfer");
                Log.e(TAG, "❌   3. Bytes dropped or duplicated during transmission");
                Log.e(TAG, "❌ Sent bytes: " + sentPos + ", Expected: " + fileLen);
                if (sentPos != fileLen) {
                    Log.e(TAG, "❌ SIZE MISMATCH! sentPos=" + sentPos + " != fileLen=" + fileLen);
                }
                Log.e(TAG, "❌ =============================================");
                EventBus.getDefault().post(BesOtaProgressEvent.createFailed("Whole CRC32 check failed - data corruption?"));
                cleanup();
            }
        }
        else if (msg.cmd == BesProtocolConstants.RCMD_APPLY) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                Log.i(TAG, "BES firmware update SUCCESS! BES will reboot.");
                EventBus.getDefault().post(BesOtaProgressEvent.createFinished());
            } else {
                Log.e(TAG, "Apply firmware error");
                EventBus.getDefault().post(BesOtaProgressEvent.createFailed("Failed to apply firmware"));
            }
            // Cleanup regardless
            cleanup();
        }
    }

    private void sendOtaData() {
        // Reduced logging - only log segment boundaries, not every packet
        if (isNeedSegmentVerify()) {
            byte[] data = SCmd_SegmentVerify();
            Log.i(TAG, "🔍 Segment " + (confirmTimes + 1) + " verify - sentPos=" + sentPos + "/" + fileLen);
            send(data);
            return;
        }

        byte[] data = SCmd_SendFileData();
        if (send(data)) {
            int payloadSize = data.length - BesBaseCommand.MIN_LENGTH;
            addSentSize(payloadSize);
        } else {
            Log.e(TAG, "❌ Failed to send file data packet at sentPos=" + sentPos);
        }
    }

    private boolean send(byte[] data) {
        if (comManager == null) {
            Log.e(TAG, "send() failed - comManager is null");
            return false;
        }
        if (data == null) {
            Log.e(TAG, "send() failed - data is null");
            return false;
        }
        return comManager.sendOta(data);
    }
}


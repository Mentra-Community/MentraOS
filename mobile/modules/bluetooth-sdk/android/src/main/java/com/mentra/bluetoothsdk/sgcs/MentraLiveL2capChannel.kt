package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.utils.K900ProtocolUtils
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * L2CAP CoC (connection-oriented channel) fast path for Mentra Live file transfers.
 *
 * New BES2700 firmware registers an LE L2CAP CoC server on PSM 0x00C9. When the phone opens that
 * channel, the glasses send BLE photo file packets over it INSTEAD of GATT FILE_READ notifications.
 * The packet framing over the channel is identical to the GATT file notifications (K900 file
 * frames): ##(2) + type(1) + packSize(2, BE) + packIndex(2) + fileSize(4) + fileName(16) + flags(2)
 * + data(packSize) + verify(1) + $$(2).
 *
 * This class only READS from the channel. All phone→glasses traffic stays on GATT. If the channel
 * can't be opened (older firmware without the L2CAP server, connect timeout, etc.) we log once and
 * do nothing else — GATT notifications remain the default file path.
 *
 * Complete frames are handed to [onFileFrame] on the read thread; the caller feeds them into the
 * exact same processing path used for GATT file notifications so downstream reassembly
 * (FileTransferSession, transfer_complete) is unchanged.
 */
class MentraLiveL2capChannel(
        private val psm: Int,
        private val onFileFrame: (ByteArray) -> Unit
) {

    companion object {
        private const val TAG = "LiveL2cap"

        // BluetoothSocket.connect() has no timeout parameter; a watchdog closes the socket to
        // abort a stuck connect after this long.
        private const val CONNECT_TIMEOUT_MS = 3000L

        private const val READ_CHUNK_SIZE = 4096
        private const val MAX_BUFFER_SIZE = 64 * 1024

        // K900 file frame: ##(2) + type(1) + packSize(2) + packIndex(2) + fileSize(4) +
        // fileName(16) + flags(2) + data(packSize) + verify(1) + $$(2)
        // Total frame size = FRAME_OVERHEAD + packSize.
        private const val FRAME_HEADER_MIN = 5 // bytes needed to read packSize: ## + type + size
        private const val FRAME_OVERHEAD = 2 + 1 + 2 + 2 + 4 + 16 + 2 + 1 + 2 // = 32
    }

    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var closed = false

    /** True while the channel is connected and the read loop is running. */
    @Volatile
    var isOpen = false
        private set

    /**
     * Open the channel to [device] and start the read loop on a background thread. Never throws;
     * failures are logged and leave the GATT path untouched.
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    fun open(device: BluetoothDevice) {
        val thread = Thread({ runChannel(device) }, "MentraLive-L2CAP")
        thread.isDaemon = true
        thread.start()
    }

    /** Close the channel (call on disconnect). Safe to call multiple times / while connecting. */
    fun close() {
        closed = true
        isOpen = false
        closeSocketQuietly()
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun runChannel(device: BluetoothDevice) {
        val sock: BluetoothSocket
        try {
            sock = device.createInsecureL2capChannel(psm)
        } catch (e: Exception) { // IOException or SecurityException
            logUnavailable(e)
            return
        }
        socket = sock

        if (closed) {
            closeSocketQuietly()
            return
        }

        // Watchdog: closing the socket makes a stuck connect() throw an IOException.
        val connectDone = AtomicBoolean(false)
        val watchdog =
                Thread(
                        {
                            try {
                                Thread.sleep(CONNECT_TIMEOUT_MS)
                            } catch (ie: InterruptedException) {
                                return@Thread // connect finished in time
                            }
                            if (!connectDone.get()) {
                                Log.w(TAG, "L2CAP: connect timed out after " + CONNECT_TIMEOUT_MS + "ms")
                                closeSocketQuietly()
                            }
                        },
                        "MentraLive-L2CAP-Watchdog"
                )
        watchdog.isDaemon = true
        watchdog.start()

        try {
            sock.connect()
        } catch (e: Exception) { // IOException or SecurityException
            connectDone.set(true)
            watchdog.interrupt()
            if (!closed) {
                logUnavailable(e)
            }
            closeSocketQuietly()
            return
        }
        connectDone.set(true)
        watchdog.interrupt()

        if (closed) {
            closeSocketQuietly()
            return
        }

        isOpen = true
        Bridge.log("LIVE: L2CAP: channel open (PSM 0xC9)")

        readLoop(sock)
    }

    /**
     * Accumulate bytes from the socket, extract complete K900 file frames, and dispatch each one
     * via [onFileFrame].
     */
    private fun readLoop(sock: BluetoothSocket) {
        val readBuf = ByteArray(READ_CHUNK_SIZE)
        val acc = ByteArray(MAX_BUFFER_SIZE)
        var accSize = 0

        try {
            val input = sock.inputStream
            while (!closed) {
                val n = input.read(readBuf)
                if (n < 0) {
                    break // stream closed by peer
                }
                if (n == 0) {
                    continue
                }
                if (accSize + n > acc.size) {
                    Log.e(TAG, "L2CAP: reassembly buffer overflow, clearing buffer")
                    accSize = 0
                    if (n > acc.size) {
                        continue
                    }
                }
                System.arraycopy(readBuf, 0, acc, accSize, n)
                accSize += n
                accSize = extractAndDispatchFrames(acc, accSize)
            }
        } catch (e: IOException) {
            if (!closed) {
                Log.w(TAG, "L2CAP: read loop ended: " + e.message)
            }
        } finally {
            isOpen = false
            closeSocketQuietly()
            if (!closed) {
                Bridge.log("LIVE: L2CAP: channel closed")
            }
        }
    }

    /**
     * Extract complete K900 file frames from [buffer] (valid up to [size]) and dispatch them.
     * Mirrors the framing rules of MentraLive.extractCompleteFilePackets: scan for the ## start
     * marker, read packSize (bytes 3-4, big-endian) to compute the total frame size, wait for the
     * full frame, and verify the $$ end marker. Returns the number of unconsumed bytes remaining
     * at the front of [buffer].
     */
    private fun extractAndDispatchFrames(buffer: ByteArray, size: Int): Int {
        var pos = 0

        while (pos < size) {
            // Find start marker ## (0x23 0x23)
            var startPos = -1
            for (i in pos until size - 1) {
                if (buffer[i] == 0x23.toByte() && buffer[i + 1] == 0x23.toByte()) {
                    startPos = i
                    break
                }
            }

            if (startPos < 0) {
                // No start marker; drop everything except a possible trailing '#'
                pos = if (size > 0 && buffer[size - 1] == 0x23.toByte()) size - 1 else size
                break
            }

            pos = startPos

            // Need ##(2) + type(1) + packSize(2) to know the frame size
            if (size - pos < FRAME_HEADER_MIN) {
                break // wait for more data
            }

            // packSize is big-endian at bytes 3-4 (same as the GATT reassembly path)
            val packSize =
                    ((buffer[pos + 3].toInt() and 0xFF) shl 8) or (buffer[pos + 4].toInt() and 0xFF)

            if (packSize < 0 || packSize > K900ProtocolUtils.FILE_PACK_SIZE) {
                Log.w(TAG, "L2CAP: invalid packSize " + packSize + ", skipping start marker")
                pos += 1
                continue
            }

            val frameSize = FRAME_OVERHEAD + packSize
            if (size - pos < frameSize) {
                break // wait for the rest of the frame
            }

            // Verify end marker $$ at the expected position
            val endMarkerPos = pos + frameSize - 2
            if (buffer[endMarkerPos] != 0x24.toByte() || buffer[endMarkerPos + 1] != 0x24.toByte()) {
                Log.w(
                        TAG,
                        "L2CAP: end marker $$ not found (packSize=" +
                                packSize +
                                "), skipping start marker"
                )
                pos += 1
                continue
            }

            val frame = ByteArray(frameSize)
            System.arraycopy(buffer, pos, frame, 0, frameSize)
            try {
                onFileFrame(frame)
            } catch (t: Throwable) {
                Log.e(TAG, "L2CAP: onFileFrame threw", t)
            }

            pos += frameSize
        }

        // Compact unconsumed bytes to the front of the buffer
        val remaining = size - pos
        if (remaining > 0 && pos > 0) {
            System.arraycopy(buffer, pos, buffer, 0, remaining)
        }
        return if (remaining > 0) remaining else 0
    }

    private fun logUnavailable(e: Exception) {
        Bridge.log("LIVE: L2CAP: unavailable, staying on GATT (" + e.javaClass.simpleName + ")")
    }

    private fun closeSocketQuietly() {
        val sock = socket ?: return
        try {
            sock.close()
        } catch (e: IOException) {
            // ignore
        }
    }
}

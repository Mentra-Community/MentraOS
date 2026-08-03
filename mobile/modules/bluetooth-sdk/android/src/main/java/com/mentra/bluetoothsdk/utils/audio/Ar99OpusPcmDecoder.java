package com.mentra.bluetoothsdk.utils.audio;

import android.util.Log;

import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;

import io.github.jaredmdobson.OpusDecoder;
import io.github.jaredmdobson.OpusException;

/**
 * AR99 Opus decoder worker.
 *
 * <p>The caller feeds BLE notify bytes through {@link #submitBleNotify(byte[])}. This class owns
 * queueing, frame reassembly, Opus decoder state, and decoded PCM callbacks.
 */
public final class Ar99OpusPcmDecoder extends Thread {
  public interface Callback {
    void onPcmDecoded(byte[] pcmData);

    default void onNotifyProcessed(int rawLen, int pcmFrames, int pcmBytesOut) {}
  }

  private enum TaskType {
    DECODE,
    RESET,
    STOP
  }

  private static final class Task {
    final TaskType type;
    final byte[] payload;

    Task(TaskType type, byte[] payload) {
      this.type = type;
      this.payload = payload;
    }
  }

  private static final int SAMPLE_RATE = 16000;
  private static final int CHANNELS = 1;
  private static final int MAX_FRAME_SAMPLES = 5760;
  private static final int FRAME_BYTES = 48;
  private static final int HEADER_BYTES = 8;
  private static final int MAX_BUFFER_SIZE = 10000;
  private static final int TASK_QUEUE_CAPACITY = 256;
  private static final int MAX_DIAG_FRAMES = 8;
  private static final byte[] EXPECTED_PREFIX = new byte[] {0x00, 0x00, 0x00, 0x28};
  private static final String TAG = "Ar99OpusPcmDecoder";

  private final Callback callback;
  private final OpusDecoder decoder;
  private final ArrayBlockingQueue<Task> taskQueue = new ArrayBlockingQueue<>(TASK_QUEUE_CAPACITY);

  private volatile boolean running = true;

  private byte[] buffer = new byte[0];
  private long totalNotifyCount = 0L;
  private long totalFrameCount = 0L;
  private long totalDecodeFailCount = 0L;
  private long totalHeaderMismatchCount = 0L;
  private long totalShortChunkCount = 0L;
  private long totalResyncDropBytes = 0L;
  private boolean headerLooksStable = true;

  public Ar99OpusPcmDecoder(Callback callback) throws OpusException {
    super("ar99-opus-decode");
    this.callback = callback;
    this.decoder = new OpusDecoder(SAMPLE_RATE, CHANNELS);
    start();
  }

  public void submitBleNotify(byte[] opusPayload) {
    if (!running || opusPayload == null || opusPayload.length == 0) {
      return;
    }
    byte[] payloadCopy = Arrays.copyOf(opusPayload, opusPayload.length);
    if (!taskQueue.offer(new Task(TaskType.DECODE, payloadCopy))) {
      Log.w(TAG, "AR99 Opus task queue full, drop notify len=" + payloadCopy.length);
    }
  }

  public void resetSession() {
    if (!running) {
      return;
    }
    taskQueue.clear();
    taskQueue.offer(new Task(TaskType.RESET, null));
  }

  public void resetBuffer() {
    resetSession();
  }

  public void shutdownDecoder() {
    if (!running) {
      return;
    }
    running = false;
    taskQueue.clear();
    taskQueue.offer(new Task(TaskType.STOP, null));
  }

  public synchronized byte[] decodePacketToPcm16Mono(byte[] opusPayload) {
    return decodePayload(opusPayload);
  }

  @Override
  public void run() {
    try {
      while (true) {
        Task task = taskQueue.take();
        if (task.type == TaskType.STOP) {
          break;
        }
        if (task.type == TaskType.RESET) {
          resetDecoderState();
          continue;
        }
        if (task.payload != null && task.payload.length > 0) {
          handleChunk(task.payload);
        }
      }
    } catch (InterruptedException e) {
      if (running) {
        Log.w(TAG, "AR99 Opus worker interrupted: " + e.getMessage());
      }
    } finally {
      taskQueue.clear();
      resetDecoderState();
    }
  }

  private synchronized void resetDecoderState() {
    decoder.resetState();
    buffer = new byte[0];
    totalNotifyCount = 0L;
    totalFrameCount = 0L;
    totalDecodeFailCount = 0L;
    totalHeaderMismatchCount = 0L;
    totalShortChunkCount = 0L;
    totalResyncDropBytes = 0L;
    headerLooksStable = true;
  }

  private synchronized void handleChunk(byte[] chunk) {
    totalNotifyCount++;
    if (chunk.length < FRAME_BYTES) {
      totalShortChunkCount++;
    }

    if (buffer.length + chunk.length > MAX_BUFFER_SIZE) {
      Log.w(
          TAG,
          "AR99 Opus buffer overflow, clear"
              + ", oldBuf="
              + buffer.length
              + ", chunk="
              + chunk.length
              + ", notify#="
              + totalNotifyCount);
      buffer = new byte[0];
    }

    int oldBufferLen = buffer.length;
    buffer = concat(buffer, chunk);

    int pcmFrames = 0;
    int pcmBytesOut = 0;
    int decodeFail = 0;
    int skipPayload = 0;
    int headerMismatch = 0;

    while (buffer.length >= EXPECTED_PREFIX.length) {
      int frameStart = findFrameStart(buffer, 0);
      if (frameStart < 0) {
        int keep = Math.min(buffer.length, EXPECTED_PREFIX.length - 1);
        int drop = buffer.length - keep;
        if (drop > 0) {
          totalResyncDropBytes += drop;
          headerLooksStable = false;
          Log.w(
              TAG,
              "AR99 Opus resync drop(no header)"
                  + " notify#="
                  + totalNotifyCount
                  + " dropBytes="
                  + drop
                  + " keepTail="
                  + keep
                  + " tailHex="
                  + hex(Arrays.copyOfRange(buffer, drop, buffer.length), keep));
          buffer = Arrays.copyOfRange(buffer, drop, buffer.length);
        }
        break;
      }

      if (frameStart > 0) {
        totalResyncDropBytes += frameStart;
        headerLooksStable = false;
        headerMismatch++;
        totalHeaderMismatchCount++;
        Log.w(
            TAG,
            "AR99 Opus resync shift"
                + " notify#="
                + totalNotifyCount
                + " dropBytes="
                + frameStart
                + " bufLen="
                + buffer.length
                + " droppedHex="
                + hex(Arrays.copyOfRange(buffer, 0, frameStart), Math.min(frameStart, 24)));
        buffer = Arrays.copyOfRange(buffer, frameStart, buffer.length);
      }

      if (buffer.length < FRAME_BYTES) {
        break;
      }

      byte[] frame = Arrays.copyOfRange(buffer, 0, FRAME_BYTES);
      buffer = Arrays.copyOfRange(buffer, FRAME_BYTES, buffer.length);
      totalFrameCount++;

      boolean prefixOk = true;
      for (int i = 0; i < EXPECTED_PREFIX.length; i++) {
        if (frame[i] != EXPECTED_PREFIX[i]) {
          prefixOk = false;
          break;
        }
      }
      if (!prefixOk) {
        headerMismatch++;
        totalHeaderMismatchCount++;
        headerLooksStable = false;
        if (totalFrameCount <= MAX_DIAG_FRAMES || !headerLooksStable) {
          Log.w(
              TAG,
              "AR99 Opus frame header mismatch"
                  + " frame#="
                  + totalFrameCount
                  + " notify#="
                  + totalNotifyCount
                  + " remain="
                  + buffer.length
                  + " frameHex="
                  + hex(frame, FRAME_BYTES));
        }
      }

      byte[] opusPayload = Arrays.copyOfRange(frame, HEADER_BYTES, FRAME_BYTES);
      if (opusPayload.length == 0) {
        skipPayload++;
        continue;
      }

      byte[] pcm = decodePayload(opusPayload);
      if (pcm != null && pcm.length > 0) {
        pcmFrames++;
        pcmBytesOut += pcm.length;
        if (callback != null) {
          callback.onPcmDecoded(pcm);
        }
      } else {
        decodeFail++;
        totalDecodeFailCount++;
        if (totalFrameCount <= MAX_DIAG_FRAMES || !headerLooksStable) {
          Log.w(
              TAG,
              "AR99 Opus frame decode failed"
                  + " frame#="
                  + totalFrameCount
                  + " notify#="
                  + totalNotifyCount
                  + " prefixOk="
                  + prefixOk
                  + " frameHex="
                  + hex(frame, FRAME_BYTES)
                  + " payloadHex="
                  + hex(opusPayload, opusPayload.length));
        }
      }
    }

    if (chunk.length != FRAME_BYTES
        || oldBufferLen != 0
        || decodeFail > 0
        || headerMismatch > 0
        || skipPayload > 0
        || pcmFrames == 0
        || !headerLooksStable) {
      Log.d(
          TAG,
          "AR99 Opus decode summary"
              + " notify#="
              + totalNotifyCount
              + " inLen="
              + chunk.length
              + " pcmFrames="
              + pcmFrames
              + " decodeFail="
              + decodeFail
              + " headerMismatch="
              + headerMismatch
              + " skipPayload="
              + skipPayload
              + " bufRemain="
              + buffer.length
              + " totals={frames="
              + totalFrameCount
              + ",fail="
              + totalDecodeFailCount
              + ",headerMismatch="
              + totalHeaderMismatchCount
              + ",shortChunk="
              + totalShortChunkCount
              + ",resyncDropBytes="
              + totalResyncDropBytes
              + "}");
    }

    if (callback != null) {
      callback.onNotifyProcessed(chunk.length, pcmFrames, pcmBytesOut);
    }
  }

  private byte[] decodePayload(byte[] opusPayload) {
    if (opusPayload == null || opusPayload.length == 0) {
      return null;
    }
    byte[] pcm = new byte[MAX_FRAME_SAMPLES * CHANNELS * 2];
    try {
      int samples = decoder.decode(opusPayload, 0, opusPayload.length, pcm, 0, MAX_FRAME_SAMPLES, false);
      if (samples <= 0) {
        return null;
      }
      int bytes = samples * CHANNELS * 2;
      return Arrays.copyOf(pcm, bytes);
    } catch (OpusException | AssertionError | RuntimeException e) {
      Log.w(
          TAG,
          "AR99 Opus decode failed len="
              + opusPayload.length
              + ", payloadHex="
              + hex(opusPayload, opusPayload.length)
              + ": "
              + e.getMessage());
      return null;
    }
  }

  private static int findFrameStart(byte[] data, int fromIndex) {
    if (data == null || data.length < EXPECTED_PREFIX.length) {
      return -1;
    }
    int max = data.length - EXPECTED_PREFIX.length;
    for (int i = Math.max(0, fromIndex); i <= max; i++) {
      boolean match = true;
      for (int j = 0; j < EXPECTED_PREFIX.length; j++) {
        if (data[i + j] != EXPECTED_PREFIX[j]) {
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

  private static String hex(byte[] data, int maxBytes) {
    if (data == null || data.length == 0 || maxBytes <= 0) {
      return "";
    }
    int len = Math.min(data.length, maxBytes);
    StringBuilder sb = new StringBuilder(len * 3);
    for (int i = 0; i < len; i++) {
      if (i > 0) {
        sb.append(' ');
      }
      sb.append(String.format("%02X", data[i] & 0xFF));
    }
    if (data.length > len) {
      sb.append("...");
    }
    return sb.toString();
  }

  private static byte[] concat(byte[] a, byte[] b) {
    if (a.length == 0) {
      return Arrays.copyOf(b, b.length);
    }
    byte[] out = Arrays.copyOf(a, a.length + b.length);
    System.arraycopy(b, 0, out, a.length, b.length);
    return out;
  }
}

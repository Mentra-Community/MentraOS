/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers;

import static com.google.common.base.Preconditions.checkArgument;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build.VERSION;
import android.os.Build.VERSION_CODES;

import com.google.audio.CodecAndBitrate;
import com.google.common.collect.ImmutableList;
import com.google.common.flogger.FluentLogger;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Converts from uncompressed 16-bit PCM data to encoded data.
 *
 * <p>You may call the sequence (init, processAudioBytes, ..., processAudioBytes, flush, stop)
 * multiple times.
 *
 * <p>Note that AMR-WB encoding is mandatory for handheld devices and OggOpus is supported
 * regardless of device.
 */
// Based on examples from https://developer.android.com/reference/android/media/MediaCodec
// and some reference tests:
// https://android.googlesource.com/platform/cts/+/jb-mr2-release/tests/tests/media/src/android/media/cts/EncoderTest.java
public class StreamingAudioEncoder {
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();
  private static final int BYTES_PER_SAMPLE = 2;

  // This is not meaningful for OggOpus, which does not rely on the AndroidSystemEncoder.
  private boolean useDeprecatedEncoder = false;

  /** State variables for basic control flow management. */
  private boolean flushed;

  private boolean initialized = false;

  /** An exception for anything that goes wrong with the coder as a result of misuse. */
  public static class EncoderException extends Exception {
    public EncoderException(String message) {
      super(message);
    }
  }

  /** Describes the general class of codecs. */
  public enum CodecType {
    UNSPECIFIED,
    AMRWB,
    FLAC,
    OGG_OPUS,
  }

  CodecType codecType = CodecType.UNSPECIFIED;

  private StreamingAudioInternalEncoder impl;

  /** Creates an audio encoder. */
  public StreamingAudioEncoder(boolean useDeprecatedEncoder) {
    this.useDeprecatedEncoder = useDeprecatedEncoder;
  }

  public StreamingAudioEncoder() {
    this(VERSION.SDK_INT <= VERSION_CODES.KITKAT_WATCH);
  }

  private interface StreamingAudioInternalEncoder {
    void init(int sampleRateHz, CodecAndBitrate codecAndBitrate, boolean useVbr)
        throws EncoderException, IOException;

    byte[] processAudioBytes(byte[] input, int offset, int length);

    byte[] flushAndStop();
  }

  /**
   * Prepares a codec to stream. This may be called only if instance is uninitialized (prior to a
   * call to init() or after a call to stop()).
   *
   * @throws IOException if codec cannot be created.
   * @throws EncoderException if sample rate is not 16kHz or if no suitable encoder exists on device
   *     for the requested format.
   */
  public void init(int sampleRateHz, CodecAndBitrate codecAndBitrate, boolean allowVbr)
      throws EncoderException, IOException {
    codecType = lookupCodecType(codecAndBitrate);

    if (codecType == CodecType.OGG_OPUS) {
      impl = new OggOpusEncoder();
    } else {
      impl = new AndroidSystemEncoder(useDeprecatedEncoder);
    }
    impl.init(sampleRateHz, codecAndBitrate, allowVbr);
    initialized = true;
    flushed = false;
  }

  /**
   * Encodes 16-bit PCM audio. This will not always return bytes and will block until the codec has
   * no output to offer. Must be called after init().
   *
   * @param input array of audio samples formatted as raw bytes (i.e., two bytes per sample). buffer
   *     may be of any size.
   * @param offset the offset of the first byte to process
   * @param length the number of bytes to process from input
   * @return bytes of compressed audio
   */
  public byte[] processAudioBytes(byte[] input, int offset, int length) {
    if (!initialized) {
      throw new IllegalStateException("You forgot to call init()!");
    }
    if (flushed) {
      throw new IllegalStateException("Cannot process more bytes after flushing.");
    }
    return impl.processAudioBytes(input, offset, length);
  }

  public byte[] processAudioBytes(byte[] input) {
    return processAudioBytes(input, 0, input.length);
  }

  /** Stop the codec. Call init() before using again. */
  public byte[] flushAndStop() {
    if (!initialized) {
      throw new IllegalStateException("You forgot to call init()!");
    }
    if (flushed) {
      throw new IllegalStateException("Already flushed. You must reinitialize.");
    }
    flushed = true;
    byte[] flushedBytes = impl.flushAndStop();
    initialized = false;
    codecType = CodecType.UNSPECIFIED;
    return flushedBytes;
  }

  /**
   * Can be used to test if codec will work or not on a given device. This will always return the
   * same value no matter when you call it.
   */
  public static boolean isEncoderSupported(CodecAndBitrate encoderInfo) {
    CodecType type = lookupCodecType(encoderInfo);
    if (type == CodecType.OGG_OPUS) { // We support Opus directly via the OggOpusEncoder class.
      return true;
    }
    return searchAmongAndroidSupportedCodecs(getMime(type)) != null;
  }

  public CodecType getCodecType() {
    return codecType;
  }

  private static String getMime(CodecType codecAndBitrate) {
    // MediaFormat.MIMETYPE_AUDIO_AMR_WB requires SDK >= 21.
    switch (codecAndBitrate) {
      case AMRWB:
        return "audio/amr-wb";
      case FLAC:
        return "audio/flac";
      case OGG_OPUS: // Not supported by android system, so we don't need a MIME.
      case UNSPECIFIED:
        return "";
    }
    return "";
  }

  private static CodecType lookupCodecType(CodecAndBitrate codecAndBitrate) {
    switch (codecAndBitrate) {
      case AMRWB_BITRATE_6KBPS:
      case AMRWB_BITRATE_8KBPS:
      case AMRWB_BITRATE_12KBPS:
      case AMRWB_BITRATE_14KBPS:
      case AMRWB_BITRATE_15KBPS:
      case AMRWB_BITRATE_18KBPS:
      case AMRWB_BITRATE_19KBPS:
      case AMRWB_BITRATE_23KBPS:
      case AMRWB_BITRATE_24KBPS:
        return CodecType.AMRWB;
      case FLAC:
        return CodecType.FLAC;
      case OGG_OPUS_BITRATE_12KBPS:
      case OGG_OPUS_BITRATE_16KBPS:
      case OGG_OPUS_BITRATE_24KBPS:
      case OGG_OPUS_BITRATE_32KBPS:
      case OGG_OPUS_BITRATE_64KBPS:
      case OGG_OPUS_BITRATE_96KBPS:
      case OGG_OPUS_BITRATE_128KBPS:
        return CodecType.OGG_OPUS;
      case UNDEFINED:
        return CodecType.UNSPECIFIED;
    }
    return CodecType.UNSPECIFIED;
  }

  /**
   * Searches for a codec that implements the requested format conversion. Android framework encoder
   * only.
   */
  private static MediaCodecInfo searchAmongAndroidSupportedCodecs(String mimeType) {
    int numCodecs = MediaCodecList.getCodecCount();
    for (int i = 0; i < numCodecs; i++) {
      MediaCodecInfo codecAndBitrate = MediaCodecList.getCodecInfoAt(i);
      if (!codecAndBitrate.isEncoder()) {
        continue;
      }
      String[] codecTypes = codecAndBitrate.getSupportedTypes();
      for (int j = 0; j < codecTypes.length; j++) {
        if (codecTypes[j].equalsIgnoreCase(mimeType)) {
          return codecAndBitrate;
        }
      }
    }
    return null;
  }

  /** An encoder that relies on the Android framework's multimedia encoder. */
  private static class AndroidSystemEncoder implements StreamingAudioInternalEncoder {
    // If we can't supply a buffer immediately, we wait until the next one, which is timed at the
    // microphone & block rate of the audio supplier. Waiting less than that time and getting
    // samples
    // before the next input buffer would reduce latency.
    private static final long WAIT_TIME_MICROSECONDS = 1000; // Joda doesn't support microseconds.
    /**
     * Notes when the codec formatting change has occurred. This should happen only once at the
     * start of streaming. Otherwise, there is an error.
     */
    private boolean formatChangeReportedOnce;

    private MediaCodec codec;
    private boolean useDeprecatedEncoder = false;
    private CodecType codecType;
    private int sampleRateHz;

    /** Prevents trying to flush multiple times. */
    private boolean successfullyFlushed;

    /** Keeps track of whether the header was injected into the stream. */
    private boolean addedHeader;

    /**
     * The number of samples that are passed to the underlying codec at once. It's not clear that
     * one value for this will work better than any other, but powers of two are usually fast, and a
     * larger CHUNK_SIZE_SAMPLES both reduces the number of buffers we have to wait for and doesn't
     * prevent sending smaller blocks of samples.
     */
    private static final int CHUNK_SIZE_SAMPLES = 2048;

    private static final int CHUNK_SIZE_BYTES = BYTES_PER_SAMPLE * CHUNK_SIZE_SAMPLES;

    // Used only on very old SDKs (pre VERSION_CODES.KITKAT_WATCH).
    private ByteBuffer[] inputBuffersPreKitKat;
    private ByteBuffer[] outputBuffersPreKitKat;

    /** Creates an audio encoder. */
    public AndroidSystemEncoder(boolean useDeprecatedEncoder) {
      this.useDeprecatedEncoder = useDeprecatedEncoder;
      this.codecType = CodecType.UNSPECIFIED;
    }

    // Note that VBR is not currently supported for the AndroidStreamingEncoder.
    @Override
    public void init(int sampleRateHz, CodecAndBitrate codecAndBitrate, boolean allowVbr)
        throws EncoderException, IOException {
      codecType = lookupCodecType(codecAndBitrate);
      if (codecType == CodecType.UNSPECIFIED || codecType == CodecType.OGG_OPUS) {
        throw new EncoderException("Codec not set properly.");
      }
      if (codecType == CodecType.AMRWB && sampleRateHz != 16000) {
        throw new EncoderException("AMR-WB encoder requires a sample rate of 16kHz.");
      }
      MediaCodecInfo codecInfo = searchAmongAndroidSupportedCodecs(getMime(codecType));
      if (codecInfo == null) {
        throw new EncoderException("Encoder not found.");
      }
      this.codec = MediaCodec.createByCodecName(codecInfo.getName());

      MediaFormat format = getMediaFormat(codecAndBitrate, sampleRateHz);
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
      codec.start();
      initBuffers();

      addedHeader = false;
      successfullyFlushed = false;
      formatChangeReportedOnce = false;
    }

    @Override
    public byte[] processAudioBytes(byte[] input, int offset, int length) {
      ByteArrayOutputStream outputBytes = new ByteArrayOutputStream();
      if (!addedHeader) {
        try {
          outputBytes.write(getHeaderBytes());
        } catch (IOException e) {
          logger.atSevere().log("Unable to write bytes into buffer!");
        }
        addedHeader = true;
      }
      int startByte = 0;
      while (startByte < length) {
        int thisChunkSizeBytes = Math.min(CHUNK_SIZE_BYTES, length - startByte);
        processAudioBytesInternal(
            input, offset + startByte, thisChunkSizeBytes, false, outputBytes);
        startByte += thisChunkSizeBytes;
      }
      return outputBytes.toByteArray();
    }

    @Override
    public byte[] flushAndStop() {
      ByteArrayOutputStream outputBytes = new ByteArrayOutputStream();
      try {
        processAudioBytesInternal(null, 0, 0, true, outputBytes);  // Flush!
        codec.stop();
      } catch (MediaCodec.CodecException e) {
        logger.atSevere().log("Something went wrong in the underlying codec!");
      }
      codec.release();
      return outputBytes.toByteArray();
    }

    // length must be less than or equal to CHUNK_SIZE_BYTES.
    private void processAudioBytesInternal(
        byte[] input, int offset, int length, boolean flush, ByteArrayOutputStream outputBytes) {
      checkArgument(
          length <= CHUNK_SIZE_BYTES, "length must be less than or equal to CHUNK_SIZE_BYTES!");
      boolean processedInput = false;
      // There are a limited number of buffers allocated in the codec. As long as we're not
      // holding on to them, they should always be available. Sometimes all buffers will be occupied
      // by the output and we need to process them before pushing input. Sometimes multiple output
      // buffers will be available at once. Append them together and return. It is common for
      // outputBytes to not receive any samples upon returning.
      MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();
      // Loop until input is processed and outputs are unavailable.
      while (!processedInput || flush) {
        if (!processedInput) {
          if (flush && successfullyFlushed) {
            throw new IllegalStateException("Already flushed!");
          }
          // Push the input only once.
          int inputBufferIndex = codec.dequeueInputBuffer(WAIT_TIME_MICROSECONDS);
          if (inputBufferIndex != MediaCodec.INFO_TRY_AGAIN_LATER) {
            if (flush) {
              // Signal that the input stream is complete.
              codec.queueInputBuffer(
                  inputBufferIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
              successfullyFlushed = true;
            } else {
              // Push audio data into the codec.
              ByteBuffer inputBuffer = getInputBuffer(inputBufferIndex);
              inputBuffer.put(input, offset, length);
              codec.queueInputBuffer(inputBufferIndex, 0, length, 0, 0);
            }
            processedInput = true;
          }
        }
        // See if outputs are available.
        int outputBufferIndex = codec.dequeueOutputBuffer(bufferInfo, WAIT_TIME_MICROSECONDS);
        if (outputBufferIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
          // There will not be an output buffer for every input buffer.
        } else if (outputBufferIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          // Shouldn't happen after the very first output.
          if (formatChangeReportedOnce) {
            throw new IllegalStateException("The codec format was unexpectedly changed.");
          }
          formatChangeReportedOnce = true;
        } else if (outputBufferIndex == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED) {
          // Shouldn't happen for SDK > 21.
          updateOutputBuffers();
        } else {
          // Get an output buffer and add it to the stream.
          ByteBuffer outputBuffer = getOutputBuffer(outputBufferIndex);
          byte[] outData = new byte[bufferInfo.size];
          outputBuffer.get(outData);
          codec.releaseOutputBuffer(outputBufferIndex, false);
          try {
            outputBytes.write(outData);
          } catch (IOException e) {
            logger.atSevere().log("Unable to write bytes into buffer!");
          }
        }

        boolean processedAllOutput = (bufferInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
        if (processedAllOutput) {
          if (!processedInput) {
            throw new IllegalStateException("Didn't process input yet.");
          }
          break;
        }
      }
    }

    /** Configure the codec at a specified bitrate for a fixed sample block size. */
    private static MediaFormat getMediaFormat(CodecAndBitrate codecAndBitrate, int sampleRateHz) {
      MediaFormat format = new MediaFormat();
      CodecType codecType = lookupCodecType(codecAndBitrate);
      format.setString(MediaFormat.KEY_MIME, getMime(codecType));
      format.setInteger(MediaFormat.KEY_SAMPLE_RATE, sampleRateHz);
      format.setInteger(MediaFormat.KEY_CHANNEL_COUNT, 1);
      format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, BYTES_PER_SAMPLE * CHUNK_SIZE_SAMPLES);
      if (codecType != CodecType.FLAC) {
        // FLAC is lossless, we can't request a bitrate.
        format.setInteger(MediaFormat.KEY_BIT_RATE, codecAndBitrate.getNumber());
      }
      return format;
    }

    /** The data does not include a header. Some applications will require one anyhow. */
    private byte[] getHeaderBytes() {
      switch (this.codecType) {
        case AMRWB:
          String amrWbHeader = "#!AMR-WB\n";
          return amrWbHeader.getBytes();
        case FLAC:
          byte[] noHeader = new byte[0];
          return noHeader;
        case OGG_OPUS:
          throw new IllegalStateException("Should never happen! Use OggOpusEncoder instead.");
        case UNSPECIFIED:
          throw new IllegalStateException("Trying to make header for unspecified codec!");
      }
      return null;
    }

    // The following methods are used to resolve differences between SDK versions.

    private void initBuffers() {
      if (useDeprecatedEncoder) {
        inputBuffersPreKitKat = codec.getInputBuffers();
        outputBuffersPreKitKat = codec.getOutputBuffers();
      }
    }

    private ByteBuffer getInputBuffer(int index) {
      if (useDeprecatedEncoder) {
        return inputBuffersPreKitKat[index];
      } else {
        return codec.getInputBuffer(index);
      }
    }

    private ByteBuffer getOutputBuffer(int index) {
      if (useDeprecatedEncoder) {
        return outputBuffersPreKitKat[index];
      } else {
        return codec.getOutputBuffer(index);
      }
    }

    private void updateOutputBuffers() {
      if (useDeprecatedEncoder) {
        outputBuffersPreKitKat = codec.getOutputBuffers();
      }
    }
  }

  private static class OggOpusEncoder implements StreamingAudioInternalEncoder {
    // This is a pointer to the native object that we're working with. Zero when unallocated.
    private long instance = 0;

    ImmutableList<Integer> validSampleRates = ImmutableList.of(8000, 12000, 16000, 24000, 48000);
    public OggOpusEncoder() {}

    @Override
    public void init(int sampleRateHz, CodecAndBitrate codecAndBitrate, boolean allowVbr)
        throws EncoderException {
      if (instance != 0) {
        flushAndStop();
      }
      CodecType codecType = lookupCodecType(codecAndBitrate);
      if (codecType != CodecType.OGG_OPUS) {
        throw new RuntimeException("Made OggOpusEncoder for non OGG_OPUS encoding type.");
      }
      if (!validSampleRates.contains(sampleRateHz)) {
        throw new EncoderException(
            "Opus encoder requires a sample rate of 8kHz, 12kHz, 16kHz, 24kHz, or 48kHz.");
      }
      this.instance =
          init(1 /* Mono audio. */, codecAndBitrate.getNumber(), sampleRateHz, allowVbr);
    }

    private native long init(int channels, int bitrate, int sampleRateHz, boolean allowVbr);

    @Override
    public byte[] processAudioBytes(byte[] bytes, int offset, int length) {
      return processAudioBytes(instance, bytes, offset, length);
    }

    private native byte[] processAudioBytes(long instance, byte[] samples, int offset, int length);

    /**
     * Complete the input stream, return any remaining bits of the output stream, and stop.
     * This should only be called once. Must be called after init().
     *
     * @return bytes of compressed audio
     */
    @Override
    public byte[] flushAndStop() {
      if (instance != 0) {
        byte[] flushedBytes = flush(instance);
        free(instance);
        instance = 0;
        return flushedBytes;
      } else {
        logger.atSevere().log("stop() called multiple times or without call to init()!");
        return new byte[0];
      }
    }

    @Override
    protected void finalize() throws Throwable {
      super.finalize();
      if (instance != 0) {
        logger.atSevere().log(
            "Native OggOpusEncoder resources weren't cleaned up. You must call stop()!");
        free(instance);
      }
    }

    private native byte[] flush(long instance);
    private native void free(long instance);
  }

  static {
    System.loadLibrary("ogg_opus_encoder");
  }
}

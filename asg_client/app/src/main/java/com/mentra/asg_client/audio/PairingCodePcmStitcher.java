package com.mentra.asg_client.audio;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Concatenates pairing-character WAVs into one PCM phrase with silence trimmed and a short
 * linear crossfade between clips, so the code is heard as {@code Ay-one-bee-two} rather than four
 * separate announcements.
 */
public final class PairingCodePcmStitcher {

    private static final String TAG = "PairingCodePcmStitcher";
    static final int CROSSFADE_MS = 60;
    static final int SILENCE_THRESHOLD = 512;
    private static final String CACHE_PREFIX = "pairing_code_";
    private static final String CACHE_SUFFIX = ".wav";

    private PairingCodePcmStitcher() {}

    public static File stitchCodeToCache(Context context, String code) throws IOException {
        List<byte[]> wavs = new ArrayList<>();
        for (int i = 0; i < code.length(); i++) {
            String asset = AudioAssets.getPairingCharAsset(code.charAt(i));
            if (asset == null) {
                throw new IOException("unsupported pairing character '" + code.charAt(i) + "'");
            }
            wavs.add(readAssetBytes(context, asset));
        }
        byte[] stitched = stitchWavs(wavs);
        File out = File.createTempFile(CACHE_PREFIX, CACHE_SUFFIX, context.getCacheDir());
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(stitched);
        }
        Log.i(
                TAG,
                "stitched pairing code clips="
                        + wavs.size()
                        + " bytes="
                        + stitched.length
                        + " -> "
                        + out.getAbsolutePath());
        return out;
    }

    static byte[] stitchWavs(List<byte[]> wavFiles) throws IOException {
        if (wavFiles == null || wavFiles.isEmpty()) {
            throw new IOException("no pairing clips to stitch");
        }
        PcmClip first = decodePcmWav(wavFiles.get(0));
        int sampleRate = first.sampleRate;
        short[] acc = trimSilence(first.samples);
        for (int i = 1; i < wavFiles.size(); i++) {
            PcmClip next = decodePcmWav(wavFiles.get(i));
            if (next.sampleRate != sampleRate) {
                throw new IOException(
                        "sample rate mismatch: " + sampleRate + " vs " + next.sampleRate);
            }
            acc = crossfade(acc, trimSilence(next.samples), msToSamples(CROSSFADE_MS, sampleRate));
        }
        return encodePcmWav(acc, sampleRate);
    }

    static short[] trimSilence(short[] samples) {
        if (samples.length == 0) {
            return samples;
        }
        int start = 0;
        while (start < samples.length && Math.abs(samples[start]) < SILENCE_THRESHOLD) {
            start++;
        }
        int end = samples.length - 1;
        while (end > start && Math.abs(samples[end]) < SILENCE_THRESHOLD) {
            end--;
        }
        if (start >= end) {
            return new short[] {0};
        }
        short[] trimmed = new short[end - start + 1];
        System.arraycopy(samples, start, trimmed, 0, trimmed.length);
        return trimmed;
    }

    static short[] crossfade(short[] left, short[] right, int overlap) {
        int fade = Math.min(overlap, Math.min(left.length, right.length));
        if (fade <= 0) {
            short[] out = new short[left.length + right.length];
            System.arraycopy(left, 0, out, 0, left.length);
            System.arraycopy(right, 0, out, left.length, right.length);
            return out;
        }
        short[] out = new short[left.length + right.length - fade];
        System.arraycopy(left, 0, out, 0, left.length - fade);
        for (int i = 0; i < fade; i++) {
            float t = (i + 1) / (float) (fade + 1);
            int mixed =
                    Math.round(left[left.length - fade + i] * (1f - t) + right[i] * t);
            if (mixed > Short.MAX_VALUE) {
                mixed = Short.MAX_VALUE;
            } else if (mixed < Short.MIN_VALUE) {
                mixed = Short.MIN_VALUE;
            }
            out[left.length - fade + i] = (short) mixed;
        }
        System.arraycopy(right, fade, out, left.length, right.length - fade);
        return out;
    }

    static int msToSamples(int ms, int sampleRate) {
        return Math.max(1, (int) ((ms * (long) sampleRate) / 1000L));
    }

    static PcmClip decodePcmWav(byte[] wav) throws IOException {
        if (wav.length < 44) {
            throw new IOException("WAV too short");
        }
        ByteBuffer buf = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        if (!asciiEquals(wav, 0, "RIFF") || !asciiEquals(wav, 8, "WAVE")) {
            throw new IOException("not a RIFF/WAVE file");
        }
        int offset = 12;
        int sampleRate = 0;
        int channels = 0;
        int bitsPerSample = 0;
        byte[] pcm = null;
        while (offset + 8 <= wav.length) {
            String chunkId = new String(wav, offset, 4, StandardCharsets.US_ASCII);
            int chunkSize = buf.getInt(offset + 4);
            int dataStart = offset + 8;
            if ("fmt ".equals(chunkId)) {
                int audioFormat = buf.getShort(dataStart) & 0xFFFF;
                channels = buf.getShort(dataStart + 2) & 0xFFFF;
                sampleRate = buf.getInt(dataStart + 4);
                bitsPerSample = buf.getShort(dataStart + 14) & 0xFFFF;
                if (audioFormat != 1) {
                    throw new IOException("only PCM WAV is supported, format=" + audioFormat);
                }
                if (channels != 1 || bitsPerSample != 16) {
                    throw new IOException(
                            "expected 16-bit mono PCM, got channels="
                                    + channels
                                    + " bits="
                                    + bitsPerSample);
                }
            } else if ("data".equals(chunkId)) {
                if (dataStart + chunkSize > wav.length) {
                    throw new IOException("WAV data chunk truncated");
                }
                pcm = new byte[chunkSize];
                System.arraycopy(wav, dataStart, pcm, 0, chunkSize);
                break;
            }
            offset = dataStart + chunkSize + (chunkSize & 1);
        }
        if (sampleRate <= 0 || pcm == null) {
            throw new IOException("WAV missing fmt or data chunk");
        }
        short[] samples = new short[pcm.length / 2];
        ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples);
        return new PcmClip(samples, sampleRate);
    }

    static byte[] encodePcmWav(short[] samples, int sampleRate) {
        int dataBytes = samples.length * 2;
        ByteBuffer buf = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        buf.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(36 + dataBytes);
        buf.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buf.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(16);
        buf.putShort((short) 1);
        buf.putShort((short) 1);
        buf.putInt(sampleRate);
        buf.putInt(sampleRate * 2);
        buf.putShort((short) 2);
        buf.putShort((short) 16);
        buf.put("data".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(dataBytes);
        for (short sample : samples) {
            buf.putShort(sample);
        }
        return buf.array();
    }

    private static byte[] readAssetBytes(Context context, String asset) throws IOException {
        try (InputStream in = context.getAssets().open(asset);
                ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    private static boolean asciiEquals(byte[] data, int offset, String expected) {
        byte[] exp = expected.getBytes(StandardCharsets.US_ASCII);
        if (offset + exp.length > data.length) {
            return false;
        }
        for (int i = 0; i < exp.length; i++) {
            if (data[offset + i] != exp[i]) {
                return false;
            }
        }
        return true;
    }

    static final class PcmClip {
        final short[] samples;
        final int sampleRate;

        PcmClip(short[] samples, int sampleRate) {
            this.samples = samples;
            this.sampleRate = sampleRate;
        }
    }
}

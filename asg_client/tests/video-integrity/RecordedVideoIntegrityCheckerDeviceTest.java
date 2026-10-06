import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.SystemClock;

import com.mentra.asg_client.io.media.core.RecordedVideoIntegrityChecker;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.file.Files;

/** Runs the production validator against real Android media APIs without installing an APK. */
public final class RecordedVideoIntegrityCheckerDeviceTest {
    /** The argument is a disposable directory containing the synthetic MP4 fixtures. */
    public static void main(String[] args) {
        try {
            run(args);
        } catch (Throwable failure) {
            // app_process otherwise reports an uncaught assertion only to logcat and SIGKILLs
            // itself. Keep the failing case and a normal nonzero exit in the caller's test log.
            failure.printStackTrace(System.err);
            System.exit(1);
        }
    }

    private static void run(String[] args) throws Exception {
        File directory = new File(args[0]);
        File large = new File(directory, "large-first-sample.mp4");
        File small = new File(directory, "small-first-sample.mp4");
        File truncated = new File(directory, "truncated.mp4");
        Files.copy(large.toPath(), truncated.toPath());
        try (RandomAccessFile file = new RandomAccessFile(truncated, "rw")) {
            // The fast-start moov/track tables survive, but the first sample's payload does not.
            file.setLength(8192);
        }
        File garbage = new File(directory, "garbage.mp4");
        try (FileOutputStream output = new FileOutputStream(garbage)) {
            output.write(new byte[8192]);
        }
        File tiny = new File(directory, "tiny.mp4");
        try (FileOutputStream output = new FileOutputStream(tiny)) {
            output.write(new byte[128]);
        }

        expect("missing file", new File(directory, "missing.mp4"), false);
        expect("undersized file", tiny, false);
        expect("invalid container", garbage, false);
        expect("audio-only MP4", new File(directory, "audio-only.mp4"), false);

        MediaExtractor truncatedExtractor = new MediaExtractor();
        try {
            selectVideo(truncatedExtractor, truncated);
            if (truncatedExtractor.getSampleSize() > 0) {
                throw new AssertionError("Truncated fixture must have no readable video sample");
            }
        } finally {
            truncatedExtractor.release();
        }
        expect("track tables with truncated video payload", truncated, false);
        expect("small first sample", small, true);

        // Independently establish that the regression fixture is a decodable frame, not merely
        // a container that the new implementation accepts. This uses the device's AVC decoder.
        decodeLargeFirstFrame(large);
        expect("first sample larger than 256 KiB", large, true);
        System.out.println("PASS: all 7 validation cases and large-frame decode");
    }

    private static void expect(String name, File file, boolean expected) {
        boolean actual = RecordedVideoIntegrityChecker.verify(file.getAbsolutePath());
        if (actual != expected) {
            throw new AssertionError(name + ": expected " + expected + ", got " + actual);
        }
        System.out.println("PASS: " + name + " -> " + actual);
    }

    private static MediaFormat selectVideo(MediaExtractor extractor, File file) throws Exception {
        extractor.setDataSource(file.getAbsolutePath());
        for (int i = 0; i < extractor.getTrackCount(); i++) {
            MediaFormat format = extractor.getTrackFormat(i);
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/")) {
                extractor.selectTrack(i);
                return format;
            }
        }
        throw new AssertionError("Fixture has no video track: " + file);
    }

    private static void decodeLargeFirstFrame(File file) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec decoder = null;
        try {
            MediaFormat format = selectVideo(extractor, file);
            long sampleSize = extractor.getSampleSize();
            if (sampleSize <= 256 * 1024 || sampleSize > Integer.MAX_VALUE) {
                throw new AssertionError("Expected oversized first frame, got " + sampleSize);
            }
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, (int) sampleSize);
            decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
            decoder.configure(format, null, null, 0);
            decoder.start();
            boolean sampleQueued = false;
            boolean eosQueued = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long deadline = SystemClock.elapsedRealtime() + 10000;
            while (SystemClock.elapsedRealtime() < deadline) {
                if (!eosQueued) {
                    int inputIndex = decoder.dequeueInputBuffer(10000);
                    if (inputIndex >= 0) {
                        if (!sampleQueued) {
                            ByteBuffer input = decoder.getInputBuffer(inputIndex);
                            int read = extractor.readSampleData(input, 0);
                            if (read != sampleSize) throw new AssertionError("Incomplete sample");
                            decoder.queueInputBuffer(inputIndex, 0, read, 0, 0);
                            sampleQueued = true;
                        } else {
                            decoder.queueInputBuffer(inputIndex, 0, 0, 0,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            eosQueued = true;
                        }
                    }
                }
                int outputIndex = decoder.dequeueOutputBuffer(info, 10000);
                if (outputIndex >= 0) {
                    boolean decoded = info.size > 0;
                    decoder.releaseOutputBuffer(outputIndex, false);
                    if (decoded) {
                        System.out.println("PASS: decoded " + sampleSize
                                + "-byte first sample using " + decoder.getName());
                        return;
                    }
                }
            }
            throw new AssertionError("Large first frame did not decode within 10 seconds");
        } finally {
            if (decoder != null) decoder.release();
            extractor.release();
        }
    }
}

package com.mentra.asg_client.io.bes.log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.PriorityQueue;
import java.util.zip.CRC32;

/** Fakes and builders shared by the OS-1988 collector tests. */
final class BesIncidentTestSupport {
    private BesIncidentTestSupport() {}

    static final long T0 = 1_800_000_000_000L;
    static final String BOOT_A = "00000000000000a1";
    static final String BOOT_B = "00000000000000b2";
    static final String BOOT_C = "00000000000000c3";

    /** Manual virtual-time scheduler: nothing runs until the test says so. */
    static final class FakeScheduler implements BesCrashDumpCollector.Scheduler {
        static final class Task implements BesCrashDumpCollector.Cancellable {
            final long at;
            final long seq;
            final Runnable runnable;
            boolean cancelled;

            Task(long at, long seq, Runnable runnable) {
                this.at = at;
                this.seq = seq;
                this.runnable = runnable;
            }

            @Override
            public void cancel() {
                cancelled = true;
            }
        }

        long nowMs = T0;
        private long mSeq;
        private final PriorityQueue<Task> mQueue = new PriorityQueue<>((a, b) ->
                a.at != b.at ? Long.compare(a.at, b.at) : Long.compare(a.seq, b.seq));

        @Override
        public void post(Runnable task) {
            mQueue.add(new Task(nowMs, mSeq++, task));
        }

        @Override
        public BesCrashDumpCollector.Cancellable postDelayed(Runnable task, long delayMs) {
            Task t = new Task(nowMs + delayMs, mSeq++, task);
            mQueue.add(t);
            return t;
        }

        /** Runs everything due at the current time. */
        void runDue() {
            advance(0);
        }

        /** Moves time forward, running tasks in order as they come due. */
        void advance(long ms) {
            long target = nowMs + ms;
            while (true) {
                Task next = mQueue.peek();
                if (next == null || next.at > target) {
                    break;
                }
                mQueue.poll();
                nowMs = Math.max(nowMs, next.at);
                if (!next.cancelled) {
                    next.runnable.run();
                }
            }
            nowMs = target;
        }
    }

    /** Records frozen windows and writes a small TRACE in the store line format. */
    static final class FakeFreezer implements TraceFreezer {
        final List<long[]> windows = new ArrayList<>();
        final List<Integer> maxBytes = new ArrayList<>();
        long firstWallMs = T0 - 600_000;
        long lastWallMs = T0 - 1_000;
        int gaps = 2;
        boolean truncated;
        String content = (T0 - 600_000) + "\t3\t10\t[ASG-BES-GAP] a\n"
                + (T0 - 1_000) + "\t3\t20\tlast line\n";
        boolean unavailable;
        /** Called when freeze runs, to check what exists at that moment. */
        Runnable onFreeze;

        @Override
        public Result freeze(File destination, long fromWallMs, long toWallMs, int max) {
            if (onFreeze != null) {
                onFreeze.run();
            }
            windows.add(new long[] {fromWallMs, toWallMs});
            maxBytes.add(max);
            if (unavailable) {
                return null;
            }
            try (FileOutputStream out = new FileOutputStream(destination)) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
            return new Result(2, content.length(), firstWallMs, lastWallMs, gaps, truncated);
        }
    }

    /** Collects the commands the collector sends to the BES. */
    static final class FakeSender implements BesCrashDumpCollector.Sender {
        final List<String> sent = new ArrayList<>();
        boolean accept = true;

        @Override
        public boolean send(String json) {
            sent.add(json);
            return accept;
        }

        String lastDumpId() throws Exception {
            JSONObject command = new JSONObject(sent.get(sent.size() - 1));
            return new JSONObject(command.getString("B")).getString("dump_id");
        }
    }

    static String crcHex(byte[] data) {
        CRC32 crc = new CRC32();
        crc.update(data, 0, data.length);
        return String.format("%08x", crc.getValue());
    }

    static String dumpId(int seq, byte[] data) {
        return String.format("%08x-%s", seq, crcHex(data));
    }

    /** A v=2 dump of the crashed boot, ASCII so bytes equal chars. */
    static String dumpText(String bootId, int filler) {
        StringBuilder text = new StringBuilder();
        text.append("[ASSERT] something broke\n");
        text.append("[CRASH-CONTEXT] v=2 seq=42 boot_id=").append(bootId)
                .append(" uptime_ms=1000 unix_ms=1790000000000 clock=2 age_ms=5000")
                .append(" boot_anchor_ms=1789999995000 reset_hw=0x1f reset_sw=0x02000000\n");
        text.append("[CRASH-FIRMWARE] version=17.26.7.28\n");
        text.append("[CRASH-TAIL] captured=").append(filler).append(" requested=").append(filler)
                .append(" truncated=0 torn=0\n");
        for (int i = 0; i < filler / 10; i++) {
            text.append("trace line ").append(String.format("%04d", i)).append('\n');
        }
        text.append("[CRASH-TAIL-END]\n");
        return text.toString();
    }

    static List<String> chunks(byte[] data, int size) {
        List<String> out = new ArrayList<>();
        String text = new String(data, StandardCharsets.UTF_8);
        for (int at = 0; at < text.length(); at += size) {
            out.add(text.substring(at, Math.min(text.length(), at + size)));
        }
        return out;
    }

    static String header(String dumpId, long len, String crcHex) {
        return "[CRASH-DUMP] v=1 dump_id=" + dumpId + " len=" + len + " crc=" + crcHex;
    }

    static JSONObject syvr(boolean crashPull, String bootId, String dumpId, long dumpLen,
            String dumpBootId, long resetHw, long resetSw) throws Exception {
        JSONObject caps = new JSONObject().put("k900_le", true).put("rlog_sub", 1);
        if (crashPull) {
            caps.put("crash_pull", 1);
        }
        JSONObject crash = new JSONObject().put("v", 1).put("boot_id", bootId)
                .put("reset_hw", resetHw).put("reset_sw", resetSw);
        if (dumpId != null) {
            crash.put("dump_id", dumpId).put("dump_seq", 42).put("dump_len", dumpLen);
        }
        if (dumpBootId != null) {
            crash.put("dump_boot_id", dumpBootId);
        }
        JSONObject json = new JSONObject().put("C", "sr_syvr").put("S", 0).put("wire_caps", caps);
        if (crashPull) {
            json.put("crash", crash);
        }
        return json;
    }
}

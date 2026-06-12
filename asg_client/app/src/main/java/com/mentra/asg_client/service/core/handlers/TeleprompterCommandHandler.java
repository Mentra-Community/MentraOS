package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Handles teleprompter script transfer from the iOS companion app:
 *   teleprompter_script_chunk — one chunk of lines for a script, reassembled
 *                                and persisted to local storage so the
 *                                teleprompter can run standalone without the
 *                                phone.
 *
 * Scripts are stored as JSON files under:
 *   <filesDir>/teleprompter/<scriptId>.json
 *   { "scriptId": "...", "lines": ["line1", "line2", ...] }
 */
public class TeleprompterCommandHandler implements ICommandHandler {

    private static final String TAG = "TeleprompterCmdHandler";
    private static final String STORAGE_DIR = "teleprompter";

    private final Context context;

    // In-progress reassembly buffers, keyed by scriptId
    private final Map<String, ScriptBuffer> buffers = new HashMap<>();

    private static class ScriptBuffer {
        final int totalChunks;
        final String[] chunks; // serialized JSON line-arrays per chunk index
        int receivedCount = 0;

        ScriptBuffer(int totalChunks) {
            this.totalChunks = totalChunks;
            this.chunks = new String[totalChunks];
        }
    }

    public TeleprompterCommandHandler(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("teleprompter_script_chunk");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!"teleprompter_script_chunk".equals(commandType)) {
            return false;
        }
        try {
            if (data == null) {
                Log.w(TAG, "⚠️ teleprompter_script_chunk missing data");
                return false;
            }

            String scriptId = data.optString("scriptId", "");
            int chunkIndex = data.optInt("chunkIndex", -1);
            int totalChunks = data.optInt("totalChunks", -1);
            JSONArray lines = data.optJSONArray("lines");

            if (scriptId.isEmpty() || chunkIndex < 0 || totalChunks <= 0 || lines == null) {
                Log.w(TAG, "⚠️ teleprompter_script_chunk invalid payload: scriptId=" + scriptId
                        + " chunkIndex=" + chunkIndex + " totalChunks=" + totalChunks);
                return false;
            }

            Log.d(TAG, "📜 teleprompter_script_chunk scriptId=" + scriptId
                    + " chunk=" + (chunkIndex + 1) + "/" + totalChunks
                    + " lines=" + lines.length());

            ScriptBuffer buffer = buffers.get(scriptId);
            if (buffer == null || buffer.totalChunks != totalChunks) {
                buffer = new ScriptBuffer(totalChunks);
                buffers.put(scriptId, buffer);
            }

            if (buffer.chunks[chunkIndex] == null) {
                buffer.receivedCount++;
            }
            buffer.chunks[chunkIndex] = lines.toString();

            if (buffer.receivedCount == buffer.totalChunks) {
                assembleAndSave(scriptId, buffer);
                buffers.remove(scriptId);
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling teleprompter_script_chunk", e);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Assembly & persistence
    // -----------------------------------------------------------------------

    private void assembleAndSave(String scriptId, ScriptBuffer buffer) {
        try {
            JSONArray allLines = new JSONArray();
            for (int i = 0; i < buffer.totalChunks; i++) {
                JSONArray chunkLines = new JSONArray(buffer.chunks[i]);
                for (int j = 0; j < chunkLines.length(); j++) {
                    allLines.put(chunkLines.getString(j));
                }
            }

            JSONObject script = new JSONObject();
            script.put("scriptId", scriptId);
            script.put("lines", allLines);

            File dir = new File(context.getFilesDir(), STORAGE_DIR);
            if (!dir.exists() && !dir.mkdirs()) {
                Log.e(TAG, "💥 Failed to create teleprompter storage dir: " + dir.getAbsolutePath());
                return;
            }

            File file = new File(dir, scriptId + ".json");
            try (FileWriter writer = new FileWriter(file)) {
                writer.write(script.toString());
            }

            Log.i(TAG, "✅ Saved teleprompter script '" + scriptId + "' ("
                    + allLines.length() + " lines) to " + file.getAbsolutePath());

        } catch (Exception e) {
            Log.e(TAG, "💥 Error assembling/saving teleprompter script " + scriptId, e);
        }
    }
}

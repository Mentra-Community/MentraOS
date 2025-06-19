package com.augmentos.augmentos_core.smarterglassesmanager.utils;


import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class G1FontLoader {

    private static final String FONT_FILE_NAME = "g1_fonts.json";
    private final Map<Character, FontGlyph> fontMap = new HashMap<>();

    public G1FontLoader(Context context) {
        loadFontData(context);
    }

    private void loadFontData(Context context) {
        try {
            // Read JSON file from assets
            InputStream is = context.getAssets().open(FONT_FILE_NAME);
            byte[] buffer = new byte[is.available()];
            is.read(buffer);
            is.close();

            // Parse JSON
            String json = new String(buffer, StandardCharsets.UTF_8);
            JSONObject fontJson = new JSONObject(json);
            JSONArray glyphsArray = fontJson.getJSONArray("glyphs");

            // Map characters directly to FontGlyph objects
            for (int i = 0; i < glyphsArray.length(); i++) {
                JSONObject glyph = glyphsArray.getJSONObject(i);
                char character = (char) glyph.getInt("code_point");  // Convert Unicode code point to char
                int width = glyph.getInt("width");
                int height = glyph.getInt("height");

                fontMap.put(character, new FontGlyph(width, height));
            }

            Log.d("G1FontLoader", "Font data loaded successfully! " + fontMap.size() + " glyphs mapped.");

        } catch (Exception e) {
            Log.e("G1FontLoader", "Error loading " + FONT_FILE_NAME, e);
        }
    }

    public FontGlyph getGlyph(char character) {
        return fontMap.getOrDefault(character, new FontGlyph(0, 26)); // Default width=6, height=26
    }

    public static class FontGlyph {
        public final int width;
        public final int height;

        public FontGlyph(int width, int height) {
            this.width = width;
            this.height = height;
        }
    }
}

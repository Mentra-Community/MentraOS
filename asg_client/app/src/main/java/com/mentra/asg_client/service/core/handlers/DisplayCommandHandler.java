package com.mentra.asg_client.service.core.handlers;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Set;

/**
 * Handles display commands from the iOS companion app:
 *   text_wall          — full-screen text overlay
 *   double_text_wall   — two-line text overlay (top + bottom)
 *   clear_display      — remove the overlay
 *   teleprompter_update — 3-line scrolling teleprompter overlay
 *
 * Renders a full-screen semi-transparent overlay on the glasses display
 * using a system-level window so it appears over all apps.
 *
 * text_wall / double_text_wall content is wrapped in a ScrollView and
 * auto-scrolled to the bottom after layout. On the Go2's small (640x480)
 * panel, longer captions can need more vertical space than the screen has;
 * this guarantees the most recent lines (the bottom of the message) stay
 * on-screen, with any overflow clipped from the top instead of the bottom.
 */
public class DisplayCommandHandler implements ICommandHandler {

    private static final String TAG = "DisplayCommandHandler";

    // Text sizes (sp). Reduced from the original 28/22/26 to leave more
    // headroom on the 480px-tall panel before scrolling/clipping kicks in.
    private static final int TEXT_SIZE_SINGLE         = 22; // text_wall
    private static final int TEXT_SIZE_DOUBLE_TOP     = 18; // double_text_wall top line
    private static final int TEXT_SIZE_DOUBLE_BOTTOM  = 22; // double_text_wall bottom line

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // The overlay view — null when nothing is displayed
    private View overlayView;
    private WindowManager windowManager;

    // Teleprompter-specific view references (only valid while a teleprompter
    // overlay is active; used so updates can mutate text in place instead of
    // rebuilding/re-adding the view every frame).
    private TextView tpPrevView;
    private TextView tpCurrView;
    private TextView tpNextView;
    private boolean teleprompterActive = false;

    public DisplayCommandHandler(Context context) {
        this.context = context.getApplicationContext();
        this.windowManager = (WindowManager) this.context.getSystemService(Context.WINDOW_SERVICE);
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("text_wall", "double_text_wall", "clear_display", "teleprompter_update");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        Log.d(TAG, "📺 handleCommand: " + commandType);
        try {
            switch (commandType) {
                case "text_wall":
                    String text = data != null ? data.optString("text", "") : "";
                    Log.i(TAG, "📺 text_wall: " + text);
                    showTextOverlay(text, null);
                    return true;

                case "double_text_wall":
                    String top    = data != null ? data.optString("topText", "")    : "";
                    String bottom = data != null ? data.optString("bottomText", "") : "";
                    Log.i(TAG, "📺 double_text_wall top=" + top + " bottom=" + bottom);
                    showTextOverlay(top, bottom);
                    return true;

                case "clear_display":
                    Log.i(TAG, "📺 clear_display");
                    clearOverlay();
                    return true;

                case "teleprompter_update":
                    Log.d(TAG, "📺 teleprompter_update");
                    handleTeleprompterUpdate(data);
                    return true;

                default:
                    Log.w(TAG, "⚠️ Unsupported display command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling display command: " + commandType, e);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // text_wall / double_text_wall overlay rendering
    // -----------------------------------------------------------------------

    private void showTextOverlay(final String topText, final String bottomText) {
        mainHandler.post(() -> {
            try {
                // Remove any existing overlay first
                removeOverlay();

                // Content layout — sized to its natural content height (which
                // may be taller than the screen); centered within the
                // ScrollView's viewport when it fits on its own.
                LinearLayout root = new LinearLayout(context);
                root.setOrientation(LinearLayout.VERTICAL);
                root.setBackgroundColor(Color.argb(220, 0, 0, 0));
                root.setGravity(Gravity.CENTER);
                root.setPadding(40, 40, 40, 40);

                if (bottomText == null || bottomText.isEmpty()) {
                    // Single text_wall — centred, large
                    TextView tv = makeTextView(topText, TEXT_SIZE_SINGLE, true, Color.WHITE);
                    root.addView(tv);
                } else {
                    // double_text_wall — top smaller, bottom larger
                    TextView tvTop = makeTextView(topText, TEXT_SIZE_DOUBLE_TOP, false, Color.WHITE);
                    tvTop.setPadding(0, 0, 0, 20);
                    root.addView(tvTop);

                    View divider = new View(context);
                    divider.setBackgroundColor(Color.argb(150, 255, 255, 255));
                    LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT, 2);
                    dp.setMargins(0, 8, 0, 20);
                    divider.setLayoutParams(dp);
                    root.addView(divider);

                    TextView tvBottom = makeTextView(bottomText, TEXT_SIZE_DOUBLE_BOTTOM, true, Color.WHITE);
                    root.addView(tvBottom);
                }

                ScrollView scrollable = wrapInScrollableContainer(root);
                addOverlayView(scrollable);
                scrollToBottomAfterLayout(scrollable);
                Log.d(TAG, "📺 Overlay displayed");

            } catch (Exception e) {
                Log.e(TAG, "💥 Error showing overlay", e);
            }
        });
    }

    // -----------------------------------------------------------------------
    // teleprompter_update overlay rendering
    // -----------------------------------------------------------------------

    /**
     * Expected payload:
     * {
     *   "type": "teleprompter_update",
     *   "lines": ["previous line text", "current line text", "next line text"],
     *   "highlightIndex": 1   // index within "lines" to render as the highlighted/current line
     * }
     *
     * "lines" may contain 1-3 entries. Missing prev/next lines are rendered blank.
     * highlightIndex defaults to the middle entry if omitted.
     */
    private void handleTeleprompterUpdate(final JSONObject data) {
        final String prevText;
        final String currText;
        final String nextText;

        if (data == null) {
            prevText = "";
            currText = "";
            nextText = "";
        } else {
            JSONArray lines = data.optJSONArray("lines");
            int highlightIndex = data.optInt("highlightIndex", lines != null ? lines.length() / 2 : 0);

            String p = "", c = "", n = "";
            if (lines != null) {
                int len = lines.length();
                // current = highlightIndex
                if (highlightIndex >= 0 && highlightIndex < len) {
                    c = lines.optString(highlightIndex, "");
                }
                // previous = highlightIndex - 1
                if (highlightIndex - 1 >= 0 && highlightIndex - 1 < len) {
                    p = lines.optString(highlightIndex - 1, "");
                }
                // next = highlightIndex + 1
                if (highlightIndex + 1 >= 0 && highlightIndex + 1 < len) {
                    n = lines.optString(highlightIndex + 1, "");
                }
            }
            prevText = p;
            currText = c;
            nextText = n;
        }

        mainHandler.post(() -> {
            try {
                if (!teleprompterActive || overlayView == null) {
                    buildTeleprompterOverlay();
                }
                if (tpPrevView != null) tpPrevView.setText(prevText);
                if (tpCurrView != null) tpCurrView.setText(currText);
                if (tpNextView != null) tpNextView.setText(nextText);
            } catch (Exception e) {
                Log.e(TAG, "💥 Error updating teleprompter overlay", e);
            }
        });
    }

    /**
     * Builds the 3-line teleprompter overlay (prev / current / next) and adds it
     * to the window. Must be called on the main thread.
     */
    private void buildTeleprompterOverlay() {
        // Remove any existing overlay first (handles switching from text_wall etc.)
        removeOverlay();

        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.argb(220, 0, 0, 0));
        root.setGravity(Gravity.CENTER);
        root.setPadding(40, 40, 40, 40);

        // Dimmed previous line
        tpPrevView = makeTextView("", 20, false, Color.argb(160, 200, 200, 200));
        tpPrevView.setPadding(0, 0, 0, 12);
        root.addView(tpPrevView);

        // Bright current/highlighted line
        tpCurrView = makeTextView("", 30, true, Color.WHITE);
        tpCurrView.setPadding(0, 0, 0, 12);
        root.addView(tpCurrView);

        // Dimmed next line
        tpNextView = makeTextView("", 20, false, Color.argb(160, 200, 200, 200));
        root.addView(tpNextView);

        // Note: teleprompter is a fixed 3-line layout, so it's added directly
        // (not scroll-wrapped) — there's no growing/overflowing content here.
        addOverlayView(root);
        teleprompterActive = true;
        Log.d(TAG, "📺 Teleprompter overlay built");
    }

    // -----------------------------------------------------------------------
    // Shared overlay helpers
    // -----------------------------------------------------------------------

    /**
     * Wraps content in a ScrollView so it can be measured at its full natural
     * height (even when taller than the screen) rather than being clamped —
     * and therefore silently bottom-clipped — to the window's height.
     * fillViewport keeps the original centered look when content is short
     * enough to fit on its own.
     */
    private ScrollView wrapInScrollableContainer(LinearLayout content) {
        content.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        ScrollView scrollView = new ScrollView(context);
        scrollView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        scrollView.setFillViewport(true);
        scrollView.setVerticalScrollBarEnabled(false);
        scrollView.addView(content);
        return scrollView;
    }

    /**
     * Scrolls to the bottom once the view has gone through layout, so the
     * tail of the message — the newest lines — is what stays visible if the
     * content is taller than the screen. Older/top lines scroll out of view
     * instead of the bottom getting clipped.
     */
    private void scrollToBottomAfterLayout(ScrollView scrollView) {
        scrollView.post(() -> scrollView.fullScroll(View.FOCUS_DOWN));
    }

    private void addOverlayView(View root) {
        int overlayType = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;

        windowManager.addView(root, params);
        overlayView = root;
    }

    private void clearOverlay() {
        mainHandler.post(this::removeOverlay);
    }

    private void removeOverlay() {
        if (overlayView != null) {
            try {
                windowManager.removeView(overlayView);
                Log.d(TAG, "📺 Overlay removed");
            } catch (Exception e) {
                Log.w(TAG, "⚠️ Error removing overlay: " + e.getMessage());
            } finally {
                overlayView = null;
                teleprompterActive = false;
                tpPrevView = null;
                tpCurrView = null;
                tpNextView = null;
            }
        }
    }

    private TextView makeTextView(String text, int sizeSp, boolean bold, int color) {
        TextView tv = new TextView(context);
        tv.setText(text);
        tv.setTextColor(color);
        tv.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, sizeSp);
        tv.setGravity(Gravity.CENTER);
        if (bold) tv.setTypeface(null, Typeface.BOLD);
        tv.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        return tv;
    }
}
package com.augmentos.augmentos_core;

import android.util.Log;

import java.util.*;
import java.util.concurrent.*;
import android.os.Handler;
import android.os.Looper;

public class WindowManagerWithTimeouts {
    public static final String TAG = "WindowManager";
    private static final int DEFAULT_LINGER_TIME = 0; // or any default you want
    private final int globalTimeoutSeconds;
    private long lastGlobalUpdate; // track when *any* layer was last updated

    private final List<Layer> layers = new LinkedList<>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    private final Runnable globalTimeoutAction;

    // Track what is currently shown on-screen so we don't re-send the same layer repeatedly
    private Layer currentlyDisplayedLayer = null;
    private long currentlyDisplayedLayerTimestamp = 0;
    private boolean globalTimedOut = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable updateDisplayRunnable;


    /**
     * @param globalTimeoutSeconds - if no updates for this many seconds, call globalTimeoutAction
     * @param globalTimeoutAction  - what to do when global timeout triggers (e.g. clearScreen)
     */
    public WindowManagerWithTimeouts(int globalTimeoutSeconds, Runnable globalTimeoutAction) {
        this.globalTimeoutSeconds = globalTimeoutSeconds;
        this.globalTimeoutAction = globalTimeoutAction;
        this.lastGlobalUpdate = System.currentTimeMillis();

        // Start a periodic check for timeouts every second (tweak as needed)
        scheduler.scheduleAtFixedRate(this::checkTimeouts, 1, 1, TimeUnit.SECONDS);
    }

    /**
     * Show or update a layer (e.g. an app).
     * @param layerId - unique ID for the app or feature
     * @param displayCommand - code that does the actual display
     * @param lingerTimeSecs - after how many seconds this layer should auto-hide (0 = never, -1 = match global)
     */
    public void showAppLayer(String layerId, Runnable displayCommand, int lingerTimeSecs) {
        globalTimedOut = false; // new user update => no longer timed out
        Layer layer = findLayer(layerId);
        if (layer == null) {
            layer = new Layer(layerId);
            layers.add(layer);
        }
//        Log.d(TAG, "Setting linger time: " + lingerTimeSecs);

        layer.setDisplayCommand(displayCommand);
        layer.setVisible(true);
        layer.setLastUpdated(System.currentTimeMillis());
        layer.setLingerTimeSeconds(lingerTimeSecs == -1 ? globalTimeoutSeconds : lingerTimeSecs);
        updateGlobalTimestamp();
        updateDisplay();
    }

    public void hideAppLayer(String layerId) {
        Layer layer = findLayer(layerId);
        if (layer != null) {
            layer.setVisible(false);
            updateDisplay();
        }
    }

    /**
     * Dashboard is always on top if visible.
     */
    public void showDashboard(Runnable displayCommand, int lingerTimeSecs) {
        globalTimedOut = false; // new user update => no longer timed out
        Layer dash = findLayer("DASHBOARD");
        if (dash == null) {
            dash = new Layer("DASHBOARD");
            dash.setAlwaysOnTop(true);
            layers.add(dash);
        }
        dash.setDisplayCommand(displayCommand);
        dash.setVisible(true);
        dash.setLastUpdated(System.currentTimeMillis());
        dash.setLingerTimeSeconds(lingerTimeSecs == -1 ? globalTimeoutSeconds : lingerTimeSecs);
        updateGlobalTimestamp();
        updateDisplay();
    }

    public void hideDashboard() {
        Layer dash = findLayer("DASHBOARD");
        if (dash != null) {
            dash.setVisible(false);
            updateDisplay();
        }
    }

    /**
     * Check if any layer's lingerTime has passed; if so, hide that layer.
     * Also check for global inactivity.
     */
    private void checkTimeouts() {
        long now = System.currentTimeMillis();

//        // Check global timeout
//        if (!globalTimedOut && (now - lastGlobalUpdate) >= (globalTimeoutSeconds * 1000L)) {
//            // Global inactivity => call the provided global timeout action (e.g. clearScreen)
//            //globalTimeoutAction.run();
//            clearAll();
//            globalTimedOut = true;
//        }

        // Use Iterator to safely remove elements while iterating
        Iterator<Layer> iterator = layers.iterator();
        while (iterator.hasNext()) {
            Layer layer = iterator.next();
//            Log.d(TAG, "Checking layer: " + layer.getLingerTimeSeconds());
            if (layer.getLingerTimeSeconds() ==  0) {
//                Log.d(TAG, "No auto-hide");
                continue; // No auto-hide
            }

            if (layer.isVisible() && layer.getLingerTimeSeconds() > 0) {
                long age = (now - layer.getLastUpdated()) / 1000L;
                if (age >= layer.getLingerTimeSeconds()) {
                    layer.setVisible(false);
                    iterator.remove();  // Safe way to remove elements
                }
            }
        }

        updateDisplay();
    }

    private void updateDisplay() {
        // Cancel any pending delayed execution
        if (updateDisplayRunnable != null) {
            handler.removeCallbacks(updateDisplayRunnable);
        }
        
        // Fire immediately
        doUpdateDisplay();
        
        // Schedule to fire again after 1 second
        updateDisplayRunnable = new Runnable() {
            @Override
            public void run() {
                doUpdateDisplay();
            }
        };
        handler.postDelayed(updateDisplayRunnable, 1000);
    }

    /**
     * Renders whichever layer is on top. If the dashboard is visible, it wins.
     */
    private void doUpdateDisplay() {
        // Dashboard first
        Layer dash = findLayer("DASHBOARD");
        if (dash != null && dash.isVisible()) {
            maybeRunLayer(dash);
            return;
        }

        // Otherwise newest visible layer
        Layer top = layers.stream()
                .filter(layer -> layer != null && layer.isVisible())  // Add null check
                .max(Comparator.comparingLong(Layer::getLastUpdated))
                .orElse(null);

        if (top != null) {
            maybeRunLayer(top);
        } else {
            // No visible layers => optional clear
            maybeRunLayer(null);
        }
    }

    /**
     * Only call runCommand() if:
     *  - The top layer is different from the currently displayed layer
     *  - OR the same layer but with a more recent lastUpdated
     *  - OR null if we want to clear the screen
     */
    private void maybeRunLayer(Layer newTop) {
        if (newTop == null) {
            // We want to clear the display if something *was* shown before
            if (currentlyDisplayedLayer != null) {
                // Clear
                globalTimeoutAction.run();
                currentlyDisplayedLayer = null;
                currentlyDisplayedLayerTimestamp = 0;
            }
            return;
        }

        boolean isDifferentLayer = (currentlyDisplayedLayer != newTop);
        boolean isUpdatedContent = (newTop.getLastUpdated() != currentlyDisplayedLayerTimestamp);

        if (isDifferentLayer || isUpdatedContent) {
            newTop.runCommand();
            currentlyDisplayedLayer = newTop;
            currentlyDisplayedLayerTimestamp = newTop.getLastUpdated();
        }
    }

    private Layer findLayer(String layerId) {
        for (Layer layer : layers) {
            if (layer.getId().equals(layerId)) {
                return layer;
            }
        }
        return null;
    }

    private void updateGlobalTimestamp() {
        lastGlobalUpdate = System.currentTimeMillis();
    }

    public void clearAll() {
        layers.clear();  // Remove all layers
        //currentlyDisplayedLayer = null;
        currentlyDisplayedLayerTimestamp = 0;
        updateDisplay();  // This will trigger the globalTimeoutAction since no layers exist
    }

    // Stop the scheduler if needed (e.g. on service destroy).
    public void shutdown() {
        scheduler.shutdownNow();
    }

    public boolean isDashboardShowing() {
        if (currentlyDisplayedLayer != null && currentlyDisplayedLayer.id.equals("DASHBOARD")) {
            Log.d(TAG, "Dashboard is showing confirmed!");
            return true;
        } else {
            Log.d(TAG, "Dashboard is now showing, confirmed!");
            return false;
        }
    }

    //----- Inner class for layers -----
    private static class Layer {
        private final String id;
        private Runnable displayCommand;
        private boolean visible = false;
        private boolean alwaysOnTop = false;
        private long lastUpdated = 0;
        private int lingerTimeSeconds = 0; // 0 = no auto-hide

        public Layer(String id) {
            this.id = id;
        }

        public String getId() { return id; }

        public void setDisplayCommand(Runnable cmd) {
            this.displayCommand = cmd;
        }
        public void runCommand() {
            if (displayCommand != null) {
                displayCommand.run();
            }
        }

        public boolean isVisible() { return visible; }
        public void setVisible(boolean v) { this.visible = v; }
        public boolean isAlwaysOnTop() { return alwaysOnTop; }
        public void setAlwaysOnTop(boolean top) { this.alwaysOnTop = top; }

        public long getLastUpdated() { return lastUpdated; }
        public void setLastUpdated(long timestamp) { this.lastUpdated = timestamp; }

        public int getLingerTimeSeconds() { return lingerTimeSeconds; }
        public void setLingerTimeSeconds(int secs) { this.lingerTimeSeconds = secs; }
    }
}

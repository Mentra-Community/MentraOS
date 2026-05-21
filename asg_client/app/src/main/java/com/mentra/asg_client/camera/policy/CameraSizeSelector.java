package com.mentra.asg_client.camera.policy;

import android.util.Log;
import android.util.Size;

/** Shared closest-size selector for camera outputs. */
public final class CameraSizeSelector {

    private static final String TAG = "CameraNeo";

    private CameraSizeSelector() {}

    public static Size chooseOptimalSize(Size[] choices, int desiredWidth, int desiredHeight) {
        if (choices == null || choices.length == 0) {
            Log.w(TAG, "No size choices available");
            return null;
        }

        for (Size option : choices) {
            if (option.getWidth() == desiredWidth && option.getHeight() == desiredHeight) {
                Log.i(TAG, "Found exact size match: " + option.getWidth() + "x" + option.getHeight());
                return option;
            }
        }

        Log.i(TAG, "No exact match found for " + desiredWidth + "x" + desiredHeight + ", finding closest size");
        Log.i(TAG, "Available size options (" + choices.length + " total):");

        Size bestSize = choices[0];
        int smallestDifference = Integer.MAX_VALUE;

        for (Size option : choices) {
            int widthDiff = Math.abs(option.getWidth() - desiredWidth);
            int heightDiff = Math.abs(option.getHeight() - desiredHeight);
            int totalDifference = widthDiff + heightDiff;

            Log.i(TAG, "  " + option.getWidth() + "x" + option.getHeight()
                    + " (diff: " + totalDifference + " = width+" + widthDiff + " height+" + heightDiff + ")");

            if (totalDifference < smallestDifference) {
                smallestDifference = totalDifference;
                bestSize = option;
            }
        }

        Log.i(TAG, "Selected optimal size: " + bestSize.getWidth() + "x" + bestSize.getHeight()
                + " (total difference: " + smallestDifference
                + " from requested " + desiredWidth + "x" + desiredHeight + ")");

        return bestSize;
    }
}

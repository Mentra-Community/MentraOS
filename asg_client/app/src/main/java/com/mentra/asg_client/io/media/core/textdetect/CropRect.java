package com.mentra.asg_client.io.media.core.textdetect;

/** Integer crop rectangle in source-image pixel coordinates. */
public final class CropRect {
    public final int left;
    public final int top;
    public final int right;
    public final int bottom;

    public CropRect(int left, int top, int right, int bottom) {
        this.left = left;
        this.top = top;
        this.right = right;
        this.bottom = bottom;
    }

    /** Width in pixels; never negative. */
    public int width() {
        return Math.max(0, right - left);
    }

    /** Height in pixels; never negative. */
    public int height() {
        return Math.max(0, bottom - top);
    }

    /** Number of pixels covered by this rect ({@code width() * height()}). */
    public int pixelCount() {
        return width() * height();
    }

    /** Returns {@code [left, top, width, height]} for JSON/log serialization. */
    public int[] toArray() {
        return new int[] {left, top, width(), height()};
    }

    /** Whether {@code other} lies fully inside (or exactly on) this rect's bounds. */
    public boolean contains(CropRect other) {
        return left <= other.left
                && top <= other.top
                && right >= other.right
                && bottom >= other.bottom;
    }

    /** Clamps {@code rect} into {@code [0, maxWidth] x [0, maxHeight]}, keeping at least 1x1. */
    public static CropRect clamp(CropRect rect, int maxWidth, int maxHeight) {
        int left = clamp(rect.left, 0, maxWidth - 1);
        int top = clamp(rect.top, 0, maxHeight - 1);
        int right = clamp(rect.right, left + 1, maxWidth);
        int bottom = clamp(rect.bottom, top + 1, maxHeight);
        return new CropRect(left, top, right, bottom);
    }

    /** Smallest rect containing both {@code a} and {@code b}. */
    public static CropRect union(CropRect a, CropRect b) {
        return new CropRect(
                Math.min(a.left, b.left),
                Math.min(a.top, b.top),
                Math.max(a.right, b.right),
                Math.max(a.bottom, b.bottom));
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}

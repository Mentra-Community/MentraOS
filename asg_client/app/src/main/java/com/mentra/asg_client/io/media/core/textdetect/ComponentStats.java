package com.mentra.asg_client.io.media.core.textdetect;

/** Statistics for one connected foreground component in the analysis image. */
public final class ComponentStats {
    public final int left;
    public final int top;
    public final int width;
    public final int height;
    public final int area;
    public final float centroidX;
    public final float centroidY;
    public final float fillRatio;

    public ComponentStats(
            int left,
            int top,
            int width,
            int height,
            int area,
            float centroidX,
            float centroidY,
            float fillRatio) {
        this.left = left;
        this.top = top;
        this.width = width;
        this.height = height;
        this.area = area;
        this.centroidX = centroidX;
        this.centroidY = centroidY;
        this.fillRatio = fillRatio;
    }

    public int right() {
        return left + width;
    }

    public int bottom() {
        return top + height;
    }

    public float centerY() {
        return top + height * 0.5f;
    }
}

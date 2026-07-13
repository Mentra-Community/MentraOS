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

    /**
     * Concentration of gradient-magnitude-weighted edge orientations in the component's dominant
     * two directions (0..1). Text strokes tend toward a couple of dominant edge orientations;
     * random texture (dust, foliage, cloud) tends toward a flatter distribution. Only populated
     * when {@code TextDetectConfig.enableStructureFilter} is set; otherwise defaults to 1
     * (neutral / not penalized).
     */
    public final float structureScore;

    /**
     * Coefficient of variation (stddev/mean) of the distance-transform values inside the
     * component mask — a proxy for stroke-width consistency. Real character strokes have fairly
     * uniform thickness (low CV); filled blobs and textured noise tend to vary more (high CV).
     * Only populated when {@code TextDetectConfig.enableStrokeWidthFilter} is set; otherwise
     * defaults to 0 (neutral / not penalized).
     */
    public final float strokeWidthCv;

    public ComponentStats(
            int left,
            int top,
            int width,
            int height,
            int area,
            float centroidX,
            float centroidY,
            float fillRatio,
            float structureScore,
            float strokeWidthCv) {
        this.left = left;
        this.top = top;
        this.width = width;
        this.height = height;
        this.area = area;
        this.centroidX = centroidX;
        this.centroidY = centroidY;
        this.fillRatio = fillRatio;
        this.structureScore = structureScore;
        this.strokeWidthCv = strokeWidthCv;
    }

    /** Exclusive right edge ({@code left + width}). */
    public int right() {
        return left + width;
    }

    /** Exclusive bottom edge ({@code top + height}). */
    public int bottom() {
        return top + height;
    }

    /** Vertical center of the bounding box. */
    public float centerY() {
        return top + height * 0.5f;
    }
}

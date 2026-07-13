package com.mentra.asg_client.io.media.core.textdetect;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Mentra-specific text-line logic: permissive component filtering, horizontal line clustering,
 * scoring, line merging, and safety padding. OpenCV-agnostic — operates on {@link ComponentStats}
 * only.
 */
final class TextLineClusterer {
    private TextLineClusterer() {}

    static ClusterResult cluster(List<ComponentStats> rawComponents, int imageWidth, int imageHeight, TextDetectConfig config) {
        List<ComponentStats> filtered = filterComponents(rawComponents, imageWidth, imageHeight, config);
        if (filtered.isEmpty()) {
            return ClusterResult.empty();
        }

        List<TextLine> lines = buildLines(filtered, imageWidth, imageHeight, config);
        if (lines.isEmpty()) {
            return ClusterResult.empty();
        }

        lines.sort(Comparator.comparingDouble((TextLine line) -> line.score).reversed());
        List<TextLine> merged = mergeNearbyLines(lines, imageWidth, imageHeight, config);
        merged.sort(Comparator.comparingDouble((TextLine line) -> line.score).reversed());

        float medianHeight = medianComponentHeight(merged);
        CropRect baseBounds =
                config.cropFromTopLineOnly ? merged.get(0).bounds : unionBounds(merged);
        CropRect padded = applyPadding(baseBounds, imageWidth, imageHeight, medianHeight, config, 1.0f);
        float topScore = merged.get(0).score;
        return new ClusterResult(merged, padded, topScore, filtered.size(), merged.size());
    }

    private static List<ComponentStats> filterComponents(
            List<ComponentStats> components, int imageWidth, int imageHeight, TextDetectConfig config) {
        int minHeight = Math.max(1, Math.round(imageHeight * config.minHeightFraction));
        int maxHeight = Math.max(minHeight, Math.round(imageHeight * config.maxHeightFraction));
        int minWidth = Math.max(1, Math.round(imageWidth * config.minWidthFraction));
        int maxWidth = Math.max(minWidth, Math.round(imageWidth * config.maxWidthFraction));
        int maxArea = Math.round(imageWidth * imageHeight * 0.90f);

        float minAspect = config.minAspectRatio;
        float maxAspect = config.maxAspectRatio;
        float minFill = config.minFillRatio;
        float maxFill = config.maxFillRatio;
        if (config.strictComponentFilters) {
            // Tier 1: narrower bounds tuned against real captures with dust/foliage/reflection
            // clutter, on top of the spec's permissive defaults.
            minAspect = Math.max(minAspect, 0.15f);
            maxAspect = Math.min(maxAspect, 6f);
            minFill = Math.max(minFill, 0.12f);
            maxFill = Math.min(maxFill, 0.85f);
        }

        List<ComponentStats> out = new ArrayList<>();
        for (ComponentStats c : components) {
            if (c.height < minHeight || c.height > maxHeight) {
                continue;
            }
            if (c.width < minWidth || c.width > maxWidth) {
                continue;
            }
            if (c.area < 2 || c.area > maxArea) {
                continue;
            }
            float aspect = c.width / (float) Math.max(1, c.height);
            if (aspect < minAspect || aspect > maxAspect) {
                continue;
            }
            if (c.fillRatio < minFill || c.fillRatio > maxFill) {
                continue;
            }
            if (config.enableStructureFilter && c.structureScore < config.minStructureScore) {
                continue;
            }
            if (config.enableStrokeWidthFilter && c.strokeWidthCv > config.maxStrokeWidthCv) {
                continue;
            }
            out.add(c);
        }
        return out;
    }

    private static List<TextLine> buildLines(
            List<ComponentStats> components, int imageWidth, int imageHeight, TextDetectConfig config) {
        int n = components.size();
        UnionFind uf = new UnionFind(n);
        float medianHeight = medianHeight(components);

        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                if (areCompatible(components.get(i), components.get(j), medianHeight, config)) {
                    uf.union(i, j);
                }
            }
        }

        List<List<ComponentStats>> groups = uf.groups(components, n);
        List<TextLine> lines = new ArrayList<>();
        for (List<ComponentStats> group : groups) {
            if (group.size() < config.minComponentsPerLine) {
                continue;
            }
            TextLine line = scoreLine(group, imageWidth, imageHeight);
            if (line.score > 0) {
                lines.add(line);
            }
        }
        return lines;
    }

    private static boolean areCompatible(
            ComponentStats a, ComponentStats b, float medianHeight, TextDetectConfig config) {
        float heightRatio = a.height / (float) Math.max(1, b.height);
        if (heightRatio < config.lineHeightRatioMin || heightRatio > config.lineHeightRatioMax) {
            return false;
        }

        float overlap = verticalOverlap(a, b);
        if (overlap < config.lineMinVerticalOverlap) {
            return false;
        }

        float maxHeight = Math.max(a.height, b.height);
        float centerDistance = Math.abs(a.centerY() - b.centerY());
        if (centerDistance > config.lineMaxCenterYDistanceFactor * maxHeight) {
            return false;
        }

        float gap = horizontalGap(a, b);
        float gapLimit = config.lineMaxHorizontalGapFactor * Math.max(1f, medianHeight);
        return gap <= gapLimit;
    }

    private static float verticalOverlap(ComponentStats a, ComponentStats b) {
        int overlapTop = Math.max(a.top, b.top);
        int overlapBottom = Math.min(a.bottom(), b.bottom());
        int overlap = Math.max(0, overlapBottom - overlapTop);
        int minHeight = Math.max(1, Math.min(a.height, b.height));
        return overlap / (float) minHeight;
    }

    private static float horizontalGap(ComponentStats a, ComponentStats b) {
        if (a.right() <= b.left) {
            return b.left - a.right();
        }
        if (b.right() <= a.left) {
            return a.left - b.right();
        }
        return 0;
    }

    private static TextLine scoreLine(List<ComponentStats> group, int imageWidth, int imageHeight) {
        group.sort(Comparator.comparingInt(c -> c.left));
        CropRect bounds = boundsOf(group);
        float heightConsistency = consistencyScore(group, true);
        float spacingConsistency = spacingRegularity(group);
        float alignmentScore = baselineConsistency(group);
        float horizontalExtent = bounds.width() / (float) imageWidth;
        float density = totalArea(group) / (float) Math.max(1, bounds.pixelCount());
        float centrality = 1f - Math.abs((bounds.left + bounds.right) * 0.5f - imageWidth * 0.5f) / (imageWidth * 0.5f);

        float irregularity = 0f;
        if (heightConsistency < 0.4f) {
            irregularity += 1.5f;
        }
        if (spacingConsistency < 0.3f) {
            irregularity += 1.0f;
        }

        float score =
                group.size()
                        + alignmentScore * 2f
                        + heightConsistency * 2f
                        + spacingConsistency * 1.5f
                        + horizontalExtent * 2f
                        + density
                        + centrality
                        - irregularity;

        return new TextLine(group, bounds, score);
    }

    private static float consistencyScore(List<ComponentStats> group, boolean heights) {
        if (group.size() < 2) {
            return 0f;
        }
        float sum = 0f;
        for (ComponentStats c : group) {
            sum += heights ? c.height : c.centerY();
        }
        float mean = sum / group.size();
        float variance = 0f;
        for (ComponentStats c : group) {
            float value = heights ? c.height : c.centerY();
            float diff = value - mean;
            variance += diff * diff;
        }
        float stdDev = (float) Math.sqrt(variance / group.size());
        float denom = Math.max(1f, mean);
        return Math.max(0f, 1f - (stdDev / denom));
    }

    private static float baselineConsistency(List<ComponentStats> group) {
        return consistencyScore(group, false);
    }

    private static float spacingRegularity(List<ComponentStats> group) {
        if (group.size() < 3) {
            return 0.5f;
        }
        List<Integer> gaps = new ArrayList<>();
        for (int i = 1; i < group.size(); i++) {
            gaps.add(Math.max(0, group.get(i).left - group.get(i - 1).right()));
        }
        float sum = 0f;
        for (int gap : gaps) {
            sum += gap;
        }
        float mean = sum / gaps.size();
        float variance = 0f;
        for (int gap : gaps) {
            float diff = gap - mean;
            variance += diff * diff;
        }
        float stdDev = (float) Math.sqrt(variance / gaps.size());
        return Math.max(0f, 1f - (stdDev / Math.max(1f, mean)));
    }

    private static int totalArea(List<ComponentStats> group) {
        int total = 0;
        for (ComponentStats c : group) {
            total += c.area;
        }
        return total;
    }

    private static List<TextLine> mergeNearbyLines(
            List<TextLine> lines, int imageWidth, int imageHeight, TextDetectConfig config) {
        if (lines.isEmpty()) {
            return lines;
        }
        List<TextLine> sorted = new ArrayList<>(lines);
        sorted.sort(Comparator.comparingInt(line -> line.bounds.top));

        List<TextLine> merged = new ArrayList<>();
        TextLine current = sorted.get(0);
        for (int i = 1; i < sorted.size(); i++) {
            TextLine next = sorted.get(i);
            if (shouldMerge(current, next, config)) {
                List<ComponentStats> combined = new ArrayList<>(current.components);
                combined.addAll(next.components);
                current = scoreLine(combined, imageWidth, imageHeight);
            } else {
                merged.add(current);
                current = next;
            }
        }
        merged.add(current);
        return merged;
    }

    private static boolean shouldMerge(TextLine a, TextLine b, TextDetectConfig config) {
        int verticalGap = Math.max(0, b.bounds.top - a.bounds.bottom);
        float medianHeight = medianComponentHeight(List.of(a, b));
        if (verticalGap > medianHeight * 2.5f) {
            return false;
        }
        int overlapLeft = Math.max(a.bounds.left, b.bounds.left);
        int overlapRight = Math.min(a.bounds.right, b.bounds.right);
        return overlapRight > overlapLeft;
    }

    private static CropRect unionBounds(List<TextLine> lines) {
        CropRect union = lines.get(0).bounds;
        for (int i = 1; i < lines.size(); i++) {
            union = CropRect.union(union, lines.get(i).bounds);
        }
        return union;
    }

    static CropRect applyPadding(
            CropRect bounds,
            int imageWidth,
            int imageHeight,
            float medianHeight,
            TextDetectConfig config,
            float paddingMultiplier) {
        int padX =
                Math.round(
                        Math.max(
                                bounds.width() * config.paddingHorizontalFraction * paddingMultiplier,
                                medianHeight * config.paddingHorizontalHeightFactor * paddingMultiplier));
        int padY =
                Math.round(
                        Math.max(
                                bounds.height() * config.paddingVerticalFraction * paddingMultiplier,
                                medianHeight * config.paddingVerticalHeightFactor * paddingMultiplier));

        CropRect padded =
                new CropRect(
                        bounds.left - padX,
                        bounds.top - padY,
                        bounds.right + padX,
                        bounds.bottom + padY);
        return CropRect.clamp(padded, imageWidth, imageHeight);
    }

    private static CropRect boundsOf(List<ComponentStats> group) {
        int left = Integer.MAX_VALUE;
        int top = Integer.MAX_VALUE;
        int right = Integer.MIN_VALUE;
        int bottom = Integer.MIN_VALUE;
        for (ComponentStats c : group) {
            left = Math.min(left, c.left);
            top = Math.min(top, c.top);
            right = Math.max(right, c.right());
            bottom = Math.max(bottom, c.bottom());
        }
        return new CropRect(left, top, right, bottom);
    }

    private static float medianHeight(List<ComponentStats> components) {
        if (components.isEmpty()) {
            return 1f;
        }
        List<Integer> heights = new ArrayList<>();
        for (ComponentStats c : components) {
            heights.add(c.height);
        }
        Collections.sort(heights);
        return heights.get(heights.size() / 2);
    }

    private static float medianComponentHeight(List<TextLine> lines) {
        List<ComponentStats> all = new ArrayList<>();
        for (TextLine line : lines) {
            all.addAll(line.components);
        }
        return medianHeight(all);
    }

    static final class TextLine {
        final List<ComponentStats> components;
        final CropRect bounds;
        final float score;

        TextLine(List<ComponentStats> components, CropRect bounds, float score) {
            this.components = components;
            this.bounds = bounds;
            this.score = score;
        }
    }

    static final class ClusterResult {
        final List<TextLine> lines;
        final CropRect crop;
        final float score;
        final int acceptedComponentCount;
        final int lineCount;

        ClusterResult(List<TextLine> lines, CropRect crop, float score, int acceptedComponentCount, int lineCount) {
            this.lines = lines;
            this.crop = crop;
            this.score = score;
            this.acceptedComponentCount = acceptedComponentCount;
            this.lineCount = lineCount;
        }

        static ClusterResult empty() {
            return new ClusterResult(Collections.emptyList(), null, 0f, 0, 0);
        }

        boolean hasCrop() {
            return crop != null && crop.width() > 0 && crop.height() > 0;
        }
    }

    private static final class UnionFind {
        private final int[] parent;
        private final int[] rank;

        UnionFind(int size) {
            parent = new int[size];
            rank = new int[size];
            for (int i = 0; i < size; i++) {
                parent[i] = i;
            }
        }

        int find(int x) {
            if (parent[x] != x) {
                parent[x] = find(parent[x]);
            }
            return parent[x];
        }

        void union(int a, int b) {
            int rootA = find(a);
            int rootB = find(b);
            if (rootA == rootB) {
                return;
            }
            if (rank[rootA] < rank[rootB]) {
                parent[rootA] = rootB;
            } else if (rank[rootA] > rank[rootB]) {
                parent[rootB] = rootA;
            } else {
                parent[rootB] = rootA;
                rank[rootA]++;
            }
        }

        List<List<ComponentStats>> groups(List<ComponentStats> components, int n) {
            List<List<ComponentStats>> result = new ArrayList<>();
            boolean[] seenRoot = new boolean[n];
            for (int i = 0; i < n; i++) {
                int root = find(i);
                if (seenRoot[root]) {
                    continue;
                }
                seenRoot[root] = true;
                List<ComponentStats> group = new ArrayList<>();
                for (int j = 0; j < n; j++) {
                    if (find(j) == root) {
                        group.add(components.get(j));
                    }
                }
                result.add(group);
            }
            return result;
        }
    }
}

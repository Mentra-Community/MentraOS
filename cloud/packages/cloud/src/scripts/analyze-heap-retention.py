#!/usr/bin/env python3
"""
analyze-heap-retention.py — Deep analysis of JSC/Bun heap snapshots.

Parses the JSC heap snapshot format (from Bun.generateHeapSnapshot()) and
answers: "What is retaining all those Objects and strings?"

Usage:
  python3 analyze-heap-retention.py <snapshot.json>
  python3 analyze-heap-retention.py <snapshot.json> --top=30
  python3 analyze-heap-retention.py <snapshot.json> --class=Object
  python3 analyze-heap-retention.py <snapshot.json> --diff=<other_snapshot.json>
  python3 analyze-heap-retention.py <snapshot.json> --retainers=Object --depth=3

Examples:
  # Full overview of what's in the heap
  python3 analyze-heap-retention.py us-central-20min.json

  # What retains the most Object instances?
  python3 analyze-heap-retention.py us-central-20min.json --retainers=Object

  # What retains the most strings?
  python3 analyze-heap-retention.py us-central-20min.json --retainers=string

  # Diff two snapshots — what grew?
  python3 analyze-heap-retention.py us-central-20min.json --diff=us-central-10min.json

  # Show top 50 classes
  python3 analyze-heap-retention.py us-central-20min.json --top=50
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from typing import Optional


def load_snapshot(path: str) -> dict:
    print(f"Loading {path}...", file=sys.stderr)
    with open(path) as f:
        data = json.load(f)
    print(
        f"  Loaded: {len(data.get('nodes', []))} node values, "
        f"{len(data.get('nodeClassNames', []))} class names, "
        f"{len(data.get('edges', []))} edge values",
        file=sys.stderr,
    )
    return data


class HeapGraph:
    """Parsed JSC heap snapshot with node/edge traversal."""

    def __init__(self, snapshot: dict):
        self.nodes = snapshot.get("nodes", [])
        self.class_names = snapshot.get("nodeClassNames", [])
        self.edges = snapshot.get("edges", [])
        self.edge_types = snapshot.get("edgeTypes", [])
        self.edge_names = snapshot.get("edgeNames", [])

        # JSC format: nodes array has stride of 4
        # [cellType, cellSize, classNameIndex, labelIndex] repeated
        self.node_stride = 4
        self.node_count = len(self.nodes) // self.node_stride

        # JSC format: edges array has stride of 3
        # [fromNodeIndex, toNodeIndex, edgeLabelIndex] repeated
        self.edge_stride = 3
        self.edge_count = len(self.edges) // self.edge_stride

        print(
            f"  Nodes: {self.node_count:,}, Edges: {self.edge_count:,}, "
            f"Classes: {len(self.class_names)}",
            file=sys.stderr,
        )

    def node_class(self, node_idx: int) -> str:
        """Get the class name for a node index (0-based node index, not array offset)."""
        offset = node_idx * self.node_stride
        if offset + 2 >= len(self.nodes):
            return "<out-of-bounds>"
        class_idx = self.nodes[offset + 2]
        if 0 <= class_idx < len(self.class_names):
            return self.class_names[class_idx]
        return f"<unknown-{class_idx}>"

    def node_size(self, node_idx: int) -> int:
        """Get the cell size for a node (JSC reports cell size, not retained size)."""
        offset = node_idx * self.node_stride
        if offset + 1 >= len(self.nodes):
            return 0
        return self.nodes[offset + 1]

    def node_label(self, node_idx: int) -> str:
        """Get the label/name for a node if available."""
        offset = node_idx * self.node_stride
        if offset + 3 >= len(self.nodes):
            return ""
        label_idx = self.nodes[offset + 3]
        # Labels use the same edge_names array in some JSC versions
        if self.edge_names and 0 <= label_idx < len(self.edge_names):
            return self.edge_names[label_idx]
        return ""

    def get_class_counts(self) -> Counter:
        """Count objects by class name."""
        counts = Counter()
        for i in range(self.node_count):
            cls = self.node_class(i)
            counts[cls] += 1
        return counts

    def get_class_sizes(self) -> dict:
        """Sum cell sizes by class name."""
        sizes = defaultdict(int)
        counts = defaultdict(int)
        for i in range(self.node_count):
            cls = self.node_class(i)
            size = self.node_size(i)
            sizes[cls] += size
            counts[cls] += 1
        return sizes, counts

    def build_incoming_edges(self) -> dict:
        """Build a map of node_idx -> list of (from_node_idx, edge_label)."""
        incoming = defaultdict(list)
        for i in range(self.edge_count):
            offset = i * self.edge_stride
            from_node = self.edges[offset]
            to_node = self.edges[offset + 1]
            label_idx = self.edges[offset + 2]

            label = ""
            if self.edge_names and 0 <= label_idx < len(self.edge_names):
                label = self.edge_names[label_idx]

            if 0 <= from_node < self.node_count and 0 <= to_node < self.node_count:
                incoming[to_node].append((from_node, label))
        return incoming

    def build_outgoing_edges(self) -> dict:
        """Build a map of node_idx -> list of (to_node_idx, edge_label)."""
        outgoing = defaultdict(list)
        for i in range(self.edge_count):
            offset = i * self.edge_stride
            from_node = self.edges[offset]
            to_node = self.edges[offset + 1]
            label_idx = self.edges[offset + 2]

            label = ""
            if self.edge_names and 0 <= label_idx < len(self.edge_names):
                label = self.edge_names[label_idx]

            if 0 <= from_node < self.node_count and 0 <= to_node < self.node_count:
                outgoing[from_node].append((to_node, label))
        return outgoing


def cmd_overview(graph: HeapGraph, top_n: int):
    """Print an overview of object counts and sizes."""
    sizes, counts = graph.get_class_sizes()

    total_size = sum(sizes.values())
    total_count = sum(counts.values())

    print(f"\n{'=' * 80}")
    print(
        f"  HEAP OVERVIEW — {total_count:,} objects, {total_size / 1048576:.1f} MB cell size"
    )
    print(f"{'=' * 80}\n")

    # By count
    sorted_by_count = sorted(counts.items(), key=lambda x: -x[1])
    print(f"{'Class':<45s} {'Count':>10s} {'%':>6s} {'Size (MB)':>10s} {'Avg (B)':>8s}")
    print("-" * 82)
    for cls, count in sorted_by_count[:top_n]:
        pct = count / total_count * 100
        size_mb = sizes[cls] / 1048576
        avg_bytes = sizes[cls] / count if count > 0 else 0
        print(
            f"{cls:<45s} {count:>10,d} {pct:>5.1f}% {size_mb:>9.1f} {avg_bytes:>8.0f}"
        )

    # By size
    print(
        f"\n{'Class':<45s} {'Size (MB)':>10s} {'%':>6s} {'Count':>10s} {'Avg (B)':>8s}"
    )
    print("-" * 82)
    sorted_by_size = sorted(sizes.items(), key=lambda x: -x[1])
    for cls, size in sorted_by_size[:top_n]:
        pct = size / total_size * 100 if total_size > 0 else 0
        count = counts[cls]
        avg_bytes = size / count if count > 0 else 0
        print(
            f"{cls:<45s} {size / 1048576:>9.1f} {pct:>5.1f}% {count:>10,d} {avg_bytes:>8.0f}"
        )

    # Session-related summary
    print(f"\n{'=' * 80}")
    print(f"  SESSION-RELATED OBJECTS")
    print(f"{'=' * 80}\n")
    session_keywords = [
        "UserSession",
        "AppSession",
        "AppManager",
        "AudioManager",
        "DisplayManager",
        "DashboardManager",
        "MicrophoneManager",
        "TranscriptionManager",
        "TranslationManager",
        "SubscriptionManager",
        "LocationManager",
        "CalendarManager",
        "DeviceManager",
        "PhotoManager",
        "StreamRegistry",
        "ManagedStreamingExtension",
        "UnmanagedStreamingExtension",
        "Pino",
        "Timeout",
        "ServerWebSocket",
        "WebSocket",
        "TLSSocket",
        "SonioxSdkStream",
        "SonioxTranscriptionProvider",
        "SonioxTranslationProvider",
        "RealtimeSttSession",
        "RealtimeUtteranceBuffer",
        "RealtimeSegmentBuffer",
        "UdpAudioManager",
        "AppAudioStreamManager",
        "UdpReorderBuffer",
        "EmbeddedDocument",
        "StateMachine",
        "InternalCache",
        "ProxyObject",
        "BufferPool",
        "ClientSession",
        "ServerSession",
    ]
    for kw in session_keywords:
        if kw in counts and counts[kw] > 0:
            print(f"  {kw:<45s} {counts[kw]:>8,d}  ({sizes[kw] / 1024:.0f} KB)")


def cmd_retainers(
    graph: HeapGraph, target_class: str, depth: int, sample_size: int = 500
):
    """Find what retains instances of the target class.

    For a sample of target-class nodes, walk incoming edges to find
    which parent classes hold references to them and via which property names.
    """
    print(f"\nBuilding incoming edge map...", file=sys.stderr)
    incoming = graph.build_incoming_edges()

    # Find all nodes of the target class
    target_nodes = []
    for i in range(graph.node_count):
        if graph.node_class(i) == target_class:
            target_nodes.append(i)

    if not target_nodes:
        print(f"No objects of class '{target_class}' found.")
        return

    print(
        f"\nFound {len(target_nodes):,} instances of '{target_class}'", file=sys.stderr
    )

    # Sample if too many
    import random

    if len(target_nodes) > sample_size:
        sampled = random.sample(target_nodes, sample_size)
        print(f"Sampling {sample_size} for retainer analysis...", file=sys.stderr)
    else:
        sampled = target_nodes

    # Count retainer patterns: (parent_class, edge_label) -> count
    retainer_patterns = Counter()
    retainer_class_only = Counter()

    # For deeper analysis: walk up N levels
    def walk_retainers(node_idx, current_depth, path):
        if current_depth >= depth:
            return
        parents = incoming.get(node_idx, [])
        for parent_idx, label in parents:
            parent_class = graph.node_class(parent_idx)
            full_path = f"{parent_class}.{label}" if label else parent_class
            retainer_patterns[(parent_class, label or "<index>")] += 1
            retainer_class_only[parent_class] += 1
            if current_depth < depth - 1:
                walk_retainers(parent_idx, current_depth + 1, path + [full_path])

    for node_idx in sampled:
        walk_retainers(node_idx, 0, [])

    scale_factor = len(target_nodes) / len(sampled) if len(sampled) > 0 else 1

    print(f"\n{'=' * 80}")
    print(f"  RETAINERS OF '{target_class}' ({len(target_nodes):,} instances)")
    print(f"  (sampled {len(sampled)}, scaled by {scale_factor:.1f}x)")
    print(f"{'=' * 80}\n")

    # By parent class + property
    print(f"{'Parent Class':<35s} {'Property':<25s} {'Count':>10s} {'Est. Total':>12s}")
    print("-" * 85)
    for (parent_class, label), count in retainer_patterns.most_common(40):
        est = int(count * scale_factor)
        print(f"{parent_class:<35s} {label:<25s} {count:>10,d} {est:>12,d}")

    # By parent class only
    print(f"\n{'Parent Class':<45s} {'Refs':>10s} {'Est. Total':>12s}")
    print("-" * 70)
    for parent_class, count in retainer_class_only.most_common(30):
        est = int(count * scale_factor)
        print(f"{parent_class:<45s} {count:>10,d} {est:>12,d}")


def cmd_diff(graph1: HeapGraph, graph2: HeapGraph, top_n: int):
    """Diff two snapshots — show what grew and what shrank."""
    counts1 = graph1.get_class_counts()
    counts2 = graph2.get_class_counts()
    sizes1, _ = graph1.get_class_sizes()
    sizes2, _ = graph2.get_class_sizes()

    all_classes = set(list(counts1.keys()) + list(counts2.keys()))
    deltas = []
    for cls in all_classes:
        c1 = counts1.get(cls, 0)
        c2 = counts2.get(cls, 0)
        s1 = sizes1.get(cls, 0)
        s2 = sizes2.get(cls, 0)
        count_delta = c2 - c1
        size_delta = s2 - s1
        deltas.append((count_delta, size_delta, cls, c1, c2, s1, s2))

    total1 = sum(counts1.values())
    total2 = sum(counts2.values())
    total_size1 = sum(sizes1.values())
    total_size2 = sum(sizes2.values())

    print(f"\n{'=' * 80}")
    print(f"  HEAP DIFF")
    print(f"{'=' * 80}")
    print(f"  Snapshot 1: {total1:>12,d} objects, {total_size1 / 1048576:>8.1f} MB")
    print(f"  Snapshot 2: {total2:>12,d} objects, {total_size2 / 1048576:>8.1f} MB")
    print(
        f"  Delta:      {total2 - total1:>+12,d} objects, {(total_size2 - total_size1) / 1048576:>+8.1f} MB"
    )
    print()

    # Sort by count delta descending
    deltas.sort(key=lambda x: -x[0])

    print(
        f"{'Class':<40s} {'Before':>10s} {'After':>10s} {'Δ Count':>10s} {'Δ Size (KB)':>12s}"
    )
    print("-" * 85)
    for count_delta, size_delta, cls, c1, c2, s1, s2 in deltas[:top_n]:
        if abs(count_delta) < 5:
            continue
        sign = "+" if count_delta > 0 else ""
        size_sign = "+" if size_delta > 0 else ""
        print(
            f"{cls:<40s} {c1:>10,d} {c2:>10,d} {sign}{count_delta:>9,d} "
            f"{size_sign}{size_delta / 1024:>10.1f}"
        )

    # Also show shrinkers
    deltas.sort(key=lambda x: x[0])
    shrinkers = [
        (d, sd, c, c1, c2, s1, s2) for d, sd, c, c1, c2, s1, s2 in deltas if d < -5
    ]
    if shrinkers:
        print(f"\nTop shrinkers:")
        print(f"{'Class':<40s} {'Before':>10s} {'After':>10s} {'Δ Count':>10s}")
        print("-" * 75)
        for count_delta, _, cls, c1, c2, _, _ in shrinkers[:15]:
            print(f"{cls:<40s} {c1:>10,d} {c2:>10,d} {count_delta:>+10,d}")


def cmd_big_objects(graph: HeapGraph, target_class: str, top_n: int = 30):
    """Find the largest individual objects of a given class."""
    objects = []
    for i in range(graph.node_count):
        if graph.node_class(i) == target_class:
            size = graph.node_size(i)
            label = graph.node_label(i)
            objects.append((size, i, label))

    objects.sort(key=lambda x: -x[0])

    print(f"\n{'=' * 80}")
    print(f"  LARGEST '{target_class}' OBJECTS (top {top_n})")
    print(f"{'=' * 80}\n")

    total = len(objects)
    total_size = sum(s for s, _, _ in objects)
    print(f"  Total: {total:,} objects, {total_size / 1048576:.1f} MB")
    print(f"  Average: {total_size / total if total else 0:.0f} bytes")
    print()

    # Size distribution
    buckets = [64, 128, 256, 512, 1024, 4096, 16384, 65536, 262144, 1048576]
    bucket_counts = [0] * (len(buckets) + 1)
    for size, _, _ in objects:
        placed = False
        for bi, threshold in enumerate(buckets):
            if size <= threshold:
                bucket_counts[bi] += 1
                placed = True
                break
        if not placed:
            bucket_counts[-1] += 1

    print(f"  Size distribution:")
    prev = 0
    for bi, threshold in enumerate(buckets):
        label = f"  {prev + 1:>8,d} – {threshold:>8,d} B"
        bar = "█" * min(bucket_counts[bi] * 60 // max(max(bucket_counts), 1), 60)
        print(f"  {label}: {bucket_counts[bi]:>8,d}  {bar}")
        prev = threshold
    if bucket_counts[-1] > 0:
        print(f"  {'>':>8s}{buckets[-1]:>8,d} B: {bucket_counts[-1]:>8,d}")

    print(f"\n  {'#':<5s} {'Size (B)':>10s} {'Node':>8s} {'Label':<60s}")
    print(f"  {'-' * 85}")
    for rank, (size, node_idx, label) in enumerate(objects[:top_n]):
        display_label = label[:60] if label else f"(node #{node_idx})"
        print(f"  {rank + 1:<5d} {size:>10,d} {node_idx:>8d} {display_label:<60s}")


def cmd_children(graph: HeapGraph, target_class: str, sample_size: int = 100):
    """For instances of target_class, what do they point to?
    This shows what a class CONTAINS, not what retains it."""
    print(f"\nBuilding outgoing edge map...", file=sys.stderr)
    outgoing = graph.build_outgoing_edges()

    target_nodes = [
        i for i in range(graph.node_count) if graph.node_class(i) == target_class
    ]

    if not target_nodes:
        print(f"No objects of class '{target_class}' found.")
        return

    import random

    if len(target_nodes) > sample_size:
        sampled = random.sample(target_nodes, sample_size)
    else:
        sampled = target_nodes

    # Count: what classes do instances of target_class point to?
    child_patterns = Counter()  # (edge_label, child_class) -> count
    child_class_only = Counter()

    for node_idx in sampled:
        children = outgoing.get(node_idx, [])
        for child_idx, label in children:
            child_class = graph.node_class(child_idx)
            child_patterns[(label or "<index>", child_class)] += 1
            child_class_only[child_class] += 1

    scale = len(target_nodes) / len(sampled) if sampled else 1

    print(f"\n{'=' * 80}")
    print(
        f"  CHILDREN OF '{target_class}' ({len(target_nodes):,} instances, "
        f"sampled {len(sampled)})"
    )
    print(f"{'=' * 80}\n")

    print(f"{'Property':<30s} {'Child Class':<30s} {'Count':>8s} {'Est. Total':>12s}")
    print("-" * 83)
    for (label, child_class), count in child_patterns.most_common(40):
        est = int(count * scale)
        print(f"{label:<30s} {child_class:<30s} {count:>8,d} {est:>12,d}")


def main():
    parser = argparse.ArgumentParser(
        description="Analyze JSC/Bun heap snapshots to find memory retention patterns.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("snapshot", help="Path to JSC heap snapshot JSON file")
    parser.add_argument(
        "--top",
        type=int,
        default=30,
        help="Number of top entries to show (default: 30)",
    )
    parser.add_argument(
        "--retainers",
        type=str,
        default=None,
        help="Show what retains instances of this class (e.g. --retainers=Object)",
    )
    parser.add_argument(
        "--children",
        type=str,
        default=None,
        help="Show what instances of this class point to (e.g. --children=Pino)",
    )
    parser.add_argument(
        "--big",
        type=str,
        default=None,
        help="Show largest individual objects of this class (e.g. --big=string)",
    )
    parser.add_argument(
        "--diff",
        type=str,
        default=None,
        help="Diff against another snapshot (e.g. --diff=earlier.json)",
    )
    parser.add_argument(
        "--depth", type=int, default=2, help="Retainer walk depth (default: 2)"
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=500,
        help="Sample size for retainer/children analysis (default: 500)",
    )
    parser.add_argument(
        "--class",
        dest="filter_class",
        type=str,
        default=None,
        help="Filter overview to classes matching this substring",
    )

    args = parser.parse_args()

    snap = load_snapshot(args.snapshot)
    graph = HeapGraph(snap)

    if args.diff:
        snap2 = load_snapshot(args.diff)
        graph2 = HeapGraph(snap2)
        cmd_diff(graph2, graph, args.top)  # graph2=before, graph=after
        return

    if args.retainers:
        cmd_retainers(graph, args.retainers, args.depth, args.sample)
        return

    if args.children:
        cmd_children(graph, args.children, args.sample)
        return

    if args.big:
        cmd_big_objects(graph, args.big, args.top)
        return

    # Default: overview
    cmd_overview(graph, args.top)

    # If a class filter was given, also show retainers for it
    if args.filter_class:
        counts = graph.get_class_counts()
        matching = [
            (cls, count)
            for cls, count in counts.items()
            if args.filter_class.lower() in cls.lower()
        ]
        if matching:
            matching.sort(key=lambda x: -x[1])
            print(f"\nClasses matching '{args.filter_class}':")
            for cls, count in matching[:20]:
                print(f"  {cls:<45s} {count:>10,d}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
import argparse
import collections
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


# FIXME: THe maestro data retrieval method is to be removed (2s latency), the html ids have not been committed to the repo.
SIMULATED_GLASSES_TEXT = "Simulated glasses"
MIRROR_ROOT_RESOURCE_ID = "glasses-mirror-root"
MIRROR_TEXT_WALL_RESOURCE_ID = "glasses-mirror-text-wall"
MIRROR_LINE_RESOURCE_ID_PREFIX = "glasses-mirror-line-"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a continuous word-level transcription monitor backed by a Hugging Face dataset.")
    parser.add_argument(
        "--dataset",
        default="olympusmons/librispeech_asr_test_clean_word_timestamp",
        help="Hugging Face dataset id with word timestamps and audio",
    )
    parser.add_argument("--config", default="default", help="Dataset config name")
    parser.add_argument("--split", default="train", help="Dataset split name")
    parser.add_argument("--page-size", type=int, default=8, help="Rows to fetch per dataset-server page")
    parser.add_argument("--playback-mode", choices=["local"], default="local", help="Currently only local audio playback is supported")
    parser.add_argument("--output-dir", required=True, help="Directory for monitor state and NDJSON history")
    parser.add_argument("--port", type=int, default=8765, help="Local dashboard port")
    parser.add_argument("--device", default=None, help="Optional adb device id")
    parser.add_argument("--poll-interval", type=float, default=0.25, help="Hierarchy poll interval in seconds")
    parser.add_argument("--word-match-early-tolerance-ms", type=int, default=250, help="Allow a visible word match slightly before the expected word timestamp")
    parser.add_argument("--drop-threshold-ms", type=int, default=5000, help="How long visible text can stagnate before a drop is recorded")
    parser.add_argument("--post-roll-ms", type=int, default=1200, help="Extra time after the last aligned word before closing an utterance")
    parser.add_argument("--inter-utterance-gap-ms", type=int, default=350, help="Gap between utterances in continuous playback")
    parser.add_argument("--max-history", type=int, default=500, help="How many completed utterances and drop events to keep in memory")
    parser.add_argument(
        "--local-playback-offset-ms",
        type=int,
        default=0,
        help="Shift expected timestamps later to account for local playback becoming audible after afplay starts.",
    )
    return parser.parse_args()


def normalize_text(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9\s]", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def tokenize(value: str) -> list[str]:
    return [token for token in normalize_text(value).split() if token]


def parse_hierarchy_output(raw_output: str) -> dict[str, Any]:
    json_start = raw_output.find("{")
    if json_start == -1:
        raise ValueError("Maestro hierarchy output did not contain JSON")
    return json.loads(raw_output[json_start:])


def find_parent_of_text(node: dict[str, Any], target: str) -> dict[str, Any] | None:
    children = node.get("children") or []
    for child in children:
        attributes = child.get("attributes") or {}
        if attributes.get("text") == target:
            return node
    for child in children:
        found = find_parent_of_text(child, target)
        if found:
            return found
    return None


def find_first_by_resource_id(node: dict[str, Any], resource_id: str) -> dict[str, Any] | None:
    attributes = node.get("attributes") or {}
    if attributes.get("resource-id") == resource_id:
        return node

    for child in node.get("children") or []:
        found = find_first_by_resource_id(child, resource_id)
        if found:
            return found
    return None


def extract_visible_transcript_lines(hierarchy: dict[str, Any]) -> tuple[bool, list[str]]:
    mirror_root = find_first_by_resource_id(hierarchy, MIRROR_ROOT_RESOURCE_ID)
    text_wall = find_first_by_resource_id(hierarchy, MIRROR_TEXT_WALL_RESOURCE_ID)
    if mirror_root and text_wall:
        indexed_lines: list[tuple[int, str]] = []
        for child in text_wall.get("children") or []:
            attributes = child.get("attributes") or {}
            resource_id = attributes.get("resource-id") or ""
            if not resource_id.startswith(MIRROR_LINE_RESOURCE_ID_PREFIX):
                continue

            text = (attributes.get("text") or "").strip()
            if not text:
                continue

            try:
                index = int(resource_id.removeprefix(MIRROR_LINE_RESOURCE_ID_PREFIX))
            except ValueError:
                continue
            indexed_lines.append((index, text))

        indexed_lines.sort(key=lambda item: item[0])
        return True, [text for _, text in indexed_lines]

    parent = find_parent_of_text(hierarchy, SIMULATED_GLASSES_TEXT)
    if not parent:
        return False, []

    lines: list[str] = []
    for child in parent.get("children") or []:
        attributes = child.get("attributes") or {}
        text = (attributes.get("text") or "").strip()
        if not text or text == SIMULATED_GLASSES_TEXT:
            continue
        lines.append(text)
    return True, lines


def run_maestro_hierarchy(device: str | None) -> dict[str, Any]:
    env = os.environ.copy()
    env["JAVA_HOME"] = "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    env["PATH"] = f'{env["JAVA_HOME"]}/bin:/opt/homebrew/bin:' + env["PATH"]
    cmd = ["maestro"]
    if device:
        cmd.extend(["--device", device])
    cmd.extend(["hierarchy", "--no-ansi"])
    result = subprocess.run(cmd, check=True, capture_output=True, text=True, env=env)
    return parse_hierarchy_output(result.stdout)


def write_ndjson(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=True) + "\n")


def trim_history(items: list[Any], max_items: int) -> list[Any]:
    if len(items) <= max_items:
        return items
    return items[-max_items:]

@dataclass
class WordState:
    index: int
    text: str
    normalized_text: str
    start_ms: int
    end_ms: int
    expected_ts_ms: int
    rn_first_visible_ts_ms: int | None = None
    rn_visible_delay_ms: int | None = None
    rn_true_first_visible_ts_ms: int | None = None
    rn_true_visible_delay_ms: int | None = None
    logcat_true_first_visible_ts_ms: int | None = None
    logcat_true_visible_delay_ms: int | None = None
    maestro_first_visible_ts_ms: int | None = None
    maestro_visible_delay_ms: int | None = None
    maestro_true_first_visible_ts_ms: int | None = None
    maestro_true_visible_delay_ms: int | None = None


@dataclass
class UtteranceState:
    dataset_row_idx: int
    text: str
    audio_url: str
    start_ts_ms: int
    end_ts_ms: int
    words: list[WordState]
    rn_matched_word_count: int = 0
    maestro_matched_word_count: int = 0
    rn_last_matched_index: int = -1
    rn_true_last_matched_index: int = -1
    logcat_true_last_matched_index: int = -1
    maestro_last_matched_index: int = -1
    maestro_true_last_matched_index: int = -1
    first_visible_activity_ts_ms: int | None = None
    last_visible_change_ts_ms: int | None = None
    last_signature: str = ""
    drop_open: dict[str, Any] | None = None


@dataclass
class PreparedRow:
    row: dict[str, Any]
    audio_file: Path


class DatasetCursor:
    def __init__(self, dataset: str, config: str, split: str, page_size: int, cached_rows: dict[int, dict[str, Any]] | None = None) -> None:
        self.dataset = dataset
        self.config = config
        self.split = split
        self.page_size = page_size
        self.page_cache: dict[int, list[dict[str, Any]]] = {}
        self.total_rows: int | None = None
        self.next_row_idx = 0
        self.cached_rows = cached_rows or {}
        self.cached_row_indices = sorted(self.cached_rows)

    def _fetch_page(self, page_start: int) -> list[dict[str, Any]]:
        if page_start in self.page_cache:
            return self.page_cache[page_start]

        params = urllib.parse.urlencode(
            {
                "dataset": self.dataset,
                "config": self.config,
                "split": self.split,
                "offset": page_start,
                "length": self.page_size,
            }
        )
        url = f"https://datasets-server.huggingface.co/rows?{params}"
        with urllib.request.urlopen(url, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))

        self.total_rows = int(payload["num_rows_total"])
        rows = payload["rows"]
        self.page_cache[page_start] = rows
        return rows

    def next_row(self) -> dict[str, Any]:
        if self.total_rows is not None and self.next_row_idx >= self.total_rows:
            self.next_row_idx = 0

        try:
            page_start = (self.next_row_idx // self.page_size) * self.page_size
            rows = self._fetch_page(page_start)
            row = rows[self.next_row_idx - page_start]
            self.next_row_idx += 1
            return row
        except Exception:
            if not self.cached_row_indices:
                raise
            cache_idx = self.cached_row_indices[self.next_row_idx % len(self.cached_row_indices)]
            self.next_row_idx += 1
            return self.cached_rows[cache_idx]


def load_cached_rows(output_dir: Path) -> dict[int, dict[str, Any]]:
    reports_path = output_dir / "utterance_reports.ndjson"
    if not reports_path.exists():
        return {}

    cached_rows: dict[int, dict[str, Any]] = {}
    for line in reports_path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        utterance = payload.get("utterance")
        if not utterance:
            continue

        row_idx = utterance.get("dataset_row_idx")
        start_ts_ms = utterance.get("start_ts_ms")
        words = utterance.get("words") or []
        if row_idx is None or start_ts_ms is None or not words:
            continue

        reconstructed_words: list[dict[str, Any]] = []
        for word in words:
            start_ms = int(word["start_ms"])
            end_ms = int(word["end_ms"])
            reconstructed_words.append(
                {
                    "text": word["text"],
                    "start": start_ms,
                    "end": end_ms,
                }
            )

        cached_rows[int(row_idx)] = {
            "row_idx": int(row_idx),
            "row": {
                "text": utterance.get("text", ""),
                "audio": [{"src": f"cached://{row_idx}"}],
                "words": reconstructed_words,
            },
        }
    return cached_rows


class MonitorState:
    def __init__(self, output_dir: Path, max_history: int, dataset: str, split: str) -> None:
        self.output_dir = output_dir
        self.max_history = max_history
        self.lock = threading.Lock()
        self.started_at_ms = int(time.time() * 1000)
        self.dataset = dataset
        self.split = split
        self.status = "starting"
        self.status_detail = "booting"
        self.last_error: str | None = None
        self.mirror_visible = False
        self.current_visible_lines: list[str] = []
        self.last_snapshot_ts_ms: int | None = None
        self.rn_visible_lines: list[str] = []
        self.last_rn_event_ts_ms: int | None = None
        self.logcat_visible_lines: list[str] = []
        self.last_logcat_event_ts_ms: int | None = None
        self.current_utterance: UtteranceState | None = None
        self.completed_utterances: list[dict[str, Any]] = []
        self.word_delay_points: list[dict[str, Any]] = []
        self.rn_word_delay_points: list[dict[str, Any]] = []
        self.rn_true_word_delay_points: list[dict[str, Any]] = []
        self.logcat_true_word_delay_points: list[dict[str, Any]] = []
        self.maestro_word_delay_points: list[dict[str, Any]] = []
        self.maestro_true_word_delay_points: list[dict[str, Any]] = []
        self.drop_events: list[dict[str, Any]] = []
        self.last_events: list[dict[str, Any]] = []

    def append_event(self, kind: str, payload: dict[str, Any]) -> None:
        event = {"kind": kind, **payload}
        self.last_events.append(event)
        self.last_events = trim_history(self.last_events, 100)
        write_ndjson(self.output_dir / "monitor_events.ndjson", event)

    def serialize_utterance(self, utterance: UtteranceState | None) -> dict[str, Any] | None:
        if utterance is None:
            return None
        return {
            "dataset_row_idx": utterance.dataset_row_idx,
            "text": utterance.text,
            "start_ts_ms": utterance.start_ts_ms,
            "end_ts_ms": utterance.end_ts_ms,
            "rn_matched_word_count": utterance.rn_matched_word_count,
            "maestro_matched_word_count": utterance.maestro_matched_word_count,
            "word_count": len(utterance.words),
            "first_visible_activity_ts_ms": utterance.first_visible_activity_ts_ms,
            "last_visible_change_ts_ms": utterance.last_visible_change_ts_ms,
            "words": [
                {
                    "index": word.index,
                    "text": word.text,
                    "start_ms": word.start_ms,
                    "end_ms": word.end_ms,
                    "expected_ts_ms": word.expected_ts_ms,
                    "rn_first_visible_ts_ms": word.rn_first_visible_ts_ms,
                    "rn_visible_delay_ms": word.rn_visible_delay_ms,
                    "rn_true_first_visible_ts_ms": word.rn_true_first_visible_ts_ms,
                    "rn_true_visible_delay_ms": word.rn_true_visible_delay_ms,
                    "logcat_true_first_visible_ts_ms": word.logcat_true_first_visible_ts_ms,
                    "logcat_true_visible_delay_ms": word.logcat_true_visible_delay_ms,
                    "maestro_first_visible_ts_ms": word.maestro_first_visible_ts_ms,
                    "maestro_visible_delay_ms": word.maestro_visible_delay_ms,
                    "maestro_true_first_visible_ts_ms": word.maestro_true_first_visible_ts_ms,
                    "maestro_true_visible_delay_ms": word.maestro_true_visible_delay_ms,
                }
                for word in utterance.words
            ],
        }

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "started_at_ms": self.started_at_ms,
                "dataset": self.dataset,
                "split": self.split,
                "status": self.status,
                "status_detail": self.status_detail,
                "last_error": self.last_error,
                "mirror_visible": self.mirror_visible,
                "current_visible_lines": list(self.current_visible_lines),
                "last_snapshot_ts_ms": self.last_snapshot_ts_ms,
                "rn_visible_lines": list(self.rn_visible_lines),
                "last_rn_event_ts_ms": self.last_rn_event_ts_ms,
                "logcat_visible_lines": list(self.logcat_visible_lines),
                "last_logcat_event_ts_ms": self.last_logcat_event_ts_ms,
                "current_utterance": self.serialize_utterance(self.current_utterance),
                "completed_utterances": list(self.completed_utterances),
                "word_delay_points": list(self.word_delay_points),
                "rn_word_delay_points": list(self.rn_word_delay_points),
                "rn_true_word_delay_points": list(self.rn_true_word_delay_points),
                "logcat_true_word_delay_points": list(self.logcat_true_word_delay_points),
                "maestro_word_delay_points": list(self.maestro_word_delay_points),
                "maestro_true_word_delay_points": list(self.maestro_true_word_delay_points),
                "drop_events": list(self.drop_events),
                "last_events": list(self.last_events),
            }


def lcs_reference_indices(reference_tokens: list[str], candidate_tokens: list[str]) -> list[int]:
    ref_len = len(reference_tokens)
    cand_len = len(candidate_tokens)
    if ref_len == 0 or cand_len == 0:
        return []

    dp = [[0] * (cand_len + 1) for _ in range(ref_len + 1)]
    for ref_idx in range(ref_len - 1, -1, -1):
        for cand_idx in range(cand_len - 1, -1, -1):
            if reference_tokens[ref_idx] == candidate_tokens[cand_idx]:
                dp[ref_idx][cand_idx] = 1 + dp[ref_idx + 1][cand_idx + 1]
            else:
                dp[ref_idx][cand_idx] = max(dp[ref_idx + 1][cand_idx], dp[ref_idx][cand_idx + 1])

    indices: list[int] = []
    ref_idx = 0
    cand_idx = 0
    while ref_idx < ref_len and cand_idx < cand_len:
        if reference_tokens[ref_idx] == candidate_tokens[cand_idx]:
            indices.append(ref_idx)
            ref_idx += 1
            cand_idx += 1
        elif dp[ref_idx + 1][cand_idx] >= dp[ref_idx][cand_idx + 1]:
            ref_idx += 1
        else:
            cand_idx += 1
    return indices


def consecutive_runs(indices: list[int]) -> list[list[int]]:
    if not indices:
        return []
    runs = [[indices[0]]]
    for index in indices[1:]:
        if index == runs[-1][-1] + 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    return runs


def build_candidate_token_positions(candidate_tokens: list[str]) -> dict[str, list[int]]:
    positions: dict[str, list[int]] = {}
    for index, token in enumerate(candidate_tokens):
        positions.setdefault(token, []).append(index)
    return positions


def has_local_context_match(reference_tokens: list[str], candidate_tokens: list[str], ref_index: int) -> bool:
    if ref_index < 0 or ref_index >= len(reference_tokens):
        return False

    candidate_positions = build_candidate_token_positions(candidate_tokens)
    current_token = reference_tokens[ref_index]
    current_positions = candidate_positions.get(current_token) or []
    if not current_positions:
        return False

    prev_token = reference_tokens[ref_index - 1] if ref_index > 0 else None
    next_token = reference_tokens[ref_index + 1] if ref_index + 1 < len(reference_tokens) else None
    prev_positions = candidate_positions.get(prev_token, []) if prev_token else []
    next_positions = candidate_positions.get(next_token, []) if next_token else []

    for current_pos in current_positions:
        prev_ok = not prev_token or any(prev_pos < current_pos for prev_pos in prev_positions)
        next_ok = not next_token or any(next_pos > current_pos for next_pos in next_positions)
        if prev_token and next_token:
            if prev_ok or next_ok:
                return True
        elif prev_token or next_token:
            if prev_ok and next_ok:
                return True
        else:
            return True
    return False


def download_audio(cache_dir: Path, row_idx: int, audio_url: str) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / f"{row_idx}.wav"
    if destination.exists():
        return destination

    with urllib.request.urlopen(audio_url, timeout=60) as response:
        destination.write_bytes(response.read())
    return destination


def play_audio_locally(audio_file: Path) -> subprocess.Popen[bytes]:
    return subprocess.Popen(["afplay", str(audio_file)])


class MonitorWorker:
    def __init__(self, args: argparse.Namespace, state: MonitorState, cursor: DatasetCursor) -> None:
        self.args = args
        self.state = state
        self.cursor = cursor
        self.stop_event = threading.Event()
        self.playback_process: subprocess.Popen[bytes] | None = None
        self.next_start_ts_ms = int(time.time() * 1000)
        self.audio_cache_dir = state.output_dir / "audio-cache"
        self.prefetch_queue: collections.deque[PreparedRow] = collections.deque()
        self.prefetch_lock = threading.Lock()
        self.prefetch_target = 3
        self.rn_stream_process: subprocess.Popen[str] | None = None
        self.logcat_process: subprocess.Popen[str] | None = None
        self.use_rn_stream = False
        self.use_maestro_stream = False

    def make_utterance(self, prepared_row: PreparedRow, now_ms: int) -> UtteranceState:
        row = prepared_row.row
        payload = row["row"]
        words = []
        for index, item in enumerate(payload["words"]):
            normalized = normalize_text(item["text"])
            if not normalized:
                continue
            words.append(
                WordState(
                    index=len(words),
                    text=item["text"],
                    normalized_text=normalized,
                    start_ms=int(item["start"]),
                    end_ms=int(item["end"]),
                    expected_ts_ms=now_ms + self.args.local_playback_offset_ms + int(item["end"]),
                )
            )

        last_end_ms = words[-1].end_ms if words else 0
        return UtteranceState(
            dataset_row_idx=int(row["row_idx"]),
            text=payload["text"],
            audio_url=payload["audio"][0]["src"],
            start_ts_ms=now_ms + self.args.local_playback_offset_ms,
            end_ts_ms=now_ms + self.args.local_playback_offset_ms + last_end_ms + self.args.post_roll_ms,
            words=words,
        )

    def start_next_utterance(self, now_ms: int) -> None:
        prepared_row: PreparedRow | None = None
        with self.prefetch_lock:
            if self.prefetch_queue:
                prepared_row = self.prefetch_queue.popleft()
        if prepared_row is None:
            self.state.status = "prefetching"
            self.state.status_detail = "waiting for prefetched audio"
            return

        utterance = self.make_utterance(prepared_row, now_ms)
        self.playback_process = play_audio_locally(prepared_row.audio_file)
        self.state.current_utterance = utterance
        self.state.status = "running_utterance"
        self.state.status_detail = f"row {utterance.dataset_row_idx}"
        self.state.append_event(
            "utterance_started",
            {
                "dataset_row_idx": utterance.dataset_row_idx,
                "text": utterance.text,
                "start_ts_ms": utterance.start_ts_ms,
                "end_ts_ms": utterance.end_ts_ms,
                "word_count": len(utterance.words),
            },
        )
        write_ndjson(
            self.state.output_dir / "utterance_reports.ndjson",
            {
                "event": "utterance_started",
                "dataset_row_idx": utterance.dataset_row_idx,
                "text": utterance.text,
                "start_ts_ms": utterance.start_ts_ms,
                "end_ts_ms": utterance.end_ts_ms,
                "word_count": len(utterance.words),
            },
        )

    def finalize_utterance(self, utterance: UtteranceState, now_ms: int) -> None:
        if utterance.drop_open is not None:
            duration_ms = now_ms - int(utterance.drop_open["started_at_ms"])
            if duration_ms >= self.args.drop_threshold_ms:
                drop = {
                    "dataset_row_idx": utterance.dataset_row_idx,
                    "started_at_ms": int(utterance.drop_open["started_at_ms"]),
                    "ended_at_ms": now_ms,
                    "duration_ms": duration_ms,
                }
                self.state.drop_events.append(drop)
                self.state.drop_events = trim_history(self.state.drop_events, self.state.max_history)
                self.state.append_event("drop_event", drop)

        rn_delays = [word.rn_visible_delay_ms for word in utterance.words if word.rn_visible_delay_ms is not None]
        rn_true_delays = [word.rn_true_visible_delay_ms for word in utterance.words if word.rn_true_visible_delay_ms is not None]
        logcat_true_delays = [word.logcat_true_visible_delay_ms for word in utterance.words if word.logcat_true_visible_delay_ms is not None]
        maestro_delays = [word.maestro_visible_delay_ms for word in utterance.words if word.maestro_visible_delay_ms is not None]
        maestro_true_delays = [word.maestro_true_visible_delay_ms for word in utterance.words if word.maestro_true_visible_delay_ms is not None]
        summary = {
            "dataset_row_idx": utterance.dataset_row_idx,
            "text": utterance.text,
            "start_ts_ms": utterance.start_ts_ms,
            "end_ts_ms": utterance.end_ts_ms,
            "rn_matched_words": utterance.rn_matched_word_count,
            "maestro_matched_words": utterance.maestro_matched_word_count,
            "word_count": len(utterance.words),
            "average_rn_delay_ms": int(sum(rn_delays) / len(rn_delays)) if rn_delays else None,
            "average_rn_true_delay_ms": int(sum(rn_true_delays) / len(rn_true_delays)) if rn_true_delays else None,
            "average_logcat_true_delay_ms": int(sum(logcat_true_delays) / len(logcat_true_delays)) if logcat_true_delays else None,
            "max_rn_delay_ms": max(rn_delays) if rn_delays else None,
            "max_rn_true_delay_ms": max(rn_true_delays) if rn_true_delays else None,
            "max_logcat_true_delay_ms": max(logcat_true_delays) if logcat_true_delays else None,
            "average_maestro_delay_ms": int(sum(maestro_delays) / len(maestro_delays)) if maestro_delays else None,
            "max_maestro_delay_ms": max(maestro_delays) if maestro_delays else None,
            "average_maestro_true_delay_ms": int(sum(maestro_true_delays) / len(maestro_true_delays)) if maestro_true_delays else None,
            "max_maestro_true_delay_ms": max(maestro_true_delays) if maestro_true_delays else None,
        }
        self.state.completed_utterances.append(summary)
        self.state.completed_utterances = trim_history(self.state.completed_utterances, self.state.max_history)
        self.state.append_event("utterance_completed", summary)
        write_ndjson(
            self.state.output_dir / "utterance_reports.ndjson",
            {"summary": summary, "utterance": self.state.serialize_utterance(utterance)},
        )
        self.state.current_utterance = None
        self.state.status = "between_utterances"
        self.state.status_detail = "waiting for next utterance"
        self.next_start_ts_ms = now_ms + self.args.inter_utterance_gap_ms

    def update_drop_tracking(self, utterance: UtteranceState, now_ms: int, normalized_lines: list[str]) -> None:
        signature = "|".join(normalized_lines)
        if signature != utterance.last_signature:
            utterance.last_signature = signature
            utterance.last_visible_change_ts_ms = now_ms
            utterance.drop_open = None
            if normalized_lines and utterance.first_visible_activity_ts_ms is None:
                utterance.first_visible_activity_ts_ms = now_ms
            return

        if utterance.first_visible_activity_ts_ms is None or utterance.last_visible_change_ts_ms is None:
            return

        if now_ms - utterance.last_visible_change_ts_ms < self.args.drop_threshold_ms:
            return

        if utterance.drop_open is None:
            utterance.drop_open = {
                "dataset_row_idx": utterance.dataset_row_idx,
                "started_at_ms": utterance.last_visible_change_ts_ms,
            }

    def maybe_record_word_matches(
        self,
        utterance: UtteranceState,
        now_ms: int,
        visible_lines: list[str],
        source: str,
        min_run_length: int = 2,
    ) -> None:
        candidate_tokens = [token for line in visible_lines for token in tokenize(line)]
        reference_tokens = [word.normalized_text for word in utterance.words]
        if not candidate_tokens:
            return
        matched_indices = lcs_reference_indices(reference_tokens, candidate_tokens)
        cursor_by_source = {
            "rn": utterance.rn_last_matched_index,
            "rn_true": utterance.rn_true_last_matched_index,
            "logcat_true": utterance.logcat_true_last_matched_index,
            "maestro": utterance.maestro_last_matched_index,
            "maestro_true": utterance.maestro_true_last_matched_index,
        }
        current_cursor = cursor_by_source[source]
        for run in consecutive_runs(matched_indices):
            if len(run) < min_run_length:
                continue
            for ref_index in run:
                if ref_index <= current_cursor:
                    continue
                if source == "logcat_true" and not has_local_context_match(reference_tokens, candidate_tokens, ref_index):
                    continue
                word = utterance.words[ref_index]
                if source == "rn" and word.rn_first_visible_ts_ms is not None:
                    continue
                if source == "rn_true" and word.rn_true_first_visible_ts_ms is not None:
                    continue
                if source == "logcat_true" and word.logcat_true_first_visible_ts_ms is not None:
                    continue
                if source == "maestro" and word.maestro_first_visible_ts_ms is not None:
                    continue
                if source == "maestro_true" and word.maestro_true_first_visible_ts_ms is not None:
                    continue
                if now_ms < word.expected_ts_ms - self.args.word_match_early_tolerance_ms:
                    continue
                if source == "logcat_true" and now_ms < word.expected_ts_ms:
                    continue

                delay_ms = max(0, now_ms - word.expected_ts_ms)
                if source == "rn":
                    word.rn_first_visible_ts_ms = now_ms
                    word.rn_visible_delay_ms = delay_ms
                    utterance.rn_matched_word_count += 1
                    utterance.rn_last_matched_index = ref_index
                elif source == "rn_true":
                    word.rn_true_first_visible_ts_ms = now_ms
                    word.rn_true_visible_delay_ms = delay_ms
                    utterance.rn_true_last_matched_index = ref_index
                elif source == "logcat_true":
                    word.logcat_true_first_visible_ts_ms = now_ms
                    word.logcat_true_visible_delay_ms = delay_ms
                    utterance.logcat_true_last_matched_index = ref_index
                elif source == "maestro_true":
                    word.maestro_true_first_visible_ts_ms = now_ms
                    word.maestro_true_visible_delay_ms = delay_ms
                    utterance.maestro_true_last_matched_index = ref_index
                else:
                    word.maestro_first_visible_ts_ms = now_ms
                    word.maestro_visible_delay_ms = delay_ms
                    utterance.maestro_matched_word_count += 1
                    utterance.maestro_last_matched_index = ref_index
                current_cursor = ref_index

                point = {
                    "source": source,
                    "dataset_row_idx": utterance.dataset_row_idx,
                    "word_index": word.index,
                    "word_text": word.text,
                    "ts_ms": now_ms,
                    "delay_ms": delay_ms,
                    "expected_ts_ms": word.expected_ts_ms,
                }
                self.state.word_delay_points.append(point)
                self.state.word_delay_points = trim_history(self.state.word_delay_points, self.state.max_history * 40)
                if source == "rn":
                    self.state.rn_word_delay_points.append(point)
                    self.state.rn_word_delay_points = trim_history(self.state.rn_word_delay_points, self.state.max_history * 40)
                elif source == "rn_true":
                    self.state.rn_true_word_delay_points.append(point)
                    self.state.rn_true_word_delay_points = trim_history(self.state.rn_true_word_delay_points, self.state.max_history * 40)
                elif source == "logcat_true":
                    self.state.logcat_true_word_delay_points.append(point)
                    self.state.logcat_true_word_delay_points = trim_history(self.state.logcat_true_word_delay_points, self.state.max_history * 40)
                elif source == "maestro_true":
                    self.state.maestro_true_word_delay_points.append(point)
                    self.state.maestro_true_word_delay_points = trim_history(self.state.maestro_true_word_delay_points, self.state.max_history * 40)
                else:
                    self.state.maestro_word_delay_points.append(point)
                    self.state.maestro_word_delay_points = trim_history(self.state.maestro_word_delay_points, self.state.max_history * 40)
                self.state.append_event("word_match", point)

    def prefetch_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                with self.prefetch_lock:
                    queue_len = len(self.prefetch_queue)
                if queue_len >= self.prefetch_target:
                    self.stop_event.wait(0.2)
                    continue

                row = self.cursor.next_row()
                payload = row["row"]
                audio_url = payload["audio"][0]["src"]
                audio_file = download_audio(self.audio_cache_dir, int(row["row_idx"]), audio_url)
                prepared_row = PreparedRow(row=row, audio_file=audio_file)
                with self.prefetch_lock:
                    self.prefetch_queue.append(prepared_row)
                self.state.append_event(
                    "prefetch_ready",
                    {"dataset_row_idx": int(row["row_idx"]), "queue_size": len(self.prefetch_queue)},
                )
            except Exception as exc:
                self.state.append_event("prefetch_error", {"message": str(exc), "ts_ms": int(time.time() * 1000)})
                wait_seconds = 5.0 if "429" in str(exc) else 1.0
                self.stop_event.wait(wait_seconds)

    def rn_stream_loop(self) -> None:
        if not self.use_rn_stream:
            while not self.stop_event.is_set():
                self.stop_event.wait(1.0)
            return
        env = os.environ.copy()
        ws_client_path = "/Users/philippe/dev/MentraOS/mobile/node_modules/ws"
        script = f"""
const WebSocket = require('{ws_client_path}');
const url = 'ws://127.0.0.1:8081/inspector/debug?device=be0a65eac579679011002841bc2cd9d8edd32716&page=1';
const ws = new WebSocket(url);
ws.on('open', () => {{
  ws.send(JSON.stringify({{id:1, method:'Runtime.enable'}}));
  ws.send(JSON.stringify({{id:2, method:'Console.enable'}}));
  ws.send(JSON.stringify({{id:3, method:'Log.enable'}}));
}});
ws.on('message', (data) => {{
  try {{
    const msg = JSON.parse(data.toString());
    if (msg.method !== 'Runtime.consoleAPICalled') return;
    const arg = msg.params?.args?.[0]?.value || '';
    const prefix = 'E2E_METRIC ';
    if (!arg.startsWith(prefix)) return;
    const payload = JSON.parse(arg.slice(prefix.length));
    if (payload.event !== 'display_store_update') return;
    process.stdout.write(JSON.stringify(payload) + '\\n');
  }} catch (_err) {{}}
}});
ws.on('error', (err) => process.stderr.write(String(err && err.message || err) + '\\n'));
"""
        while not self.stop_event.is_set():
            try:
                self.rn_stream_process = subprocess.Popen(
                    ["node", "-e", script],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=env,
                )
                assert self.rn_stream_process.stdout is not None
                for line in self.rn_stream_process.stdout:
                    if self.stop_event.is_set():
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if payload.get("event") != "display_store_update":
                        continue
                    now_ms = int(payload.get("ts_ms") or time.time() * 1000)
                    visible_lines = payload.get("text_lines") or []
                    normalized_lines = [normalize_text(item) for item in visible_lines]
                    with self.state.lock:
                        self.state.rn_visible_lines = visible_lines
                        self.state.last_rn_event_ts_ms = now_ms
                        write_ndjson(
                            self.state.output_dir / "rn_events.ndjson",
                            {
                                "ts_ms": now_ms,
                                "visible_lines": visible_lines,
                                "normalized_visible_lines": normalized_lines,
                                "source": "rn_inspector",
                            },
                        )
                        utterance = self.state.current_utterance
                        if utterance is not None:
                            self.maybe_record_word_matches(utterance, now_ms, visible_lines, "rn_true", min_run_length=1)
                            self.maybe_record_word_matches(utterance, now_ms, visible_lines, "rn")
                if self.rn_stream_process.poll() is None:
                    self.rn_stream_process.terminate()
            except Exception as exc:
                self.state.append_event("rn_stream_error", {"ts_ms": int(time.time() * 1000), "message": str(exc)})
            self.stop_event.wait(1.0)

    def logcat_stream_loop(self) -> None:
        adb_cmd = ["adb"]
        if self.args.device:
            adb_cmd.extend(["-s", self.args.device])
        adb_cmd.extend(["logcat", "-T", "1", "ReactNativeJS:I", "*:S"])

        while not self.stop_event.is_set():
            try:
                self.logcat_process = subprocess.Popen(
                    adb_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                assert self.logcat_process.stdout is not None
                for line in self.logcat_process.stdout:
                    if self.stop_event.is_set():
                        break
                    marker = "E2E_METRIC "
                    if marker not in line:
                        continue
                    payload_text = line.split(marker, 1)[1].strip()
                    try:
                        payload = json.loads(payload_text)
                    except json.JSONDecodeError:
                        continue

                    if payload.get("event") != "display_store_update":
                        continue

                    now_ms = int(payload.get("ts_ms") or time.time() * 1000)
                    visible_lines = payload.get("text_lines") or []
                    normalized_lines = [normalize_text(item) for item in visible_lines]
                    with self.state.lock:
                        self.state.logcat_visible_lines = visible_lines
                        self.state.last_logcat_event_ts_ms = now_ms
                        write_ndjson(
                            self.state.output_dir / "logcat_events.ndjson",
                            {
                                "ts_ms": now_ms,
                                "visible_lines": visible_lines,
                                "normalized_visible_lines": normalized_lines,
                                "source": "logcat",
                            },
                        )
                        utterance = self.state.current_utterance
                        if utterance is not None:
                            self.maybe_record_word_matches(utterance, now_ms, visible_lines, "logcat_true", min_run_length=1)
                if self.logcat_process.poll() is None:
                    self.logcat_process.terminate()
            except Exception as exc:
                self.state.append_event("logcat_stream_error", {"ts_ms": int(time.time() * 1000), "message": str(exc)})
            self.stop_event.wait(1.0)

    def monitor_loop(self) -> None:
        while not self.stop_event.is_set():
            started = time.time()
            now_ms = int(started * 1000)
            try:
                with self.state.lock:
                    if self.use_maestro_stream:
                        hierarchy = run_maestro_hierarchy(self.args.device)
                        mirror_visible, visible_lines = extract_visible_transcript_lines(hierarchy)
                        normalized_lines = [normalize_text(line) for line in visible_lines]
                        self.state.mirror_visible = mirror_visible
                        self.state.current_visible_lines = visible_lines
                        self.state.last_snapshot_ts_ms = now_ms
                        write_ndjson(
                            self.state.output_dir / "live_snapshots.ndjson",
                            {
                                "ts_ms": now_ms,
                                "mirror_visible": mirror_visible,
                                "visible_lines": visible_lines,
                                "normalized_visible_lines": normalized_lines,
                                "source": "maestro",
                            },
                        )
                    else:
                        mirror_visible = True
                        visible_lines = []
                        normalized_lines = []
                        self.state.mirror_visible = True

                    utterance = self.state.current_utterance
                    if utterance is None:
                        if self.use_maestro_stream and not mirror_visible:
                            self.state.status = "waiting_for_mirror"
                            self.state.status_detail = "Simulated glasses mirror is not visible"
                        elif now_ms >= self.next_start_ts_ms:
                            self.start_next_utterance(now_ms)
                        else:
                            self.state.status = "between_utterances"
                            self.state.status_detail = "waiting for next utterance"
                    else:
                        if self.use_maestro_stream:
                            self.maybe_record_word_matches(utterance, now_ms, visible_lines, "maestro_true", min_run_length=1)
                            self.maybe_record_word_matches(utterance, now_ms, visible_lines, "maestro")
                            self.update_drop_tracking(utterance, now_ms, normalized_lines)
                        if now_ms >= utterance.end_ts_ms:
                            self.finalize_utterance(utterance, now_ms)

                    self.state.last_error = None
            except Exception as exc:
                with self.state.lock:
                    self.state.last_error = str(exc)
                    self.state.status = "error"
                    self.state.status_detail = "collector error"
                    self.state.append_event("error", {"ts_ms": now_ms, "message": str(exc)})

            elapsed = time.time() - started
            self.stop_event.wait(max(self.args.poll_interval - elapsed, 0.01))

        if self.playback_process is not None and self.playback_process.poll() is None:
            self.playback_process.terminate()
        if self.rn_stream_process is not None and self.rn_stream_process.poll() is None:
            self.rn_stream_process.terminate()
        if self.logcat_process is not None and self.logcat_process.poll() is None:
            self.logcat_process.terminate()


HTML_PAGE = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MentraOS Word Delay Monitor</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b1220; color: #e5eef9; }
    .wrap { max-width: 1500px; margin: 0 auto; padding: 20px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .card { background: #121b2d; border: 1px solid #24314f; border-radius: 12px; padding: 14px; }
    .wide { grid-column: span 2; }
    h1, h2 { margin: 0 0 12px; font-weight: 700; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    h2 { font-size: 16px; }
    .label { color: #89a1c6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; background: #203254; }
    .ok { background: #184f33; color: #b6f2cf; }
    .warn { background: #574115; color: #f7e2a2; }
    .bad { background: #5e1f25; color: #ffbec4; }
    .small { font-size: 12px; color: #9eb3d1; }
    .lines { white-space: pre-wrap; line-height: 1.5; }
    .long { max-height: 220px; overflow: auto; }
    #chart { width: 100%; height: 360px; background: #0f1728; border-radius: 10px; border: 1px solid #24314f; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 6px; text-align: left; border-bottom: 1px solid #24314f; vertical-align: top; }
    th { color: #89a1c6; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MentraOS Live Word Delay Monitor</h1>
    <div class="grid">
      <div class="card"><div class="label">Status</div><div id="status" class="value">Loading...</div><div id="statusDetail" class="small"></div></div>
      <div class="card"><div class="label">Mirror Visible</div><div id="mirror" class="value">-</div><div id="snapshotAge" class="small"></div></div>
      <div class="card"><div class="label">Current Row</div><div id="rowIdx" class="value">-</div><div id="wordProgress" class="small"></div></div>
      <div class="card"><div class="label">Drop Events &gt; 5s</div><div id="dropCount" class="value">0</div><div class="small">Across all utterances</div></div>
    </div>

    <div class="grid">
      <div class="card wide">
        <h2>Word Delay Over Time</h2>
        <div id="chart"></div>
        <div class="small">Use the built-in range buttons, zoom, pan, and range slider to inspect incidents. Purple = raw points, orange = 10-point moving average.</div>
      </div>
      <div class="card">
        <h2>Logcat Visible Text</h2>
        <div id="logcatVisibleLines" class="lines small long"></div>
      </div>
    </div>

    <div class="grid">
      <div class="card wide">
        <h2>Current Utterance</h2>
        <div id="utteranceText" class="small lines long"></div>
      </div>
      <div class="card">
        <h2>Source Ages</h2>
        <div id="sourceAges" class="small lines"></div>
      </div>
    </div>

    <div class="grid">
      <div class="card wide">
        <h2>Recent Word Matches</h2>
        <table id="wordTable"><thead><tr><th>Word</th><th>Delay</th><th>Expected</th><th>Seen</th></tr></thead><tbody></tbody></table>
      </div>
      <div class="card">
        <h2>Live Time</h2>
        <div id="liveClock" class="value">-</div>
        <div id="liveClockMs" class="small"></div>
        <div class="label" style="margin-top: 12px;">Current Timing Window</div>
        <div id="timingWindow" class="small lines long">-</div>
      </div>
      <div class="card wide">
        <h2>Recent Utterances</h2>
        <table id="utteranceTable"><thead><tr><th>Row</th><th>Avg Logcat True</th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>
  <script>
    function fmtTs(ms) {
      if (!ms) return '-';
      return new Date(ms).toLocaleTimeString();
    }
    function fmtTsWithMs(ms) {
      if (!ms) return '-';
      const date = new Date(ms);
      return `${date.toLocaleTimeString()}.${String(date.getMilliseconds()).padStart(3, '0')}`;
    }
    function fmtMs(ms) {
      if (ms === null || ms === undefined) return '-';
      return `${Math.round(ms)} ms`;
    }
    function ageFrom(ms) {
      if (!ms) return '-';
      const delta = Math.max(0, Date.now() - ms);
      return `${(delta / 1000).toFixed(1)}s ago`;
    }
    function statusClass(status) {
      if (status === 'running_utterance') return 'pill ok';
      if (status === 'error') return 'pill bad';
      return 'pill warn';
    }
    function fillRows(id, rows, colspan) {
      const tbody = document.querySelector(`#${id} tbody`);
      tbody.innerHTML = rows.length ? rows.join('') : `<tr><td colspan="${colspan}" class="small">No data yet</td></tr>`;
    }
    function renderChart(logcatTruePoints) {
      const chart = document.getElementById('chart');
      const points = [...logcatTruePoints].sort((a, b) => a.ts_ms - b.ts_ms);
      if (!points.length) {
        chart.innerHTML = '<div class="small" style="padding: 24px; color: #89a1c6;">Waiting for word delay points...</div>';
        return;
      }
      const movingAveragePoints = [];
      for (let index = 9; index < points.length; index += 1) {
        const window = points.slice(index - 9, index + 1);
        const avgDelay = window.reduce((sum, point) => sum + (point.delay_ms || 0), 0) / window.length;
        movingAveragePoints.push({ ts_ms: points[index].ts_ms, delay_ms: avgDelay });
      }
      const traces = [
        {
          name: 'Logcat true',
          type: 'scattergl',
          mode: 'markers',
          x: points.map((point) => new Date(point.ts_ms)),
          y: points.map((point) => point.delay_ms),
          text: points.map((point) => `Row ${point.dataset_row_idx} • ${point.word_text}`),
          hovertemplate: '%{text}<br>%{x|%b %d, %I:%M:%S %p}<br>%{y:.0f} ms<extra></extra>',
          marker: { color: '#c084fc', size: 5, opacity: 0.85 },
        },
        {
          name: '10-pt avg',
          type: 'scattergl',
          mode: 'lines',
          x: movingAveragePoints.map((point) => new Date(point.ts_ms)),
          y: movingAveragePoints.map((point) => point.delay_ms),
          hovertemplate: '%{x|%b %d, %I:%M:%S %p}<br>%{y:.0f} ms<extra></extra>',
          line: { color: '#f59e0b', width: 3, shape: 'linear' },
        },
      ];
      const layout = {
        uirevision: 'word-delay-chart',
        paper_bgcolor: '#0f1728',
        plot_bgcolor: '#0f1728',
        margin: { l: 72, r: 24, t: 16, b: 64 },
        font: { color: '#e5eef9', family: 'ui-sans-serif, system-ui, sans-serif' },
        hovermode: 'closest',
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.12 },
        xaxis: {
          type: 'date',
          title: { text: 'Time' },
          gridcolor: '#24314f',
          zeroline: false,
          tickformat: '%-I:%M %p',
          rangeslider: { visible: true, bgcolor: '#121b2d', bordercolor: '#24314f' },
          rangeselector: {
            bgcolor: '#17233a',
            activecolor: '#23406e',
            bordercolor: '#314261',
            font: { color: '#e5eef9' },
            buttons: [
              { count: 5, step: 'minute', stepmode: 'backward', label: '5m' },
              { count: 15, step: 'minute', stepmode: 'backward', label: '15m' },
              { count: 30, step: 'minute', stepmode: 'backward', label: '30m' },
              { count: 1, step: 'hour', stepmode: 'backward', label: '1h' },
              { count: 6, step: 'hour', stepmode: 'backward', label: '6h' },
              { count: 24, step: 'hour', stepmode: 'backward', label: '24h' },
              { step: 'all', label: 'All' },
            ],
          },
        },
        yaxis: {
          title: { text: 'Delay' },
          gridcolor: '#24314f',
          zeroline: false,
          rangemode: 'tozero',
          range: [0, null],
          tickformat: '~s',
          tickvals: undefined,
          ticktext: undefined,
          hoverformat: '.0f',
        },
      };
      const maxDelay = Math.max(3000, ...points.map((point) => point.delay_ms || 0), ...movingAveragePoints.map((point) => point.delay_ms || 0));
      const stepMs = 500;
      const tickvals = [];
      const ticktext = [];
      for (let value = 0; value <= Math.ceil(maxDelay / stepMs) * stepMs; value += stepMs) {
        tickvals.push(value);
        ticktext.push(`${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}s`);
      }
      layout.yaxis.tickvals = tickvals;
      layout.yaxis.ticktext = ticktext;
      const config = {
        responsive: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
      };
      Plotly.react(chart, traces, layout, config);
    }
    async function refresh() {
      const state = await (await fetch('/state')).json();
      document.getElementById('status').innerHTML = `<span class="${statusClass(state.status)}">${state.status}</span>`;
      document.getElementById('statusDetail').textContent = state.status_detail || '';
      document.getElementById('mirror').textContent = state.mirror_visible ? 'Yes' : 'No';
      document.getElementById('snapshotAge').textContent = `Last Maestro snapshot ${ageFrom(state.last_snapshot_ts_ms)}`;
      document.getElementById('rowIdx').textContent = state.current_utterance ? `#${state.current_utterance.dataset_row_idx}` : '-';
      document.getElementById('wordProgress').textContent = state.current_utterance ? `RN ${state.current_utterance.rn_matched_word_count}/${state.current_utterance.word_count}, Maestro ${state.current_utterance.maestro_matched_word_count}/${state.current_utterance.word_count}` : 'Waiting for utterance';
      document.getElementById('dropCount').textContent = String(state.drop_events.length);
      document.getElementById('liveClock').textContent = fmtTs(Date.now());
      document.getElementById('liveClockMs').textContent = fmtTsWithMs(Date.now());
      document.getElementById('logcatVisibleLines').textContent = state.logcat_visible_lines.length ? state.logcat_visible_lines.join('\\n') : '(no logcat event yet)';
      document.getElementById('utteranceText').textContent = state.current_utterance ? state.current_utterance.text : '(none)';
      document.getElementById('sourceAges').textContent = `Logcat: ${ageFrom(state.last_logcat_event_ts_ms)}`;
      if (state.current_utterance) {
        const words = state.current_utterance.words || [];
        const nextWord = words.find((word) => !word.rn_true_first_visible_ts_ms) || null;
        const currentWord = [...words].reverse().find((word) => word.rn_true_first_visible_ts_ms) || null;
        document.getElementById('timingWindow').textContent =
          `Utterance start: ${fmtTsWithMs(state.current_utterance.start_ts_ms)}\n` +
          `Utterance end: ${fmtTsWithMs(state.current_utterance.end_ts_ms)}\n` +
          `Current/last matched word: ${currentWord ? `${currentWord.text} @ ${fmtTsWithMs(currentWord.expected_ts_ms)}` : '-'}\n` +
          `Next expected word: ${nextWord ? `${nextWord.text} @ ${fmtTsWithMs(nextWord.expected_ts_ms)}` : '-'}`;
      } else {
        document.getElementById('timingWindow').textContent = '(waiting for utterance)';
      }

      const recentWords = state.word_delay_points.slice(-20).reverse().map((point) =>
        `<tr><td>${point.word_text} <span class="small">(${point.source})</span></td><td>${fmtMs(point.delay_ms)}</td><td>${fmtTs(point.expected_ts_ms)}</td><td>${fmtTs(point.ts_ms)}</td></tr>`
      );
      fillRows('wordTable', recentWords, 4);

      const recentUtterances = state.completed_utterances.slice().reverse().map((item) =>
        `<tr><td>${item.dataset_row_idx}</td><td>${fmtMs(item.average_logcat_true_delay_ms)}</td></tr>`
      );
      fillRows('utteranceTable', recentUtterances, 2);

      renderChart(state.logcat_true_word_delay_points);
    }
    refresh().catch(console.error);
    setInterval(() => refresh().catch(console.error), 1000);
  </script>
</body>
</html>
"""


class MonitorHandler(BaseHTTPRequestHandler):
    monitor_state: MonitorState | None = None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            body = HTML_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/state":
            assert self.monitor_state is not None
            body = json.dumps(self.monitor_state.snapshot()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    state = MonitorState(output_dir=output_dir, max_history=args.max_history, dataset=args.dataset, split=args.split)
    cached_rows = load_cached_rows(output_dir)
    cursor = DatasetCursor(dataset=args.dataset, config=args.config, split=args.split, page_size=args.page_size, cached_rows=cached_rows)
    worker = MonitorWorker(args=args, state=state, cursor=cursor)

    adb_prefix = ["adb"]
    if args.device:
        adb_prefix.extend(["-s", args.device])

    subprocess.run(adb_prefix + ["forward", "tcp:7001", "tcp:7001"], check=False)
    MonitorHandler.monitor_state = state
    server = ThreadingHTTPServer(("127.0.0.1", args.port), MonitorHandler)
    server.daemon_threads = True

    worker_thread = threading.Thread(target=worker.monitor_loop, daemon=True)
    prefetch_thread = threading.Thread(target=worker.prefetch_loop, daemon=True)
    rn_stream_thread = threading.Thread(target=worker.rn_stream_loop, daemon=True)
    logcat_thread = threading.Thread(target=worker.logcat_stream_loop, daemon=True)
    prefetch_thread.start()
    rn_stream_thread.start()
    logcat_thread.start()
    worker_thread.start()

    print(f"Dashboard: http://127.0.0.1:{args.port}")
    print(f"Output dir: {output_dir}")
    print(f"Dataset: {args.dataset} ({args.split})")
    print("Press Ctrl-C to stop.")

    def handle_signal(_signum: int, _frame: Any) -> None:
        worker.stop_event.set()
        server.shutdown()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        worker.stop_event.set()
        worker_thread.join(timeout=5)
        prefetch_thread.join(timeout=5)
        rn_stream_thread.join(timeout=5)
        logcat_thread.join(timeout=5)
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())

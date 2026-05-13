#!/usr/bin/env python3
import argparse
import collections
import json
import mimetypes
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
import tomllib


DEFAULT_INCIDENT_CONFIG = {
    "drop_event": {
        "name": "Dropped Captions",
        "enabled": True,
        "incident_threshold_ms": 5000,
        "alert_threshold_ms": 15000,
    },
    "audio_output_device_mismatch": {
        "name": "Audio Output Device Mismatch",
        "enabled": True,
        "incident_threshold_ms": 0,
        "alert_threshold_ms": 15000,
    },
    "app_not_foreground": {
        "name": "MentraOS Not Foreground",
        "enabled": True,
        "incident_threshold_ms": 0,
        "alert_threshold_ms": 15000,
    },
    "high_average_latency": {
        "name": "High Average Latency",
        "enabled": True,
        "incident_threshold_ms": 10000,
        "alert_threshold_ms": 15000,
        "window_size": 10,
        "resolve_threshold_ms": 10000,
    },
}
CAPTIONS_TESTER_INCIDENT_RESULT_MARKER = "CAPTIONS_TESTER_INCIDENT_RESULT "
CONSOLE_INCIDENT_BASE_URL = "https://console.mentra.glass/admin/incidents/"
CAPTIONS_TESTER_FILED_RE = re.compile(r"CaptionsTesterBugReport\]\s+Incident filed:\s*([0-9a-fA-F-]+)")
UI_DIST_DIR = Path(__file__).resolve().parent.parent / "ui" / "dist"
DEFAULT_UI_DEV_ORIGIN = "http://127.0.0.1:5173"
SNAPSHOT_WORD_HISTORY_MULTIPLIER = 8


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
    parser.add_argument(
        "--incident-config-path",
        default=str(Path(__file__).resolve().parent.parent / "incident_config.toml"),
        help="Path to the TOML config file that defines incident thresholds and alert thresholds.",
    )
    parser.add_argument(
        "--audio-output-device",
        default=None,
        help="Require this macOS output device for local playback. If SwitchAudioSource is installed, the monitor will switch to it automatically.",
    )
    parser.add_argument(
        "--alert-intent-action",
        default="com.mentra.CAPTIONS_TESTER_INCIDENT",
        help="Android broadcast action to fire when an alert is raised.",
    )
    parser.add_argument(
        "--alert-intent-component",
        default="com.mentra.mentra/com.mentra.crust.receivers.CaptionsTesterIncidentReceiver",
        help="Optional explicit Android broadcast component for alert dispatch.",
    )
    parser.add_argument(
        "--disable-alert-intent-dispatch",
        action="store_true",
        help="Disable Android alert-intent dispatch even when alerts are raised.",
    )
    parser.add_argument("--poll-interval", type=float, default=0.25, help="Hierarchy poll interval in seconds")
    parser.add_argument("--word-match-early-tolerance-ms", type=int, default=250, help="Allow a visible word match slightly before the expected word timestamp")
    parser.add_argument("--post-roll-ms", type=int, default=1200, help="Extra time after the last aligned word before closing an utterance")
    parser.add_argument("--inter-utterance-gap-ms", type=int, default=350, help="Gap between utterances in continuous playback")
    parser.add_argument("--max-history", type=int, default=500, help="How many completed utterances and drop events to keep in memory")
    parser.add_argument(
        "--ui-dev",
        action="store_true",
        help="Proxy UI requests to a Vite dev server instead of serving ui/dist. Useful for hot reloading frontend edits.",
    )
    parser.add_argument(
        "--ui-dev-origin",
        default=DEFAULT_UI_DEV_ORIGIN,
        help="Origin for the Vite dev server used by --ui-dev (default: http://127.0.0.1:5173).",
    )
    parser.add_argument(
        "--read-only",
        action="store_true",
        help="Serve the dashboard from archived monitor output only. No adb, playback, or live collectors are started.",
    )
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


def trimmed_mean_ms(values: list[int | float], trim_fraction: float = 0.10) -> float | None:
    if not values:
        return None

    sorted_values = sorted(float(value) for value in values)
    trim_count = int(len(sorted_values) * trim_fraction)
    if trim_count * 2 >= len(sorted_values):
        trim_count = max(0, (len(sorted_values) - 1) // 2)

    trimmed_values = sorted_values[trim_count : len(sorted_values) - trim_count] if trim_count else sorted_values
    if not trimmed_values:
        trimmed_values = sorted_values
    return sum(trimmed_values) / len(trimmed_values)


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


@dataclass
class UtteranceState:
    dataset_row_idx: int
    text: str
    audio_url: str
    start_ts_ms: int
    end_ts_ms: int
    words: list[WordState]
    rn_matched_word_count: int = 0
    rn_last_matched_index: int = -1
    rn_true_last_matched_index: int = -1
    logcat_true_last_matched_index: int = -1
    first_visible_activity_ts_ms: int | None = None
    last_visible_change_ts_ms: int | None = None
    last_signature: str = ""
    drop_open: dict[str, Any] | None = None
    active_drop_incident_id: str | None = None


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


def load_incident_config(path: Path) -> dict[str, dict[str, Any]]:
    config = {key: dict(value) for key, value in DEFAULT_INCIDENT_CONFIG.items()}
    if path.exists():
        with path.open("rb") as handle:
            payload = tomllib.load(handle)
        incidents = payload.get("incidents") or {}
        for incident_type, incident_payload in incidents.items():
            if incident_type not in config:
                config[incident_type] = {}
            config[incident_type].update(incident_payload)

    for incident_type, incident_config in config.items():
        incident_config.setdefault("name", incident_type.replace("_", " ").title())
        incident_config.setdefault("enabled", True)
        incident_config.setdefault("incident_threshold_ms", 0)
        incident_config.setdefault("alert_threshold_ms", 0)
        if incident_type == "high_average_latency":
            incident_config.setdefault("window_size", 10)
            incident_config.setdefault("resolve_threshold_ms", incident_config["incident_threshold_ms"])
    return config


def load_incident_history(
    output_dir: Path,
    max_history: int,
    *,
    include_ongoing: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]]]:
    incidents_path = output_dir / "incidents.ndjson"
    alerts_path = output_dir / "alerts.ndjson"

    completed_incidents: list[dict[str, Any]] = []
    ongoing_incidents: dict[str, dict[str, Any]] = {}
    alerts: list[dict[str, Any]] = []

    if incidents_path.exists():
        for line in incidents_path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            incident_id = payload.get("incident_id")
            event = payload.get("event")
            if not incident_id or not event:
                continue
            if event == "incident_started":
                ongoing_incidents[incident_id] = {
                    **payload,
                    "status": "ongoing",
                    "alerted_at_ms": payload.get("alerted_at_ms"),
                }
            elif event == "incident_ended":
                started = ongoing_incidents.pop(incident_id, None)
                if started is not None:
                    completed_incidents.append({**started, **payload, "status": "ended"})
                else:
                    completed_incidents.append({**payload, "status": "ended"})

    if alerts_path.exists():
        alert_by_id: dict[str, dict[str, Any]] = {}
        for line in alerts_path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                alert = json.loads(line)
            except json.JSONDecodeError:
                continue
            alert_id = alert.get("alert_id")
            if alert_id:
                alert_by_id[alert_id] = alert
            else:
                alerts.append(alert)
        alerts.extend(alert_by_id.values())

    alert_by_incident_id = {alert.get("incident_id"): alert for alert in alerts if alert.get("incident_id")}
    if include_ongoing:
        for incident_id, incident in ongoing_incidents.items():
            alert = alert_by_incident_id.get(incident_id)
            if alert is not None:
                incident["alerted_at_ms"] = alert.get("alerted_at_ms")
    for incident in completed_incidents:
        alert = alert_by_incident_id.get(incident.get("incident_id"))
        if alert is not None:
            incident["alerted_at_ms"] = alert.get("alerted_at_ms")

    if not include_ongoing:
        ongoing_incidents = {}

    return (
        trim_history(completed_incidents, max_history),
        ongoing_incidents,
        trim_history(alerts, max_history),
    )


def load_monitor_history(
    output_dir: Path,
    max_history: int,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    events_path = output_dir / "monitor_events.ndjson"
    if not events_path.exists():
        return [], [], [], [], [], [], []

    completed_utterances: list[dict[str, Any]] = []
    word_delay_points: list[dict[str, Any]] = []
    rn_word_delay_points: list[dict[str, Any]] = []
    rn_true_word_delay_points: list[dict[str, Any]] = []
    logcat_true_word_delay_points: list[dict[str, Any]] = []
    drop_events: list[dict[str, Any]] = []
    last_events: list[dict[str, Any]] = []
    word_history_limit = max_history * 40

    for line in events_path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue

        kind = payload.get("kind")
        last_events.append(payload)
        if kind == "utterance_completed":
            completed_utterances.append(payload)
        elif kind == "drop_event":
            drop_events.append(payload)
        elif kind == "word_match":
            word_delay_points.append(payload)
            source = payload.get("source")
            if source == "rn":
                rn_word_delay_points.append(payload)
            elif source == "rn_true":
                rn_true_word_delay_points.append(payload)
            elif source == "logcat_true":
                logcat_true_word_delay_points.append(payload)

    return (
        trim_history(completed_utterances, max_history),
        trim_history(word_delay_points, word_history_limit),
        trim_history(rn_word_delay_points, word_history_limit),
        trim_history(rn_true_word_delay_points, word_history_limit),
        trim_history(logcat_true_word_delay_points, word_history_limit),
        trim_history(drop_events, max_history),
        trim_history(last_events, 100),
    )


class MonitorState:
    def __init__(self, output_dir: Path, max_history: int, dataset: str, split: str, incident_config: dict[str, dict[str, Any]]) -> None:
        self.output_dir = output_dir
        self.max_history = max_history
        self.lock = threading.Lock()
        self.started_at_ms = int(time.time() * 1000)
        self.dataset = dataset
        self.split = split
        self.incident_config = incident_config
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
        (
            self.completed_utterances,
            self.word_delay_points,
            self.rn_word_delay_points,
            self.rn_true_word_delay_points,
            self.logcat_true_word_delay_points,
            self.drop_events,
            self.last_events,
        ) = load_monitor_history(output_dir, max_history)
        self.drop_last_signature = ""
        self.drop_last_change_ts_ms: int | None = None
        self.drop_open: dict[str, Any] | None = None
        self.active_drop_incident_id: str | None = None
        # Treat each monitor process as a fresh incident session. Historical
        # incidents remain visible once ended, but previously open incidents do
        # not carry over into a new server run.
        self.completed_incidents, self.ongoing_incidents, self.alerts = load_incident_history(
            output_dir,
            max_history,
            include_ongoing=False,
        )

    def append_event(self, kind: str, payload: dict[str, Any]) -> None:
        event = {"kind": kind, **payload}
        self.last_events.append(event)
        self.last_events = trim_history(self.last_events, 100)
        write_ndjson(self.output_dir / "monitor_events.ndjson", event)

    def snapshot_word_history_limit(self) -> int:
        # Keep enough points to preserve the recent graph shape without sending
        # multi-megabyte /state responses to the browser on every poll.
        return max(200, self.max_history * SNAPSHOT_WORD_HISTORY_MULTIPLIER)

    def build_incident_id(self, incident_type: str, started_at_ms: int, dataset_row_idx: int | None = None) -> str:
        suffix = f":row{dataset_row_idx}" if dataset_row_idx is not None else ""
        return f"{incident_type}:{started_at_ms}{suffix}"

    def get_incident_rule(self, incident_type: str) -> dict[str, Any]:
        return self.incident_config.get(incident_type, {"name": incident_type, "enabled": False, "incident_threshold_ms": 0, "alert_threshold_ms": 0})

    def find_ongoing_incident_by_type(self, incident_type: str) -> dict[str, Any] | None:
        for incident in self.ongoing_incidents.values():
            if incident.get("incident_type") == incident_type:
                return incident
        return None

    def start_incident(
        self,
        incident_type: str,
        started_at_ms: int,
        details: dict[str, Any],
    ) -> str | None:
        incident_rule = self.get_incident_rule(incident_type)
        if not incident_rule.get("enabled", True):
            return None

        incident_id = self.build_incident_id(incident_type, started_at_ms, details.get("dataset_row_idx"))
        if incident_id in self.ongoing_incidents:
            return incident_id

        incident = {
            "incident_id": incident_id,
            "incident_type": incident_type,
            "incident_name": incident_rule.get("name", incident_type),
            "event": "incident_started",
            "status": "ongoing",
            "started_at_ms": started_at_ms,
            "incident_threshold_ms": int(incident_rule.get("incident_threshold_ms", 0)),
            "alert_threshold_ms": int(incident_rule.get("alert_threshold_ms", 0)),
            "alerted_at_ms": None,
            **details,
        }
        self.ongoing_incidents[incident_id] = incident
        write_ndjson(self.output_dir / "incidents.ndjson", incident)
        self.append_event("incident_started", incident)
        return incident_id

    def maybe_alert_incident(self, incident_id: str, now_ms: int) -> dict[str, Any] | None:
        incident = self.ongoing_incidents.get(incident_id)
        if incident is None or incident.get("alerted_at_ms") is not None:
            return None

        started_at_ms = int(incident["started_at_ms"])
        alert_threshold_ms = int(incident["alert_threshold_ms"])
        if now_ms - started_at_ms < alert_threshold_ms:
            return None

        alert = {
            "alert_id": f"alert:{incident_id}",
            "incident_id": incident_id,
            "incident_type": incident["incident_type"],
            "incident_name": incident.get("incident_name", incident["incident_type"]),
            "status": "pending_dispatch",
            "started_at_ms": started_at_ms,
            "alerted_at_ms": now_ms,
            "duration_ms": now_ms - started_at_ms,
            "alert_threshold_ms": alert_threshold_ms,
            "dataset_row_idx": incident.get("dataset_row_idx"),
            "utterance_text": incident.get("utterance_text"),
            "reason": incident.get("reason"),
        }
        incident["alerted_at_ms"] = now_ms
        self.alerts.append(alert)
        self.alerts = trim_history(self.alerts, self.max_history)
        write_ndjson(self.output_dir / "alerts.ndjson", alert)
        self.append_event("incident_alerted", alert)
        return alert

    def update_alert(self, alert_id: str, **updates: Any) -> dict[str, Any] | None:
        with self.lock:
            for alert in self.alerts:
                if alert.get("alert_id") != alert_id:
                    continue
                alert.update(updates)
                write_ndjson(self.output_dir / "alerts.ndjson", alert)
                self.append_event("alert_updated", {"alert_id": alert_id, **updates})
                return alert
        return None

    def end_incident(self, incident_id: str, ended_at_ms: int, details: dict[str, Any] | None = None) -> dict[str, Any] | None:
        incident = self.ongoing_incidents.pop(incident_id, None)
        if incident is None:
            return None

        ended = {
            **incident,
            "event": "incident_ended",
            "status": "ended",
            "ended_at_ms": ended_at_ms,
            "duration_ms": ended_at_ms - int(incident["started_at_ms"]),
            **(details or {}),
        }
        self.completed_incidents.append(ended)
        self.completed_incidents = trim_history(self.completed_incidents, self.max_history)
        write_ndjson(self.output_dir / "incidents.ndjson", ended)
        self.append_event("incident_ended", ended)
        return ended

    def append_drop_event(self, drop: dict[str, Any]) -> None:
        self.drop_events.append(drop)
        self.drop_events = trim_history(self.drop_events, self.max_history)
        self.append_event("drop_event", drop)

    def serialize_utterance(self, utterance: UtteranceState | None) -> dict[str, Any] | None:
        if utterance is None:
            return None
        return {
            "dataset_row_idx": utterance.dataset_row_idx,
            "text": utterance.text,
            "start_ts_ms": utterance.start_ts_ms,
            "end_ts_ms": utterance.end_ts_ms,
            "rn_matched_word_count": utterance.rn_matched_word_count,
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
                }
                for word in utterance.words
            ],
        }

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            now_ms = int(time.time() * 1000)
            snapshot_word_history_limit = self.snapshot_word_history_limit()
            ongoing_incidents = []
            for incident in self.ongoing_incidents.values():
                started_at_ms = int(incident["started_at_ms"])
                alerted_at_ms = incident.get("alerted_at_ms")
                ongoing_incidents.append(
                    {
                        **incident,
                        "current_duration_ms": now_ms - started_at_ms,
                        "time_to_alert_ms": None if alerted_at_ms else max(0, int(incident["alert_threshold_ms"]) - (now_ms - started_at_ms)),
                    }
                )
            ongoing_incidents.sort(key=lambda item: item["started_at_ms"])
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
                "word_delay_points": trim_history(list(self.word_delay_points), snapshot_word_history_limit),
                "rn_word_delay_points": trim_history(list(self.rn_word_delay_points), snapshot_word_history_limit),
                "rn_true_word_delay_points": trim_history(list(self.rn_true_word_delay_points), snapshot_word_history_limit),
                "logcat_true_word_delay_points": trim_history(
                    list(self.logcat_true_word_delay_points),
                    snapshot_word_history_limit,
                ),
                "drop_events": list(self.drop_events),
                "ongoing_incidents": ongoing_incidents,
                "completed_incidents": list(self.completed_incidents),
                "alerts": list(self.alerts),
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


def get_default_output_device_name() -> str | None:
    result = subprocess.run(
        ["system_profiler", "SPAudioDataType"],
        check=True,
        capture_output=True,
        text=True,
    )
    lines = result.stdout.splitlines()
    for index, raw_line in enumerate(lines):
        line = raw_line.rstrip()
        if "Default Output Device: Yes" not in line:
            continue

        for candidate in range(index - 1, -1, -1):
            header = lines[candidate].rstrip()
            stripped = header.strip()
            if not stripped or stripped == "Devices:" or stripped == "Audio:" or ":" not in stripped:
                continue
            if header.startswith("        ") and not header.startswith("          "):
                return stripped[:-1]
    return None


def ensure_audio_output_device(device_name: str) -> None:
    current_device = get_default_output_device_name()
    if current_device == device_name:
        return

    switch_audio_source = shutil.which("SwitchAudioSource")
    if switch_audio_source:
        subprocess.run(
            [switch_audio_source, "-t", "output", "-s", device_name],
            check=True,
            capture_output=True,
            text=True,
        )
        current_device = get_default_output_device_name()
        if current_device == device_name:
            return

    current_label = current_device or "unknown"
    raise RuntimeError(
        f"Expected audio output device '{device_name}', but macOS default output is '{current_label}'. "
        "Switch to the expected device manually or install SwitchAudioSource to allow auto-switching."
    )


def play_audio_locally(audio_file: Path, audio_output_device: str | None = None) -> subprocess.Popen[bytes]:
    if audio_output_device:
        ensure_audio_output_device(audio_output_device)
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
        self.last_audio_output_check_ts_ms = 0
        self.last_audio_output_device_name: str | None = None
        self.last_audio_output_check_error: str | None = None
        self.last_foreground_app_check_ts_ms = 0
        self.last_is_app_foreground: bool | None = None
        self.last_foreground_app_check_error: str | None = None
        self.last_foreground_focus: str | None = None

    @property
    def adb_prefix(self) -> list[str]:
        prefix = ["adb"]
        if self.args.device:
            prefix.extend(["-s", self.args.device])
        return prefix

    def _stop_subprocess(self, process: subprocess.Popen[Any] | None) -> None:
        if process is None or process.poll() is not None:
            return

        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

    def request_stop(self) -> None:
        self.stop_event.set()
        self._stop_subprocess(self.playback_process)
        self._stop_subprocess(self.rn_stream_process)
        self._stop_subprocess(self.logcat_process)

    def maybe_alert_and_dispatch(self, incident_id: str, now_ms: int) -> dict[str, Any] | None:
        alert = self.state.maybe_alert_incident(incident_id, now_ms)
        if alert is not None:
            threading.Thread(target=self.dispatch_alert_intent, args=(dict(alert), now_ms), daemon=True).start()
        return alert

    def dispatch_alert_intent(self, alert: dict[str, Any], now_ms: int) -> dict[str, Any] | None:
        alert_id = str(alert.get("alert_id") or "")
        if not alert_id:
            return None

        if self.args.disable_alert_intent_dispatch:
            return self.state.update_alert(
                alert_id,
                status="dispatch_disabled",
                dispatch_attempted_at_ms=now_ms,
            )

        action = (self.args.alert_intent_action or "").strip()
        if not action:
            return self.state.update_alert(
                alert_id,
                status="dispatch_disabled",
                dispatch_attempted_at_ms=now_ms,
                dispatch_error="No alert intent action configured.",
            )

        failure_message = (
            f"{alert.get('incident_name', alert.get('incident_type', 'incident'))} alert reached after "
            f"{int(alert.get('duration_ms') or 0) / 1000:.1f}s."
        )
        remote_cmd = [
            "am",
            "broadcast",
            "-a",
            action,
        ]
        component = (self.args.alert_intent_component or "").strip()
        if component:
            remote_cmd.extend(["-n", component])
        remote_cmd.extend(
            [
                "--es",
                "failure_code",
                str(alert.get("incident_type") or "unknown_incident"),
                "--es",
                "failure_message",
                failure_message,
                "--es",
                "test_run_id",
                alert_id,
                "--es",
                "scenario_name",
                str(alert.get("incident_name") or alert.get("incident_type") or "Unknown Incident"),
                "--es",
                "source",
                "live_word_monitor",
                "--es",
                "alert_id",
                alert_id,
                "--es",
                "incident_id",
                str(alert.get("incident_id") or ""),
                "--es",
                "incident_type",
                str(alert.get("incident_type") or ""),
                "--es",
                "incident_name",
                str(alert.get("incident_name") or ""),
                "--es",
                "reason",
                str(alert.get("reason") or ""),
                "--ei",
                "duration_ms",
                str(int(alert.get("duration_ms") or 0)),
                "--ei",
                "alert_threshold_ms",
                str(int(alert.get("alert_threshold_ms") or 0)),
                "--el",
                "started_at_ms",
                str(int(alert.get("started_at_ms") or 0)),
                "--el",
                "alerted_at_ms",
                str(int(alert.get("alerted_at_ms") or now_ms)),
            ]
        )
        if alert.get("dataset_row_idx") is not None:
            remote_cmd.extend(["--ei", "dataset_row_idx", str(int(alert["dataset_row_idx"]))])
        if alert.get("utterance_text"):
            remote_cmd.extend(["--es", "utterance_text", str(alert["utterance_text"])])

        adb_cmd = self.adb_prefix + ["shell", " ".join(shlex.quote(part) for part in remote_cmd)]

        try:
            result = subprocess.run(adb_cmd, check=True, capture_output=True, text=True, timeout=15)
            return self.state.update_alert(
                alert_id,
                status="dispatched",
                dispatch_attempted_at_ms=now_ms,
                dispatch_completed_at_ms=int(time.time() * 1000),
                dispatch_output=(result.stdout or result.stderr).strip() or "broadcast_sent",
            )
        except Exception as exc:
            return self.state.update_alert(
                alert_id,
                status="dispatch_failed",
                dispatch_attempted_at_ms=now_ms,
                dispatch_error=str(exc),
            )

    def handle_captions_tester_incident_result(self, payload: dict[str, Any], now_ms: int) -> dict[str, Any] | None:
        alert_id = str(payload.get("alert_id") or payload.get("test_run_id") or "").strip()
        if not alert_id:
            return None

        result_status = str(payload.get("status") or "").strip()
        updates: dict[str, Any] = {
            "report_state": result_status or "unknown",
            "report_updated_at_ms": now_ms,
        }
        incident_id = str(payload.get("incident_id") or "").strip()
        if incident_id:
            updates["reported_incident_id"] = incident_id
            updates["reported_incident_url"] = urllib.parse.urljoin(CONSOLE_INCIDENT_BASE_URL, incident_id)

        reason = str(payload.get("reason") or "").strip()
        error = str(payload.get("error") or "").strip()
        if reason:
            updates["report_reason"] = reason
        if error:
            updates["report_error"] = error
        return self.state.update_alert(alert_id, **updates)

    def find_latest_unreported_alert_id(self) -> str | None:
        with self.state.lock:
            ordered_alerts = sorted(self.state.alerts, key=lambda item: int(item.get("alerted_at_ms") or 0), reverse=True)
            for alert in ordered_alerts:
                alert_id = str(alert.get("alert_id") or "").strip()
                if not alert_id or alert.get("reported_incident_id"):
                    continue
                return alert_id
        return None

    def handle_legacy_captions_tester_filed_log(self, line: str, now_ms: int) -> dict[str, Any] | None:
        match = CAPTIONS_TESTER_FILED_RE.search(line)
        if not match:
            return None
        alert_id = self.find_latest_unreported_alert_id()
        if not alert_id:
            return None
        incident_id = match.group(1)
        return self.state.update_alert(
            alert_id,
            report_state="filed",
            report_updated_at_ms=now_ms,
            reported_incident_id=incident_id,
            reported_incident_url=urllib.parse.urljoin(CONSOLE_INCIDENT_BASE_URL, incident_id),
        )

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
        self.playback_process = play_audio_locally(prepared_row.audio_file, self.args.audio_output_device)
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

    def end_active_drop_incident(self, now_ms: int, reason: str, details: dict[str, Any] | None = None) -> dict[str, Any] | None:
        incident_id = self.state.active_drop_incident_id
        if incident_id is None:
            return None

        ended_incident = self.state.end_incident(
            incident_id,
            now_ms,
            {
                "reason": reason,
                **(details or {}),
            },
        )
        self.state.active_drop_incident_id = None
        self.state.drop_open = None
        if ended_incident is not None:
            self.state.append_drop_event(
                {
                    "incident_id": ended_incident["incident_id"],
                    "dataset_row_idx": ended_incident.get("dataset_row_idx"),
                    "started_at_ms": ended_incident["started_at_ms"],
                    "ended_at_ms": ended_incident["ended_at_ms"],
                    "duration_ms": ended_incident["duration_ms"],
                }
            )
        return ended_incident

    def finalize_utterance(self, utterance: UtteranceState, now_ms: int) -> None:
        rn_delays = [word.rn_visible_delay_ms for word in utterance.words if word.rn_visible_delay_ms is not None]
        rn_true_delays = [word.rn_true_visible_delay_ms for word in utterance.words if word.rn_true_visible_delay_ms is not None]
        logcat_true_delays = [word.logcat_true_visible_delay_ms for word in utterance.words if word.logcat_true_visible_delay_ms is not None]
        average_rn_delay_ms = trimmed_mean_ms(rn_delays)
        average_rn_true_delay_ms = trimmed_mean_ms(rn_true_delays)
        average_logcat_true_delay_ms = trimmed_mean_ms(logcat_true_delays)
        summary = {
            "dataset_row_idx": utterance.dataset_row_idx,
            "text": utterance.text,
            "start_ts_ms": utterance.start_ts_ms,
            "end_ts_ms": utterance.end_ts_ms,
            "rn_matched_words": utterance.rn_matched_word_count,
            "word_count": len(utterance.words),
            "average_rn_delay_ms": int(round(average_rn_delay_ms)) if average_rn_delay_ms is not None else None,
            "average_rn_true_delay_ms": int(round(average_rn_true_delay_ms)) if average_rn_true_delay_ms is not None else None,
            "average_logcat_true_delay_ms": int(round(average_logcat_true_delay_ms)) if average_logcat_true_delay_ms is not None else None,
            "max_rn_delay_ms": max(rn_delays) if rn_delays else None,
            "max_rn_true_delay_ms": max(rn_true_delays) if rn_true_delays else None,
            "max_logcat_true_delay_ms": max(logcat_true_delays) if logcat_true_delays else None,
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

    def update_drop_tracking(self, utterance: UtteranceState | None, now_ms: int, normalized_lines: list[str]) -> None:
        drop_rule = self.state.get_incident_rule("drop_event")
        drop_threshold_ms = int(drop_rule.get("incident_threshold_ms", 0))
        if not drop_rule.get("enabled", True):
            self.end_active_drop_incident(now_ms, "incident_disabled")
            return

        signature = "|".join(normalized_lines)
        if self.state.drop_last_change_ts_ms is None:
            self.state.drop_last_signature = signature
            self.state.drop_last_change_ts_ms = now_ms
            return

        if signature != self.state.drop_last_signature:
            self.state.drop_last_signature = signature
            self.state.drop_last_change_ts_ms = now_ms
            if self.state.active_drop_incident_id is not None:
                self.end_active_drop_incident(
                    now_ms,
                    "visible_lines_resumed",
                    {
                        "dataset_row_idx": utterance.dataset_row_idx if utterance is not None else None,
                        "utterance_text": utterance.text if utterance is not None else None,
                    },
                )
            else:
                self.state.drop_open = None
            return

        if self.state.drop_last_change_ts_ms is None:
            return

        if self.state.active_drop_incident_id is not None:
            self.maybe_alert_and_dispatch(self.state.active_drop_incident_id, now_ms)
            return

        if now_ms - self.state.drop_last_change_ts_ms < drop_threshold_ms:
            return

        if self.state.drop_open is None:
            self.state.drop_open = {
                "dataset_row_idx": utterance.dataset_row_idx if utterance is not None else None,
                "started_at_ms": self.state.drop_last_change_ts_ms,
            }

        incident_id = self.state.start_incident(
            "drop_event",
            int(self.state.drop_open["started_at_ms"]),
            {
                "dataset_row_idx": utterance.dataset_row_idx if utterance is not None else None,
                "utterance_text": utterance.text if utterance is not None else None,
                "reason": "visible_lines_stalled",
            },
        )

        if incident_id is not None:
            self.state.active_drop_incident_id = incident_id
            self.maybe_alert_and_dispatch(incident_id, now_ms)

    def evaluate_high_average_latency_incident(self, now_ms: int) -> None:
        incident_rule = self.state.get_incident_rule("high_average_latency")
        ongoing_incident = self.state.find_ongoing_incident_by_type("high_average_latency")

        if not incident_rule.get("enabled", True):
            if ongoing_incident is not None:
                self.state.end_incident(ongoing_incident["incident_id"], now_ms, {"reason": "incident_disabled"})
            return

        window_size = max(1, int(incident_rule.get("window_size", 10)))
        points = self.state.logcat_true_word_delay_points[-window_size:]
        if len(points) < window_size:
            return

        trimmed_average_delay = trimmed_mean_ms([int(point["delay_ms"]) for point in points])
        if trimmed_average_delay is None:
            return
        average_delay_ms = int(round(trimmed_average_delay))
        threshold_ms = int(incident_rule.get("incident_threshold_ms", 0))
        resolve_threshold_ms = int(incident_rule.get("resolve_threshold_ms", threshold_ms))

        if ongoing_incident is not None:
            ongoing_incident.update(
                {
                    "current_average_delay_ms": average_delay_ms,
                    "current_trimmed_average_delay_ms": average_delay_ms,
                    "window_size": window_size,
                    "last_point_ts_ms": points[-1]["ts_ms"],
                }
            )

        if average_delay_ms >= threshold_ms:
            incident_id = ongoing_incident["incident_id"] if ongoing_incident is not None else self.state.start_incident(
                "high_average_latency",
                now_ms,
                {
                    "current_average_delay_ms": average_delay_ms,
                    "current_trimmed_average_delay_ms": average_delay_ms,
                    "window_size": window_size,
                    "last_point_ts_ms": points[-1]["ts_ms"],
                    "reason": "trimmed_moving_average_above_threshold",
                },
            )
            if incident_id is not None:
                active_incident = self.state.ongoing_incidents.get(incident_id)
                if active_incident is not None:
                    active_incident.update(
                        {
                            "current_average_delay_ms": average_delay_ms,
                            "current_trimmed_average_delay_ms": average_delay_ms,
                            "window_size": window_size,
                            "last_point_ts_ms": points[-1]["ts_ms"],
                        }
                    )
                self.maybe_alert_and_dispatch(incident_id, now_ms)
            return

        if ongoing_incident is not None and average_delay_ms < resolve_threshold_ms:
            self.state.end_incident(
                ongoing_incident["incident_id"],
                now_ms,
                {
                    "reason": "moving_average_recovered",
                    "recovered_average_delay_ms": average_delay_ms,
                },
            )

    def get_audio_output_probe(self, now_ms: int, refresh_interval_ms: int = 2000) -> tuple[str | None, str | None]:
        if self.last_audio_output_check_ts_ms and now_ms - self.last_audio_output_check_ts_ms < refresh_interval_ms:
            return self.last_audio_output_device_name, self.last_audio_output_check_error

        try:
            self.last_audio_output_device_name = get_default_output_device_name()
            self.last_audio_output_check_error = None
        except Exception as exc:
            self.last_audio_output_device_name = None
            self.last_audio_output_check_error = str(exc)

        self.last_audio_output_check_ts_ms = now_ms
        return self.last_audio_output_device_name, self.last_audio_output_check_error

    def evaluate_audio_output_device_incident(self, now_ms: int) -> None:
        incident_type = "audio_output_device_mismatch"
        incident_rule = self.state.get_incident_rule(incident_type)
        ongoing_incident = self.state.find_ongoing_incident_by_type(incident_type)
        expected_output_device = self.args.audio_output_device

        if not incident_rule.get("enabled", True) or not expected_output_device:
            if ongoing_incident is not None:
                self.state.end_incident(
                    ongoing_incident["incident_id"],
                    now_ms,
                    {
                        "reason": "incident_disabled" if not incident_rule.get("enabled", True) else "output_device_monitoring_disabled",
                    },
                )
            return

        current_output_device, probe_error = self.get_audio_output_probe(now_ms)
        details = {
            "expected_output_device": expected_output_device,
            "current_output_device": current_output_device,
        }

        if probe_error is not None:
            incident_id = ongoing_incident["incident_id"] if ongoing_incident is not None else self.state.start_incident(
                incident_type,
                now_ms,
                {
                    **details,
                    "reason": "output_device_probe_failed",
                    "probe_error": probe_error,
                },
            )
            if incident_id is not None:
                active_incident = self.state.ongoing_incidents.get(incident_id)
                if active_incident is not None:
                    active_incident.update(
                        {
                            **details,
                            "reason": "output_device_probe_failed",
                            "probe_error": probe_error,
                        }
                    )
                self.maybe_alert_and_dispatch(incident_id, now_ms)
            return

        if current_output_device != expected_output_device:
            incident_id = ongoing_incident["incident_id"] if ongoing_incident is not None else self.state.start_incident(
                incident_type,
                now_ms,
                {
                    **details,
                    "reason": "default_output_mismatch",
                },
            )
            if incident_id is not None:
                active_incident = self.state.ongoing_incidents.get(incident_id)
                if active_incident is not None:
                    active_incident.update(
                        {
                            **details,
                            "reason": "default_output_mismatch",
                        }
                    )
                self.maybe_alert_and_dispatch(incident_id, now_ms)
            return

        if ongoing_incident is not None:
            self.state.end_incident(
                ongoing_incident["incident_id"],
                now_ms,
                {
                    **details,
                    "reason": "expected_output_device_restored",
                },
            )

    def get_foreground_app_probe(
        self,
        now_ms: int,
        refresh_interval_ms: int = 2000,
    ) -> tuple[bool | None, str | None, str | None]:
        if self.last_foreground_app_check_ts_ms and now_ms - self.last_foreground_app_check_ts_ms < refresh_interval_ms:
            return (
                self.last_is_app_foreground,
                self.last_foreground_focus,
                self.last_foreground_app_check_error,
            )

        focused_app: str | None = None
        probe_error: str | None = None
        is_app_foreground: bool | None = None
        try:
            focus_result = subprocess.run(
                [*self.adb_prefix, "shell", "dumpsys", "window"],
                check=True,
                capture_output=True,
                text=True,
            )
            for line in focus_result.stdout.splitlines():
                if "mCurrentFocus=" in line:
                    focused_app = line.strip()
                    break
            is_app_foreground = bool(
                focused_app
                and "com.mentra.mentra" in focused_app
                and "MainActivity" in focused_app
            )
        except Exception as exc:
            probe_error = str(exc)
            is_app_foreground = None

        self.last_foreground_app_check_ts_ms = now_ms
        self.last_is_app_foreground = is_app_foreground
        self.last_foreground_focus = focused_app
        self.last_foreground_app_check_error = probe_error
        return is_app_foreground, focused_app, probe_error

    def evaluate_app_not_foreground_incident(self, now_ms: int) -> None:
        incident_type = "app_not_foreground"
        incident_rule = self.state.get_incident_rule(incident_type)
        ongoing_incident = self.state.find_ongoing_incident_by_type(incident_type)

        if not incident_rule.get("enabled", True):
            if ongoing_incident is not None:
                self.state.end_incident(
                    ongoing_incident["incident_id"],
                    now_ms,
                    {
                        "reason": "incident_disabled",
                    },
                )
            return

        is_app_foreground, current_focus, probe_error = self.get_foreground_app_probe(now_ms)
        details = {
            "current_focus": current_focus,
            "expected_package": "com.mentra.mentra",
            "expected_activity": "MainActivity",
        }

        if probe_error is not None:
            incident_id = ongoing_incident["incident_id"] if ongoing_incident is not None else self.state.start_incident(
                incident_type,
                now_ms,
                {
                    **details,
                    "reason": "foreground_probe_failed",
                    "probe_error": probe_error,
                },
            )
            if incident_id is not None:
                active_incident = self.state.ongoing_incidents.get(incident_id)
                if active_incident is not None:
                    active_incident.update(
                        {
                            **details,
                            "reason": "foreground_probe_failed",
                            "probe_error": probe_error,
                        }
                    )
                self.maybe_alert_and_dispatch(incident_id, now_ms)
            return

        if not is_app_foreground:
            incident_id = ongoing_incident["incident_id"] if ongoing_incident is not None else self.state.start_incident(
                incident_type,
                now_ms,
                {
                    **details,
                    "reason": "mentraos_not_foreground",
                },
            )
            if incident_id is not None:
                active_incident = self.state.ongoing_incidents.get(incident_id)
                if active_incident is not None:
                    active_incident.update(
                        {
                            **details,
                            "reason": "mentraos_not_foreground",
                        }
                    )
                self.maybe_alert_and_dispatch(incident_id, now_ms)
            return

        if ongoing_incident is not None:
            self.state.end_incident(
                ongoing_incident["incident_id"],
                now_ms,
                {
                    **details,
                    "reason": "mentraos_foreground_restored",
                },
            )

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
                    self.state.drop_last_signature = "|".join(normalize_text(line) for line in visible_lines)
                    self.state.drop_last_change_ts_ms = now_ms
                    self.end_active_drop_incident(
                        now_ms,
                        "captions_resumed",
                        {
                            "dataset_row_idx": utterance.dataset_row_idx,
                            "utterance_text": utterance.text,
                        },
                    )
                else:
                    raise ValueError(f"Unsupported match source: {source}")
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
                else:
                    raise ValueError(f"Unsupported point source: {source}")
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
                    now_ms = int(time.time() * 1000)
                    if CAPTIONS_TESTER_INCIDENT_RESULT_MARKER in line:
                        payload_text = line.split(CAPTIONS_TESTER_INCIDENT_RESULT_MARKER, 1)[1].strip()
                        try:
                            payload = json.loads(payload_text)
                        except json.JSONDecodeError:
                            continue
                        self.handle_captions_tester_incident_result(payload, now_ms)
                        continue
                    if self.handle_legacy_captions_tester_filed_log(line, now_ms) is not None:
                        continue
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

                    now_ms = int(payload.get("ts_ms") or now_ms)
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
                    visible_lines = list(self.state.logcat_visible_lines)
                    normalized_lines = [normalize_text(line) for line in visible_lines]
                    self.state.mirror_visible = True
                    self.state.current_visible_lines = visible_lines

                    utterance = self.state.current_utterance
                    self.update_drop_tracking(utterance, now_ms, normalized_lines)
                    if utterance is None:
                        if now_ms >= self.next_start_ts_ms:
                            self.start_next_utterance(now_ms)
                        else:
                            self.state.status = "between_utterances"
                            self.state.status_detail = "waiting for next utterance"
                        self.evaluate_audio_output_device_incident(now_ms)
                        self.evaluate_app_not_foreground_incident(now_ms)
                    else:
                        self.evaluate_high_average_latency_incident(now_ms)
                        self.evaluate_audio_output_device_incident(now_ms)
                        self.evaluate_app_not_foreground_incident(now_ms)
                        if now_ms >= utterance.end_ts_ms:
                            self.finalize_utterance(utterance, now_ms)

                    for incident_id in list(self.state.ongoing_incidents):
                        self.maybe_alert_and_dispatch(incident_id, now_ms)
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


class MonitorHandler(BaseHTTPRequestHandler):
    monitor_state: MonitorState | None = None
    ui_dev_origin: str | None = None

    def _send_bytes(self, body: bytes, content_type: str, extra_headers: dict[str, str] | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for header, value in (extra_headers or {}).items():
            self.send_header(header, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Browsers polling /state can disconnect mid-response; treat that as a normal client abort.
            pass

    def _proxy_ui_dev_asset(self, request_path: str) -> bool:
        if not self.ui_dev_origin:
            return False

        normalized_path = request_path if request_path.startswith("/") else f"/{request_path}"
        upstream_url = urllib.parse.urljoin(f"{self.ui_dev_origin.rstrip('/')}/", normalized_path.lstrip("/"))
        request = urllib.request.Request(
            upstream_url,
            headers={
                "Accept": self.headers.get("Accept", "*/*"),
                "User-Agent": self.headers.get("User-Agent", "MentraMonitor/1.0"),
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                body = response.read()
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                cache_control = response.headers.get("Cache-Control")
                extra_headers = {"Cache-Control": cache_control} if cache_control else None
                self._send_bytes(body, content_type, extra_headers)
                return True
        except urllib.error.HTTPError as exc:
            body = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain; charset=utf-8"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return True
        except (urllib.error.URLError, TimeoutError):
            return False

    def _serve_ui_asset(self, request_path: str) -> bool:
        if not UI_DIST_DIR.exists():
            return False

        normalized_path = urllib.parse.unquote(request_path.split("?", 1)[0])
        relative_path = normalized_path.lstrip("/") or "index.html"
        candidate = (UI_DIST_DIR / relative_path).resolve()
        try:
            candidate.relative_to(UI_DIST_DIR.resolve())
        except ValueError:
            return False

        if candidate.is_dir():
            candidate = candidate / "index.html"

        if not candidate.exists() or not candidate.is_file():
            return False

        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self._send_bytes(candidate.read_bytes(), content_type)
        return True

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            if self._proxy_ui_dev_asset("/"):
                return
            if self._serve_ui_asset("/index.html"):
                return
            self.send_response(503)
            body = (
                b"UI build not found. Run `bun run build` in mobile/e2e-tests/ui, "
                b"or start Vite and use `--ui-dev`."
            )
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/state":
            assert self.monitor_state is not None
            body = json.dumps(self.monitor_state.snapshot()).encode("utf-8")
            self._send_bytes(body, "application/json; charset=utf-8", {"Cache-Control": "no-store"})
            return

        if self._proxy_ui_dev_asset(self.path):
            return

        if self._serve_ui_asset(self.path):
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    incident_config_path = Path(args.incident_config_path)
    incident_config = load_incident_config(incident_config_path)

    state = MonitorState(output_dir=output_dir, max_history=args.max_history, dataset=args.dataset, split=args.split, incident_config=incident_config)
    MonitorHandler.monitor_state = state
    MonitorHandler.ui_dev_origin = args.ui_dev_origin if args.ui_dev else None
    server = ThreadingHTTPServer(("127.0.0.1", args.port), MonitorHandler)
    server.daemon_threads = True

    worker: MonitorWorker | None = None
    worker_thread: threading.Thread | None = None
    prefetch_thread: threading.Thread | None = None
    rn_stream_thread: threading.Thread | None = None
    logcat_thread: threading.Thread | None = None

    if args.read_only:
        state.status = "archived"
        state.status_detail = "read-only dashboard from archived output"
    else:
        cached_rows = load_cached_rows(output_dir)
        cursor = DatasetCursor(dataset=args.dataset, config=args.config, split=args.split, page_size=args.page_size, cached_rows=cached_rows)
        worker = MonitorWorker(args=args, state=state, cursor=cursor)

        adb_prefix = ["adb"]
        if args.device:
            adb_prefix.extend(["-s", args.device])

        subprocess.run(adb_prefix + ["forward", "tcp:7001", "tcp:7001"], check=False)

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
    print(f"Incident config: {incident_config_path}")
    if args.read_only:
        print("Mode: read-only archive")
    else:
        print(f"Dataset: {args.dataset} ({args.split})")
    print("Press Ctrl-C to stop.")

    shutdown_started = threading.Event()

    def request_shutdown() -> None:
        if shutdown_started.is_set():
            return
        shutdown_started.set()
        if worker is not None:
            worker.request_stop()
        # `server.shutdown()` must run off the serve_forever thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    def handle_signal(_signum: int, _frame: Any) -> None:
        request_shutdown()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        if worker is not None:
            worker.request_stop()
        if worker_thread is not None:
            worker_thread.join(timeout=5)
        if prefetch_thread is not None:
            prefetch_thread.join(timeout=5)
        if rn_stream_thread is not None:
            rn_stream_thread.join(timeout=5)
        if logcat_thread is not None:
            logcat_thread.join(timeout=5)
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())

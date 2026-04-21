#!/usr/bin/env python3
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HTML_PAGE = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MentraOS Monitor Archive</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b1220; color: #e5eef9; }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .card { background: #121b2d; border: 1px solid #24314f; border-radius: 12px; padding: 14px; }
    .wide { grid-column: span 2; }
    h1, h2 { margin: 0 0 12px; font-weight: 700; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    h2 { font-size: 16px; }
    .label { color: #89a1c6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
    .small { font-size: 12px; color: #9eb3d1; }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; background: #203254; }
    .archived { background: #3b2d63; color: #ddd0ff; }
    .lines { white-space: pre-wrap; line-height: 1.5; }
    svg { width: 100%; height: 280px; background: #0f1728; border-radius: 10px; border: 1px solid #24314f; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 6px; text-align: left; border-bottom: 1px solid #24314f; vertical-align: top; }
    th { color: #89a1c6; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MentraOS Monitor Archive</h1>
    <div class="grid">
      <div class="card"><div class="label">Status</div><div id="status" class="value"></div><div id="statusDetail" class="small"></div></div>
      <div class="card"><div class="label">Cycles</div><div id="cycleCount" class="value"></div></div>
      <div class="card"><div class="label">Delay Points</div><div id="delayCount" class="value"></div></div>
      <div class="card"><div class="label">Drop Events &gt; 5s</div><div id="dropCount" class="value"></div></div>
    </div>
    <div class="grid">
      <div class="card wide">
        <h2>Delay Over Time</h2>
        <svg id="chart" viewBox="0 0 900 280" preserveAspectRatio="none"></svg>
      </div>
      <div class="card">
        <h2>Last Visible Lines</h2>
        <div id="visibleLines" class="lines small"></div>
      </div>
      <div class="card">
        <h2>Recent Cycles</h2>
        <table id="cycleTable"><thead><tr><th>Cycle</th><th>Matched</th><th>Avg Delay</th><th>Max Delay</th></tr></thead><tbody></tbody></table>
      </div>
    </div>
    <div class="grid">
      <div class="card wide">
        <h2>Drop Events</h2>
        <table id="dropTable"><thead><tr><th>Cycle</th><th>Started</th><th>Ended</th><th>Duration</th></tr></thead><tbody></tbody></table>
      </div>
      <div class="card wide">
        <h2>Recent Events</h2>
        <table id="eventTable"><thead><tr><th>Kind</th><th>When</th><th>Details</th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>
  <script>
    function fmtTs(ms) { return ms ? new Date(ms).toLocaleTimeString() : '-'; }
    function fmtMs(ms) { return ms === null || ms === undefined ? '-' : `${Math.round(ms)} ms`; }
    function renderChart(points) {
      const svg = document.getElementById('chart');
      const width = 900, height = 280, pad = 36, innerW = width - pad * 2, innerH = height - pad * 2;
      if (!points.length) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="#89a1c6" font-size="16">No archived delay points</text>`;
        return;
      }
      const minTs = Math.min(...points.map(p => p.ts_ms));
      const maxTs = Math.max(...points.map(p => p.ts_ms));
      const maxDelay = Math.max(10000, ...points.map(p => p.delay_ms || 0));
      const xFor = ts => pad + ((ts - minTs) / Math.max(1, maxTs - minTs)) * innerW;
      const yFor = delay => height - pad - (delay / maxDelay) * innerH;
      const circles = points.map((point) => {
        const color = ['#7dd3fc', '#86efac', '#fca5a5', '#fcd34d', '#c4b5fd', '#fdba74'][(point.segment_id - 1) % 6];
        return `<circle cx="${xFor(point.ts_ms)}" cy="${yFor(point.delay_ms)}" r="5" fill="${color}"><title>Cycle ${point.cycle_id}, segment ${point.segment_id}: ${Math.round(point.delay_ms)} ms</title></circle>`;
      }).join('');
      svg.innerHTML = `<rect x="0" y="0" width="${width}" height="${height}" fill="#0f1728"></rect>${circles}`;
    }
    function fillRows(id, rows, colspan) {
      const tbody = document.querySelector(`#${id} tbody`);
      tbody.innerHTML = rows.length ? rows.join('') : `<tr><td colspan="${colspan}" class="small">No data</td></tr>`;
    }
    async function refresh() {
      const state = await fetch('/state').then(r => r.json());
      document.getElementById('status').innerHTML = `<span class="pill archived">${state.status}</span>`;
      document.getElementById('statusDetail').textContent = state.status_detail;
      document.getElementById('cycleCount').textContent = String(state.completed_cycles.length);
      document.getElementById('delayCount').textContent = String(state.delay_points.length);
      document.getElementById('dropCount').textContent = String(state.drop_events.length);
      document.getElementById('visibleLines').textContent = state.current_visible_lines.length ? state.current_visible_lines.join('\\n') : '(none saved)';
      renderChart(state.delay_points);
      fillRows('cycleTable', state.completed_cycles.slice().reverse().map(c => `<tr><td>${c.cycle_id}</td><td>${c.matched_segments}/${c.reference_segments}</td><td>${fmtMs(c.average_visible_delay_ms)}</td><td>${fmtMs(c.max_visible_delay_ms)}</td></tr>`), 4);
      fillRows('dropTable', state.drop_events.slice().reverse().map(d => `<tr><td>${d.cycle_id}</td><td>${fmtTs(d.started_at_ms)}</td><td>${fmtTs(d.ended_at_ms)}</td><td>${fmtMs(d.duration_ms)}</td></tr>`), 4);
      fillRows('eventTable', state.last_events.slice().reverse().map(e => `<tr><td>${e.kind}</td><td>${fmtTs(e.ts_ms || e.injection_ts_ms || e.started_at_ms)}</td><td class="small">${JSON.stringify(e)}</td></tr>`), 3);
    }
    refresh().catch(console.error);
    setInterval(() => refresh().catch(console.error), 3000);
  </script>
</body>
</html>
"""


def load_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def build_state(output_dir: Path) -> dict[str, Any]:
    cycle_reports = load_ndjson(output_dir / "cycle_reports.ndjson")
    monitor_events = load_ndjson(output_dir / "monitor_events.ndjson")
    snapshots = load_ndjson(output_dir / "live_snapshots.ndjson")

    completed_cycles = [record["summary"] for record in cycle_reports if "summary" in record]
    delay_points = [record for record in monitor_events if record.get("kind") == "segment_match"]
    drop_events = [record for record in monitor_events if record.get("kind") == "drop_event"]
    last_events = monitor_events[-30:]
    current_visible_lines = snapshots[-1]["visible_lines"] if snapshots else []

    return {
        "status": "archived",
        "status_detail": str(output_dir),
        "completed_cycles": completed_cycles,
        "delay_points": delay_points,
        "drop_events": drop_events,
        "last_events": last_events,
        "current_visible_lines": current_visible_lines,
    }


class HistoryHandler(BaseHTTPRequestHandler):
    output_dir: Path | None = None

    def do_GET(self) -> None:  # noqa: N802
        assert self.output_dir is not None
        if self.path == "/":
            body = HTML_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/state":
            body = json.dumps(build_state(self.output_dir)).encode("utf-8")
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a read-only dashboard for archived monitor output.")
    parser.add_argument("--output-dir", required=True, help="Monitor output directory to visualize")
    parser.add_argument("--port", type=int, default=8766, help="Local dashboard port")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    HistoryHandler.output_dir = output_dir
    server = ThreadingHTTPServer(("127.0.0.1", args.port), HistoryHandler)
    print(f"Archive dashboard: http://127.0.0.1:{args.port}")
    print(f"Output dir: {output_dir}")
    print("Press Ctrl-C to stop.")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

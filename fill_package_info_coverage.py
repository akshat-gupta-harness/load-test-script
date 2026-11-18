#!/usr/bin/env python3
"""Fill package_info_coverage from distinct_purls.csv via QA package_info.

Reads PURLs from the CSV, POSTs one PURL at a time, ramping RPS with the
same stages as load-test.js, then UPDATEs matching coverage rows.

  export HARNESS_API_KEY='your-pat'
  python3 fill_package_info_coverage.py
  python3 fill_package_info_coverage.py --profile focus
  python3 fill_package_info_coverage.py --once   # one PURL then exit
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_DSN = "postgresql://vulns:vulns@localhost/vulndb"
DEFAULT_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "distinct_purls.csv")
API_URL = (
    "https://qa.harness.io/vulnservice/api/v1/package_info"
    "?include_latest_version=true&include_eol=true&include_dependency_graph=true"
)
# Same arrival-rate stages as load-test.js (startRate=1).
PROFILES = {
    "full": [
        (200, "30s"),
        (200, "30s"),
        (300, "30s"),
        (300, "30s"),
        (500, "30s"),
        (500, "45s"),
        (1000, "45s"),
        (1000, "1m"),
        (1500, "45s"),
        (1500, "1m"),
        (2000, "45s"),
        (2000, "1m"),
        (3000, "45s"),
        (3000, "1m"),
    ],
    "focus": [
        (300, "30s"),
        (300, "30s"),
        (500, "30s"),
        (500, "45s"),
        (750, "30s"),
        (750, "45s"),
        (1000, "45s"),
        (1000, "45s"),
    ],
    "batch100": [
        (10, "30s"),
        (10, "45s"),
        (25, "30s"),
        (25, "45s"),
        (50, "30s"),
        (50, "1m"),
        (100, "45s"),
        (100, "1m"),
        (150, "45s"),
        (150, "1m"),
        (200, "45s"),
        (200, "1m"),
        (300, "45s"),
        (300, "1m"),
        (400, "45s"),
        (400, "1m"),
        (500, "45s"),
        (500, "2m"),
    ],
}
START_RATE = 1.0


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql_bool(value: bool) -> str:
    return "true" if value else "false"


def psql(dsn: str, sql: str, *, tuples_only: bool = False) -> str:
    cmd = ["psql", dsn, "-v", "ON_ERROR_STOP=1", "-q"]
    if tuples_only:
        cmd.extend(["-A", "-t", "-F", "\t"])
    proc = subprocess.run(cmd, input=sql, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "psql failed")
    return proc.stdout


def parse_purl(raw: str) -> dict | None:
    purl = raw.strip().strip('"')
    if purl.startswith("pkg:/"):
        purl = "pkg:" + purl[5:]
    if not purl.startswith("pkg:"):
        return None
    rest = purl[4:].split("?", 1)[0].split("#", 1)[0]
    eco, _, namever = rest.partition("/")
    if not eco:
        return None
    if not namever:
        eco, _, version = eco.partition("@")
        path = ""
    elif "@" in namever:
        path, version = namever.rsplit("@", 1)
    else:
        path, version = namever, ""
    eco = urllib.parse.unquote(eco)
    path = urllib.parse.unquote(path)
    if not eco or not path:
        return None
    return {"purl": f"pkg:{eco}/{path}@{version}" if version else f"pkg:{eco}/{path}",
            "namespace": eco, "path": path, "version": version}


def load_csv(path: str) -> list[dict]:
    seen = set()
    rows = []
    with open(path, newline="") as f:
        for raw in csv.DictReader(f):
            parsed = parse_purl(raw.get("purl") or "")
            if not parsed:
                continue
            key = (parsed["namespace"], parsed["path"])
            if key in seen:
                continue
            seen.add(key)
            rows.append(parsed)
    return rows


def coverage_work(dsn: str, rows: list[dict]) -> list[dict]:
    """CSV packages that exist in coverage and are still unqueried."""
    tmp = tempfile.NamedTemporaryFile("w", newline="", suffix=".csv", delete=False)
    try:
        w = csv.writer(tmp)
        for r in rows:
            w.writerow([r["namespace"], r["path"], r["purl"]])
        tmp.close()
        sql = f"""
CREATE TEMP TABLE csv_pkg (namespace text, path text, purl text);
\\copy csv_pkg FROM {sql_str(tmp.name)} WITH (FORMAT csv)
COPY (
  SELECT c.purl, c.namespace, c.path
  FROM csv_pkg c
  JOIN package_info_coverage p USING (namespace, path)
  WHERE p.queried_at IS NULL
) TO STDOUT WITH CSV HEADER;
"""
        raw = psql(dsn, sql)
    finally:
        os.unlink(tmp.name)
    return list(csv.DictReader(raw.splitlines()))


def present(value) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict, tuple)):
        return bool(value)
    return True


def flags_from_item(item: dict) -> dict:
    graph = item.get("dependencyGraph") or {}
    return {
        "eol": present(item.get("eolDetails")),
        "dependency_graph": present(graph.get("nodes")) or present(graph.get("edges")),
        "license": present(item.get("licenses")),
        "release_version": present(item.get("latestVersion")),
        "cve": present(item.get("cves")),
    }


def post_package_info(api_key: str, purls: list[str], timeout: int) -> list[dict]:
    body = json.dumps({"purls": purls}).encode()
    last_err = None
    for attempt in range(1, 6):
        req = urllib.request.Request(
            API_URL,
            data=body,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "User-Agent": "fill-package-info-coverage",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.load(resp)
            if not isinstance(data, list):
                raise RuntimeError(f"unexpected API body type: {type(data).__name__}")
            return data
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code in (429, 500, 502, 503, 504) and attempt < 5:
                time.sleep(min(30, 2**attempt))
                continue
            raise RuntimeError(f"HTTP {exc.code}: {exc.read()[:500]!r}") from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError) as exc:
            last_err = exc
            if attempt < 5:
                print(f"retry {attempt} after {exc}", flush=True)
                time.sleep(min(30, 2**attempt))
                continue
            raise
    raise RuntimeError(last_err)


def index_items(items: list[dict]) -> dict:
    by_key = {}
    for item in items:
        purl = item.get("purl") or ""
        parsed = parse_purl(purl)
        if parsed:
            by_key[(parsed["namespace"], parsed["path"])] = item
        if purl:
            by_key[purl] = item
    return by_key


def update_batch(dsn: str, rows: list[dict], by_key: dict) -> int:
    values = []
    for row in rows:
        item = by_key.get((row["namespace"], row["path"])) or by_key.get(row["purl"]) or {}
        flags = flags_from_item(item) if item else {
            "eol": False,
            "dependency_graph": False,
            "license": False,
            "release_version": False,
            "cve": False,
        }
        values.append(
            "({ns}, {path}, {eol}, {dg}, {lic}, {rel}, {cve})".format(
                ns=sql_str(row["namespace"]),
                path=sql_str(row["path"]),
                eol=sql_bool(flags["eol"]),
                dg=sql_bool(flags["dependency_graph"]),
                lic=sql_bool(flags["license"]),
                rel=sql_bool(flags["release_version"]),
                cve=sql_bool(flags["cve"]),
            )
        )
    sql = f"""
UPDATE package_info_coverage AS p
SET eol = v.eol,
    dependency_graph = v.dependency_graph,
    license = v.license,
    release_version = v.release_version,
    cve = v.cve,
    queried_at = now()
FROM (VALUES
    {",".join(values)}
) AS v(namespace, path, eol, dependency_graph, license, release_version, cve)
WHERE p.namespace = v.namespace AND p.path = v.path
RETURNING 1;
"""
    out = psql(dsn, sql, tuples_only=True)
    return len([line for line in out.splitlines() if line.strip()])


def parse_duration(text: str) -> float:
    text = text.strip().lower()
    if text.endswith("ms"):
        return float(text[:-2]) / 1000.0
    if text.endswith("s"):
        return float(text[:-1])
    if text.endswith("m"):
        return float(text[:-1]) * 60.0
    return float(text)


class Ramp:
    """Linear ramp between k6-style stages; holds last target after the schedule."""

    def __init__(self, stages: list[tuple[int, str]], start: float = START_RATE):
        self.t0 = time.monotonic()
        self.spans = []
        t = 0.0
        prev = start
        for target, dur in stages:
            length = parse_duration(dur)
            self.spans.append((t, t + length, float(prev), float(target)))
            t += length
            prev = target
        self.total = t
        self.final = float(stages[-1][0]) if stages else start

    def rps(self) -> float:
        elapsed = time.monotonic() - self.t0
        if elapsed >= self.total:
            return self.final
        for start, end, r0, r1 in self.spans:
            if start <= elapsed < end:
                frac = 0.0 if end == start else (elapsed - start) / (end - start)
                return r0 + (r1 - r0) * frac
        return self.final


class Pacer:
    def __init__(self, ramp: Ramp):
        self.ramp = ramp
        self.lock = threading.Lock()
        self.next_at = time.monotonic()

    def wait(self) -> None:
        with self.lock:
            interval = 1.0 / max(self.ramp.rps(), 0.1)
            now = time.monotonic()
            if self.next_at < now:
                self.next_at = now
            slot = self.next_at
            self.next_at += interval
        delay = slot - time.monotonic()
        if delay > 0:
            time.sleep(delay)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dsn", default=os.environ.get("DATABASE_URL", DEFAULT_DSN))
    p.add_argument("--csv", default=os.environ.get("PURLS_CSV", DEFAULT_CSV))
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--profile", choices=sorted(PROFILES), default="full")
    p.add_argument("--workers", type=int, default=512, help="in-flight HTTP requests")
    p.add_argument("--once", action="store_true", help="process a single batch then exit")
    p.add_argument("--timeout", type=int, default=90)
    return p.parse_args()


def run_one(api_key: str, row: dict, timeout: int) -> tuple[dict, dict]:
    items = post_package_info(api_key, [row["purl"]], timeout)
    return row, index_items(items)


def flush_writes(dsn: str, buf: list[tuple[dict, dict]]) -> int:
    if not buf:
        return 0
    rows = [row for row, _ in buf]
    by_key = {}
    for _, indexed in buf:
        by_key.update(indexed)
    return update_batch(dsn, rows, by_key)


def writer_loop(dsn: str, writes: "queue.Queue[tuple[dict, dict] | None]", stats: dict, lock: threading.Lock) -> None:
    buf: list[tuple[dict, dict]] = []
    last = time.monotonic()
    while True:
        try:
            item = writes.get(timeout=0.2)
        except queue.Empty:
            item = "tick"
        if item is None:
            n = flush_writes(dsn, buf)
            with lock:
                stats["done"] += n
            return
        if item != "tick":
            buf.append(item)
        if buf and (len(buf) >= 25 or time.monotonic() - last >= 0.5):
            n = flush_writes(dsn, buf)
            with lock:
                stats["done"] += n
            buf.clear()
            last = time.monotonic()


def main() -> int:
    args = parse_args()
    api_key = os.environ.get("HARNESS_API_KEY", "").strip()
    if not api_key:
        print("error: set HARNESS_API_KEY", file=sys.stderr)
        return 1

    csv_rows = load_csv(args.csv)
    rows = coverage_work(args.dsn, csv_rows)
    print(
        f"csv unique packages: {len(csv_rows)}; "
        f"unqueried in coverage: {len(rows)}; "
        f"profile={args.profile} workers={args.workers} batch={args.batch_size}",
        flush=True,
    )
    if not rows:
        print("done: nothing to query")
        return 0

    if args.once:
        items = post_package_info(api_key, [r["purl"] for r in rows[: args.batch_size]], args.timeout)
        n = update_batch(args.dsn, rows[: args.batch_size], index_items(items))
        print(f"updated {n}/{args.batch_size}")
        return 0

    ramp = Ramp(PROFILES[args.profile])
    pacer = Pacer(ramp)
    writes: queue.Queue = queue.Queue()
    stats = {"done": 0, "ok": 0, "err": 0}
    lock = threading.Lock()
    writer = threading.Thread(target=writer_loop, args=(args.dsn, writes, stats, lock), daemon=True)
    writer.start()

    t0 = time.time()
    last_log = 0.0
    in_flight = threading.Semaphore(args.workers)

    def on_done(fut: concurrent.futures.Future) -> None:
        in_flight.release()
        try:
            writes.put(fut.result())
            with lock:
                stats["ok"] += 1
        except Exception as exc:
            with lock:
                stats["err"] += 1
            print(f"error: {exc}", flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        i = 0
        while i < len(rows):
            pacer.wait()
            in_flight.acquire()
            batch = rows[i : i + args.batch_size]
            i += len(batch)
            # batch-size stays 1 for the API; submit one row per arrival.
            fut = pool.submit(run_one, api_key, batch[0], args.timeout)
            fut.add_done_callback(on_done)
            now = time.time()
            if now - last_log >= 1.0:
                last_log = now
                elapsed = max(now - t0, 1e-6)
                with lock:
                    done, ok, err = stats["done"], stats["ok"], stats["err"]
                print(
                    f"rps_target={ramp.rps():.0f} in_flight~{args.workers - in_flight._value} "
                    f"ok={ok} err={err} db={done}/{len(rows)} "
                    f"({ok / elapsed:.1f} req/s)",
                    flush=True,
                )

    writes.put(None)
    writer.join()
    print(f"done: updated {stats['done']} errors {stats['err']}")
    return 0 if stats["err"] == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        raise SystemExit(130)

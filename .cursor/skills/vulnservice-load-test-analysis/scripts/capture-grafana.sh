#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 || ! "$2" =~ ^[0-9]+$ || ! "$3" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <run-dir> <from-epoch-ms> <to-epoch-ms>" >&2
  exit 2
fi

run_dir=$1
from_ms=$2
to_ms=$3
output_dir="$run_dir/screenshots"

if command -v google-chrome >/dev/null; then
  chrome=$(command -v google-chrome)
elif command -v chromium >/dev/null; then
  chrome=$(command -v chromium)
elif [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  echo "Google Chrome or Chromium is required" >&2
  exit 1
fi

mkdir -p "$output_dir"

capture() {
  local dashboard=$1
  local output=$2

  "$chrome" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --window-size=1920,1600 \
    --virtual-time-budget=15000 \
    --timeout=30000 \
    --screenshot="$output" \
    "$dashboard"

  [[ -s "$output" ]] || {
    echo "empty screenshot: $output" >&2
    exit 1
  }
}

query="orgId=1&from=$from_ms&to=$to_ms&timezone=utc&kiosk&refresh=off"
capture \
  "http://localhost:3000/d/k6-load-test/k6-load-test?$query" \
  "$output_dir/k6-load-test.png"
capture \
  "http://localhost:3000/d/gcp-vulnservice/gcp-vulnservice-2b-cloud-sql?$query" \
  "$output_dir/gcp-cloud-sql.png"

echo "captured Grafana screenshots in $output_dir"

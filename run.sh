#!/usr/bin/env bash
set -euo pipefail
export HARNESS_API_KEY='pat.DUMMY_TOKEN_REPLACE_WITH_ACTUAL_PAT'
cd "$(dirname "$0")"
if [[ -z "${HARNESS_API_KEY:-}" ]]; then
  echo "error: set HARNESS_API_KEY before running" >&2
  exit 1
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "error: k6 not found. Install with: brew install k6" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found. Install with: brew install docker" >&2
  exit 1
fi

# Colima provides the Docker daemon on this machine.
if command -v colima >/dev/null 2>&1; then
  if ! colima status >/dev/null 2>&1; then
    echo "Starting Colima..."
    colima start
  fi
elif ! docker info >/dev/null 2>&1; then
  echo "error: Docker daemon not reachable (start Colima: colima start)" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "error: Docker Compose not found. Install with: brew install docker-compose" >&2
  exit 1
fi

ADC="${HOME}/.config/gcloud/application_default_credentials.json"
if [[ ! -f "$ADC" ]]; then
  echo "note: no GCP ADC at $ADC — GCP panels need:" >&2
  echo "  gcloud auth application-default login" >&2
  echo "  gcloud config set project qa-setup" >&2
fi

"${COMPOSE[@]}" up -d
until curl -fsS http://localhost:9090/-/ready >/dev/null; do
  sleep 1
done

ulimit -n 65535 2>/dev/null || true

echo "Grafana k6:  http://localhost:3000/d/k6-load-test/k6-load-test"
echo "Grafana GCP: http://localhost:3000/d/gcp-vulnservice/gcp-vulnservice"
echo "k6 UI:       http://localhost:5665"
echo "Report:      $(pwd)/report.html"
echo

K6_WEB_DASHBOARD=true \
K6_WEB_DASHBOARD_EXPORT=report.html \
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
k6 run -o experimental-prometheus-rw load-test.js

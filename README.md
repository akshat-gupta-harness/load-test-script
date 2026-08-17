# package_info k6 load test

Ramps POST load against Harness `package_info` using ~276k PURLs from `distinct_purls.csv`, with a live local dashboard and abort-on-failure thresholds.

## Prerequisites

```bash
brew install k6 docker docker-compose colima
```

`./run.sh` starts Colima if needed, then brings up local Prometheus + Grafana.

For GCP panels (GKE `vulnservice` + Cloud SQL `vulnerability-qa` in `qa-setup`):

```bash
brew install --cask google-cloud-sdk   # if needed
gcloud auth application-default login
gcloud config set project qa-setup
```

Your account needs **Monitoring Viewer** on `qa-setup`. `stackdriver-exporter` mounts
`~/.config/gcloud`, pulls those metrics from Cloud Monitoring with your ADC, and exposes them
on http://localhost:9255/metrics for Prometheus to scrape every 60s. Grafana reads them from
Prometheus, because its own Cloud Monitoring plugin only accepts service account keys or GCE
metadata credentials — not user ADC. ADC refreshes itself, so the login is one-time.

Optional (macOS) if you hit ephemeral-port exhaustion at high RPS:

```bash
sudo sysctl -w net.inet.tcp.msl=1000
```

## Run

```bash
export HARNESS_API_KEY='your-pat'
./run.sh
```

- Grafana k6: http://localhost:3000/d/k6-load-test/k6-load-test
- Grafana GCP: http://localhost:3000/d/gcp-vulnservice/gcp-vulnservice (`vulnservice` CPU/mem, pod network rx/tx, Cloud SQL connections/CPU/mem/disk)
- Built-in k6 UI: http://localhost:5665
- Static report after finish: `report.html`
- Override host: `BASE_URL=https://qa.harness.io ./run.sh`

Request matches `sample-curl` (one PURL per POST, 30s timeout). Tunables (`LOAD`, `THRESHOLDS`) are at the top of `load-test.js`.
Grafana has separate panels for p50, p95, total RPS, and RPS by exact HTTP
status code. Prometheus data is retained for seven days.

Stop the local monitoring services with:

```bash
docker-compose down
# optional: colima stop
```

## Ramp profiles

Pick with `PROFILE=…` (default `full`):

| Profile | RPS path | Batch |
|---------|----------|-------|
| `full` | 200 → 300 → 500 → … → 3000 | 1 (override with `BATCH_SIZE`) |
| `focus` | 300 → 500 → 750 → 1000 | 1 |
| `batch100` | slow 10 → 25 → 50 → … → 500 (longer holds) | **100** |

```bash
PROFILE=batch100 ./run.sh
```

`maxVUs: 10000`. Sized for ~400ms latency: concurrency ≈ RPS × 0.4 (Little’s law). If p95 climbs under load, watch `dropped_iterations` and `vus`.

## Abort thresholds

| Metric | Rule | Effect |
|--------|------|--------|
| `http_req_failed` | rate &lt; 5% | abort if breached |
| `status_5xx_rate` | rate &lt; 2% | abort if breached |
| Warmup | `delayAbortEval: 1m` | ignore early noise |

## Metrics (k6)

| Metric | Meaning |
|--------|---------|
| `http_reqs` | Delivered RPS |
| `http_req_duration` p50/p95 | Client latency |
| `http_req_failed` | Fail share (non-2xx + network) |
| `status_2xx` / `4xx` / `5xx` | Status counts |
| `status_5xx_rate` | 5xx fraction (abort) |
| `vus` / `dropped_iterations` | Client limit vs API limit |

## Success criteria (per hold) + GCP / Cloud SQL

A stage holds if:

1. Delivered RPS within ~10% of target
2. p50 ~400ms; p95 stays flat (under 30s timeout)
3. 5xx under abort; treat CSV-driven 4xx separately from capacity
4. GKE `vulnservice` (cluster `qa-private`, ns `harness-helm-new`): CPU/mem not pegged with climbing p99 / LB 5xx
5. Cloud SQL `vulnerability-qa`: connections OK; no disk saturation matching the hold

**Breaking RPS** = last stage that held those criteria; next stage is where abort, GCP/SQL saturation, or client `dropped_iterations` appears.

Correlate k6 stage wall-clock with the local GCP dashboard. Calm GCP + rising `dropped_iterations` → client-bound; hot app/SQL + 5xx while RPS hits target → service-bound.

After the run, note peak sustained RPS, p50/p95, fail/5xx rates, and a one-liner on GCP/SQL.

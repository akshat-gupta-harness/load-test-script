---
name: vulnservice-load-test-analysis
description: >-
  Analyze vulnservice QA k6 package_info/cached load tests using k6 terminal
  output, local Prometheus, GCP Cloud SQL/Query Insights, and GKE pod metrics;
  identify the bottleneck, capture Grafana screenshots, and write one run
  folder under docs/load-test-runs/. Use when the
  user asks to summarize a load test, find the cliff/bottleneck, check GCP DB
  metrics after a run, compare runs, or create a dated load-test report.
---

# vulnservice load-test analysis

## Instructions

1. Read [reference.md](reference.md) for metrics, filters, and tooling details.
2. Match output shape to existing run folders under `docs/load-test-runs/`.
3. **Measure, don’t invent.** Pull k6 + GCP (+ Prometheus/kubectl). Verify SQL tier and pool in GCP/kubectl — don’t trust chat memory.
4. Never paste secrets (`HARNESS_API_KEY` in `run.sh`).

### Workflow

1. **k6** — terminal / `report.html`: fail%, 5xx%, p50/p95, max VUs, abort vs finished.
2. **Stages** — local Prometheus (`k6_http_reqs_total`, `k6_status_2xx_total`, `k6_vus`, `k6_status_5xx_rate_rate`).
3. **Cloud SQL** — project `qa-setup`, instance `vulnerability-qa`: verify tier; CPU, backends, memory for the run window.
4. **Query Insights** — rank `perquery/execution_time` by `querystring`.
5. **App** — ns `harness-helm-new`, container `vulnservice`: CPU/mem vs limits, `POSTGRES_POOL_MAX_CONNS`.
6. **Bottleneck** (at stress peak):

```text
backends pegged + SQL CPU headroom  → DB connections / pool
SQL CPU ~100%                       → Cloud SQL CPU
pod CPU ~limit + SQL/pool OK        → app CPU
skip_cache                          → Redis not in play
```

7. **Create one run folder**: `docs/load-test-runs/<run-id>/`, where `<run-id>` is `YYYY-MM-DD-package-info-cached[-variant]` (e.g. `-6vcpu`). Put the report at `analysis.md`.
8. **Capture screenshots** for the absolute run window (never `now-*` after a run):
   ```bash
   .cursor/skills/vulnservice-load-test-analysis/scripts/capture-grafana.sh \
     docs/load-test-runs/<run-id> <from_epoch_ms> <to_epoch_ms>
   ```
   This writes `screenshots/k6-load-test.png` and `screenshots/gcp-cloud-sql.png`. Add both to `analysis.md`. Capture authenticated Harness Observability manually if headless Chrome lacks the user’s SSO session.
9. Optional: Slack blurb; update `docs/read-optimisation.md` only if the cliff story changed.

### Doc sections (required)

Header (endpoint, flags, env) → Capacity → Latency → Stage signals → GCP/app peaks → RCA + failure chain + vs prior → Query Insights → Amplifiers / Not bottleneck / Bottom line.

### Checklist

- [ ] k6 summary (abort vs complete)
- [ ] Stage timeline
- [ ] SQL tier verified
- [ ] SQL CPU / backends / memory
- [ ] Query Insights top queries
- [ ] Pod CPU/mem + pool
- [ ] Bottleneck named with evidence
- [ ] `analysis.md` and Grafana screenshots saved in one run folder
- [ ] Screenshots use the absolute run window and render real panels
- [ ] No credentials

## Examples

- “I ran the test again — create a summary and check GCP DB metrics”
- “DB was upgraded — what’s the bottleneck now?”
- “Write today’s load-test doc like Aug 17”
- “Slack summary of the run including slow queries”

---
name: vulnservice-load-test-analysis
description: >-
  Analyze vulnservice QA k6 package_info/cached load tests using k6 terminal
  output, local Prometheus, GCP Cloud SQL/Query Insights, and GKE pod metrics;
  identify the bottleneck and write dated RCA docs under docs/. Use when the
  user asks to summarize a load test, find the cliff/bottleneck, check GCP DB
  metrics after a run, compare runs, or write docs/YYYY-MM-DD-package-info-cached-load-test.md.
---

# vulnservice load-test analysis

## Instructions

1. Read [reference.md](reference.md) for metrics, filters, and tooling details.
2. Match output shape to existing dated docs:
   - `docs/2026-08-14-package-info-cached-load-test.md`
   - `docs/2026-08-17-package-info-cached-load-test.md`
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

7. **Write** `docs/YYYY-MM-DD-package-info-cached-load-test.md` (suffix e.g. `-6vcpu` if multiple same-day hardware runs).
8. Optional: Slack blurb; update `docs/read-optimisation.md` only if the cliff story changed.

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
- [ ] Dated doc written; no credentials

## Examples

- “I ran the test again — create a summary and check GCP DB metrics”
- “DB was upgraded — what’s the bottleneck now?”
- “Write today’s load-test doc like Aug 17”
- “Slack summary of the run including slow queries”

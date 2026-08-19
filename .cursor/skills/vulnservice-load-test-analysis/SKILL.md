---
name: vulnservice-load-test-analysis
description: >-
  Analyze QA k6 package_info/cached load tests (component-data-service) using
  k6 terminal output, local Prometheus, GCP Cloud SQL/Query Insights, and GKE
  pod metrics; identify the bottleneck, capture Grafana screenshots, write one
  run folder under docs/load-test-runs/, and post the Slack summary to channel
  C0BRHMF92DN in the fixed format. Use when the user asks to summarize a load
  test, find the cliff/bottleneck, check GCP DB metrics after a run, compare
  runs, create a dated load-test report, or post the run to Slack.
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
5. **App** — ns `harness-helm-new`, container **`component-data-service`** (not `vulnservice` for this endpoint): CPU/mem vs limits, `POSTGRES_POOL_MAX_CONNS` from the CDS configmap.
6. **Bottleneck** (at stress peak):

```text
backends pegged + SQL CPU headroom  → DB connections / pool
SQL CPU ~100%                       → Cloud SQL CPU
pod CPU ~limit + SQL/pool OK        → app CPU
skip_cache                          → Redis not in play
```

7. **Create one run folder**: `docs/load-test-runs/<run-id>/`. `<run-id>` is `YYYY-MM-DD-N-<kebab-brief>` — date, **1-based iteration that day** (count existing `docs/load-test-runs/YYYY-MM-DD-*`), then a short change/config slug (e.g. `2026-08-19-1-cds-batch100-pool256-cve-thin`). Never `package-info` / `package_info` in the folder or H1 (endpoint is always that). Put the report at `analysis.md`. H1: `# YYYY-MM-DD — N — <brief change / config>`.
8. **Capture screenshots** for the absolute run window (never `now-*` after a run):
   ```bash
   .cursor/skills/vulnservice-load-test-analysis/scripts/capture-grafana.sh \
     docs/load-test-runs/<run-id> <from_epoch_ms> <to_epoch_ms>
   ```
   This writes `screenshots/k6-load-test.png` and `screenshots/gcp-cloud-sql.png`. Add both to `analysis.md`. Capture authenticated Harness Observability manually if headless Chrome lacks the user’s SSO session.
9. **Slack summary** — when the user asks to post/share on Slack (or after a full analysis if they ask), post with `slack_send_message` to channel **`C0BRHMF92DN`** using the fixed format in [reference.md](reference.md) § Slack summary. Required sections include **What we changed** and **What improved / didn't / got worse**. Do not invent another channel or a short “blurb” shape. **Format it:** `**bold**` section headings, `-` bullets under each, `` `code` `` for identifiers, `**bold**` on the scan-worthy numbers, no tables — never a flat wall of plain lines.
10. Optional: update `docs/read-optimisation.md` only if the cliff story changed.

### Doc sections (required)

H1 (`date — N — change/config`) → Header (endpoint, flags, env) → Capacity → Latency → Stage signals → GCP/app peaks → RCA + failure chain + vs prior → Query Insights → Amplifiers / Not bottleneck / Bottom line.

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
- [ ] Slack posted to `C0BRHMF92DN` in the fixed format, formatted (bold headings + bullets, no tables)
- [ ] No credentials

## Examples

- “I ran the test again — create a summary and check GCP DB metrics”
- “DB was upgraded — what’s the bottleneck now?”
- “Write today’s load-test doc like Aug 17”
- “Post the summary on Slack”

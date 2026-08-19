# Load-test analysis guidelines (vulnservice QA)

Playbook for analyzing a `package_info/cached` k6 run and writing a dated summary.

**Cursor skill:** `.cursor/skills/vulnservice-load-test-analysis/` (agent loads `SKILL.md`; this file mirrors the skill’s `reference.md`).

**Repo:** `load-test-script`  
**Example outputs:** `docs/load-test-runs/*/analysis.md`  
**Related:** `docs/read-optimisation.md`

---

## When to run

Trigger when the user asks to:

- summarize / RCA a load-test run
- check bottleneck after a DB/app change
- create a run folder containing the analysis and dashboard screenshots
- compare to a prior dated run

Do **not** invent metrics — pull k6 + GCP (+ optional Prometheus/kubectl).

---

## Inputs to collect first

| Input | Where |
|-------|--------|
| k6 final summary | Terminal running `./run.sh` (thresholds, fail%, 5xx%, p50/p95, VUs, reqs) |
| Stage profile | `load-test.js` → `PROFILES[PROFILE]` stage targets/durations |
| Flags | URL query / env (`SKIP_CACHE`, etc.). Server treats **presence** as true |
| Run window (UTC) | Infer from terminal timestamps or Prometheus first/last k6 samples |
| Env claim | What user changed (pool size, SQL tier, replicas) — **verify in GCP/kubectl** |

---

## Step 1 — k6 result (client)

From the k6 terminal (or `report.html`):

1. Thresholds: pass/fail; note `rate<0.25` + `delayAbortEval: '1m'` — run may **complete stages** without aborting even with some failures.
2. Record: `http_reqs`, `http_req_failed`, `status_5xx_rate`, p50/p95/max duration, max VUs, dropped iterations, wall duration.
3. Distinguish **abort** (`interrupted`, threshold fail) vs **finished** (`0 interrupted`, scenario ✓).

**Healthy band:** stages where delivered RPS ≈ target, 5xx ≈ 0, VUs stable.  
**Break:** VU explosion, p95 multi-second, delivered RPS << target, and/or 5xx climb.

---

## Step 2 — stage timeline (local Prometheus)

Stack: `docker compose` → Prometheus `:9090`, Grafana `:3000`.

Useful queries (adjust window to run UTC):

```promql
sum(rate(k6_http_reqs_total[30s]))
sum(rate(k6_status_2xx_total[30s]))
k6_vus
k6_status_5xx_rate_rate
```

Map each stage hold/ramp to: delivered RPS, VUs, 5xx%. Mark **Stable / Soft cliff / Broken**.

Grafana: `http://localhost:3000/d/k6-load-test/k6-load-test`

---

## Step 3 — Cloud SQL (GCP Monitoring)

**Project:** `qa-setup` · **Instance:** `vulnerability-qa` · **DB:** `vulnerability`

Always confirm live tier (do not trust chat memory):

```bash
gcloud sql instances describe vulnerability-qa --project=qa-setup \
  --format='yaml(settings.tier,settings.dataDiskSizeGb,databaseVersion,settings.insightsConfig)'
```

`db-custom-N-M` → **N vCPU**, **M MiB** RAM.

Pull for the run window (± a few minutes):

| Metric | Filter sketch | What it tells you |
|--------|---------------|-------------------|
| CPU util | `cloudsql.googleapis.com/database/cpu/utilization` + `database_id="qa-setup:vulnerability-qa"` | SQL compute cliff if ~100% |
| Memory util | `…/database/memory/utilization` | RAM pressure |
| Backends | `…/postgresql/num_backends` (per `database` label) | Pool/conn cliff if pegged (e.g. 64 or 256) |
| Disk read/write ops | `…/disk/read_ops_count`, `write_ops_count` | IO-heavy queries |
| Disk util | `…/disk/utilization` | Capacity, not usually the cliff |

Aligner: `ALIGN_MEAN` or `ALIGN_MAX`, `alignmentPeriod=60s`.

Grafana (if exporter up): `http://localhost:3000/d/gcp-vulnservice/gcp-vulnservice`  
Console insights: [Query Insights](https://console.cloud.google.com/sql/instances/vulnerability-qa/insights?project=qa-setup)

---

## Step 4 — Query Insights (what burned SQL)

Metric family: `cloudsql.googleapis.com/database/postgresql/insights/perquery/*`  
Resource: `cloudsql_instance_database` with `resource_id="qa-setup:vulnerability-qa"`.

1. `perquery/execution_time` — rank by `ALIGN_DELTA` / sum over window; group by `metric.label.querystring`.
2. Optionally `latencies` (distribution → count + mean µs), `row_count`, `io_time`, `shared_blk_access_count`.

Typical hot queries on `skip_cache` miss path:

1. `product_cves ⋈ cves` + `dense_rank()` provider priority (`ANY` on product/vendor/language)
2. `clearly_defined_licenses` `DISTINCT ON (namespace, name)` via `unnest`
3. Other license point lookups (`vulncheck_licenses`, exact CD, …)
4. Full-table aliases — often **cheap on CPU** but still wasteful round-trips

Code homes: `FindCVEsForProductBatch` in vulnservice `common/store/vulns/database.go`.

---

## Step 5 — App / GKE metrics

Namespace: `harness-helm-new` · container: `vulnservice`

| Check | How |
|-------|-----|
| Resources | `kubectl get deploy -n harness-helm-new vulnservice -o json` → requests/limits, `POSTGRES_POOL_MAX_CONNS` |
| Pods | primary + canary; attribute load to the primary receiving traffic |
| CPU | `kubernetes.io/container/cpu/core_usage_time` (RATE) or `cpu/limit_utilization` (MEAN) |
| Memory | `kubernetes.io/container/memory/used_bytes` |

If pod CPU ≪ limit and SQL CPU ≪ 100% but backends pegged → **pool/conn** bottleneck.  
If SQL CPU ~100% and backends not (or also) high → **DB CPU**.  
If pod CPU ~limit and SQL has headroom → **app CPU** (scale pods / trim app work).

---

## Step 6 — Decide the bottleneck (decision tree)

```text
At the stress peak (highest target / VU explosion):
  backends pegged AND SQL CPU has headroom?     → DB connections / pool
  SQL CPU ~100%?                                 → Cloud SQL CPU
  pod CPU ~limit, SQL + pool OK?                 → app CPU
  fail/5xx high with context canceled?           → usually secondary to latency/queue above
  Redis bypassed (skip_cache)?                   → expected; not "Redis bottleneck"
```

Always state:

- **Primary bottleneck** (one sentence)
- **Not the bottleneck** (2–4 bullets)
- **vs prior run** if a dated doc exists (pool, SQL tier, healthy RPS, 5xx)

---

## Step 7 — Create the run artifact

**Folder:** `docs/load-test-runs/<run-id>/`

Use `YYYY-MM-DD-N-<kebab-brief>` for `<run-id>` (date, day’s iteration, change/config). Do not include `package-info`. Put the report at `analysis.md`; never overwrite another run. H1 is `# YYYY-MM-DD — N — <brief>`.

```text
docs/load-test-runs/<run-id>/
├── analysis.md
└── screenshots/
    ├── k6-load-test.png
    ├── gcp-cloud-sql.png
    └── vulnservice-metrics.png  # when authenticated capture is available
```

### Required sections (match prior docs)

1. Header: endpoint, command/flags, env (pod resources, SQL tier **as verified**)
2. **Capacity** table: max applied RPS, healthy RPS, break point; end-of-run fail/5xx/reqs/VUs
3. **Latency** table: stable vs overall p50/p95/max
4. **Stage signals** table: target, delivered RPS, 5xx, SQL backends, SQL CPU, read
5. **GCP DB (+ app) peaks**
6. **RCA**: real bottleneck + failure chain (ascii) + comparison table to prior run
7. **Query Insights** top queries (share %, short SQL identity)
8. Amplifiers / Not the bottleneck / Bottom line

Tone: concise, tables over prose, no secrets (`HARNESS_API_KEY` in `run.sh` — never paste).

---

## Step 8 — Capture dashboard evidence

Use an absolute UTC range covering the run plus 2–5 minutes on either side. Never archive a `now-*` screenshot.

```bash
.cursor/skills/vulnservice-load-test-analysis/scripts/capture-grafana.sh \
  docs/load-test-runs/<run-id> <from_epoch_ms> <to_epoch_ms>
```

Open the resulting PNGs and verify the panels and run window rendered. Embed them in `analysis.md`:

```markdown
## Dashboard snapshots

![k6 load-test signals](screenshots/k6-load-test.png)
![vulnservice and Cloud SQL signals](screenshots/gcp-cloud-sql.png)
```

Harness Observability needs an authenticated browser session. If headless capture redirects to login, capture it manually using the same absolute range and save it as `screenshots/vulnservice-metrics.png`; never store browser cookies or tokens.

---

## Step 9 — Optional follow-ups

| Ask | Action |
|-----|--------|
| Slack blurb | Short markdown: result, cliff, top 2 queries, takeaway (no tables) |
| Update `read-optimisation.md` | Only if bottleneck story changed (e.g. pool done → SQL CPU → pool again) |
| Elaborate a query | Open vulnservice SQL builder; explain join/rank/`ANY`/Go post-filter |

---

## Auth / tooling notes

- Prefer `gcloud` + Monitoring REST with `gcloud auth print-access-token` (or ADC).
- `kubectl` needs a working GKE context (`qa-private` / `harness-helm-new`).
- Running `./run.sh` may be blocked by auto-review (hardcoded PAT) — ask user to run locally or approve.
- Local Prometheus only has **k6** series unless stackdriver exporter is healthy; app RED metrics usually come from GCP/GKE or cluster Prometheus, not this compose stack alone.

---

## Checklist (agent)

- [ ] k6 summary captured (fail%, 5xx%, latency, VUs, abort vs complete)
- [ ] Stage timeline from Prometheus
- [ ] SQL tier verified via `gcloud sql instances describe`
- [ ] SQL CPU, backends, memory (and disk if useful) for run window
- [ ] Query Insights top queries ranked
- [ ] Pod CPU/mem + pool config
- [ ] Bottleneck named with evidence
- [ ] Run folder contains `analysis.md` and verified screenshots
- [ ] Screenshots use an absolute UTC run window
- [ ] No credentials in docs or chat


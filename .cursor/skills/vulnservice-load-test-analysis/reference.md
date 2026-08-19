# Load-test analysis reference (vulnservice QA)

Detailed playbook for the `vulnservice-load-test-analysis` skill. Example outputs live under `docs/load-test-runs/`.

---

## When to run

Trigger when the user asks to:

- summarize / RCA a load-test run
- check bottleneck after a DB/app change
- create `docs/load-test-runs/<run-id>/analysis.md` with dashboard screenshots
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

Namespace: `harness-helm-new` · container: **`component-data-service`** (package_info traffic; do not use `vulnservice` for this endpoint)

| Check | How |
|-------|-----|
| Resources | `kubectl get deploy -n harness-helm-new component-data-service -o json` → requests/limits |
| Pool | CDS configmap `POSTGRES_POOL_MAX_CONNS` (verify; do not assume 512) |
| Pods | primary receiving traffic (`component-data-service-…`) |
| CPU | `kubernetes.io/container/cpu/core_usage_time` (RATE) for `container_name="component-data-service"` |
| Memory | `kubernetes.io/container/memory/used_bytes` (non-evictable) |

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

Use `YYYY-MM-DD-N-<kebab-brief>` for `<run-id>` (e.g. `2026-08-19-1-cds-batch100-pool256-cve-thin`). `N` is 1-based for that calendar day: count top-level `docs/load-test-runs/YYYY-MM-DD-*` then +1. Brief = what changed / config (service, profile, pool, SQL, query opt) — **not** `package-info` / `package_info` (always the same endpoint). Never overwrite another run. Leave historical folder names as-is.

```text
docs/load-test-runs/<run-id>/
├── analysis.md
└── screenshots/
    ├── k6-load-test.png
    ├── gcp-cloud-sql.png
    └── vulnservice-metrics.png  # when authenticated capture is available
```

### Required sections (match prior docs)

1. **H1:** `# YYYY-MM-DD — N — <brief change / config>` — date, day’s iteration, what changed. Do **not** put `package_info` / `package-info` in the H1 (it lives on the Endpoint line). Then header: endpoint, command/flags, env (pod resources, SQL tier **as verified**)
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

Use an **absolute UTC range** covering the run plus 2–5 minutes on either side. Do not save a `now-15m`/`now-30m` screenshot: it becomes irreproducible immediately.

For local Grafana:

```bash
.cursor/skills/vulnservice-load-test-analysis/scripts/capture-grafana.sh \
  docs/load-test-runs/<run-id> <from_epoch_ms> <to_epoch_ms>
```

The script uses installed Chrome/Chromium in headless mode and captures:

- k6: `/d/k6-load-test/k6-load-test`
- app + Cloud SQL: `/d/gcp-vulnservice/gcp-vulnservice-2b-cloud-sql`

Open both PNGs and verify that panels rendered, the time range is UTC, and the data covers the intended run. Add a `Dashboard snapshots` section to `analysis.md`:

```markdown
## Dashboard snapshots

![k6 load-test signals](screenshots/k6-load-test.png)
![vulnservice and Cloud SQL signals](screenshots/gcp-cloud-sql.png)
```

Harness Observability requires the user’s authenticated browser session. If headless capture redirects to login, ask the user to capture it manually with the same absolute `from`/`to` values and save it as `screenshots/vulnservice-metrics.png`; do not store cookies or tokens.

---

## Step 9 — Slack summary (required format)

**Channel (hardcoded):** `C0BRHMF92DN`  
**Tool:** `slack_send_message` with `channel_id=C0BRHMF92DN`  
Do **not** draft to `#scs-team-room` or ask which channel unless the user overrides.

Retain this section order and question-style headings. Fill numbers from the measured run; keep the same voice.

### Formatting rules

`slack_send_message` renders standard markdown. Format the post — do not send a flat wall of plain lines.

| Element | Rule |
|---------|------|
| Section headings | `**Bold**` on its own line (`Test env`, `Why?`, …). No `#` headers. |
| Body under a heading | `-` bullets, one fact per bullet. No bare stacked lines. |
| Blank lines | Exactly **one** between sections (the tool already spaces bullets). |
| Metrics that matter | `**bold**` the number the reader is scanning for (`**~25 RPS**`, `**~517 (pegged)**`). |
| Identifiers | Inline `` `code` ``: endpoints, env vars, tiers, images, query/lookup names (`cve_query`, `POSTGRES_POOL_MAX_CONNS=512`, `db-custom-6-32768`). |
| Emphasis | `_italic_` sparingly, for a negation (`_not_ the HTTP cliff`). |
| Tables | **Never** — Slack tables read badly on mobile. Use bullets. |
| Takeaway | Single paragraph starting `**Takeaway:**`, not a bullet list. |
| What we changed | Always include. 1–4 bullets of the experiment (SQL/app/infra), not the RCA. |
| Improved / didn't / worse | Always include vs the named prior run. Three labeled bullets: `Improved:`, `Didn't improve:`, `Got worse:` (use `_none_` if empty). |
| Length | One message; keep under 5000 chars. No secrets. |

### Template

```text
**<service> QA load test — YYYY-MM-DD (<variant>)[ — <optional RCA tag>]**
`POST /package_info/cached?skip_cache=true` · `PROFILE=<profile>` · `batch_size=<N>`

**Test env**
- QA (`qa.harness.io`) · 1× `<component-data-service|vulnservice>` primary (`<image>`, **<CPU> / <mem>** limit)
- Cloud SQL `<tier>` (**<N> vCPU / <GiB>**, Postgres 17)
- `POSTGRES_POOL_MAX_CONNS=<N>` (verified) · backends peaked **~<N> (<pegged|not pegged>)**
- Sent: <stage summary> (aborted|finished · <duration> · <where>)

**Till what RPS was it stable?**
- Clean through **~<N> RPS** — p50 ~…, p95 ~…, 0% fail → **~<PURLs/s> PURLs/s**

**Till what RPS were we getting 2xx?**
- Pure 2xx through **~<N>**
- <soft band, if any — mostly 2xx through ~<N>>
- Collapses on the **<N>** hold

**At what RPS did it break?**
- <VU / latency signal at break> — p50/p95 → …
- Failures are **<timeouts|503s|mix>** (**<5xx%>** 5xx)
- Abort/finish at **~<fail%> fail** under the <target> target

**Why?**
- Primary: **<one sentence bottleneck>**
- <2–5 bullets of evidence: app L2 latency, Redis bypass, backends, SQL CPU, pod CPU>

**What we changed**
- <1–4 bullets: code/SQL/infra under test this run — e.g. thin CVE rank + hydrate, pool 512→256, image bump>
- Comparator: `<prior run-id>` (same endpoint/flags unless noted)

**What improved / didn't / got worse**
- Improved: <SQL share, latency, abort stage, … — or `_none_`>
- Didn't improve: <HTTP cliff, clean RPS/PURL/s, failure mode, …>
- Got worse: <peaks, 5xx, abort earlier, … — or `_none_`>

**DB query analysis**
- Insights (CPU share): …
- App latency (if available): …

**Takeaway:** <1–3 sentences. Next lever explicit.>
```

### Example shape (Aug 19 vulnservice license opts — keep structure, swap measured numbers)

```text
**vulnservice QA load test — 2026-08-19 (batch 100 · license opts)**
`POST /package_info/cached?skip_cache=true` · `PROFILE=batch100` · `batch_size=100`

**Test env**
- QA (`qa.harness.io`) · 1× `vulnservice` primary (`vulnservice:1.32.0`, **4 CPU / 16 GiB** limit)
- Cloud SQL `db-custom-6-32768` (**6 vCPU / 32 GiB**, Postgres 17)
- `POSTGRES_POOL_MAX_CONNS=512` (verified) · backends peaked **~517 (pegged)**
- Sent: slow ramp **10 → 25 → 50 → 100** (aborted ~4m52s on the 100 hold)

**Till what RPS was it stable?**
- Clean through **~25 RPS** — p50 ~0.5–0.8 s, p95 ~1.2–1.5 s, 0% fail → **~2500 PURLs/s**

**Till what RPS were we getting 2xx?**
- Pure 2xx through **~25**
- Mostly 2xx through **~50** (2xx peak ~38–42) — first HTTP 0 on the 50 hold, but it still serves
- Collapses on the **100** hold

**At what RPS did it break?**
- Timeouts start on **50** (~10:35:30 UTC) — p50/p95 → ~4–30 s, 2xx still majority
- Collapse under **100** — VUs → ~2291, p50/p95 → ~30 s
- Failures are **client 30s timeouts** dominant (**0.70%** 5xx / late 503s)
- Abort at **~25.8% fail** under the 100 target

**Why?**
- Primary: **`cve_query` Postgres L2 latency under batch-100**, then SQL CPU + pool peg on 100
- App L2: `cve_query` p50 → **~227 ms**, p90 → **~2.13 s** (was ~625 ms / ~2.5 s on Aug 17)
- License L2 stays fast: p50 **~15 ms**, p90 **~266 ms** — _not_ the HTTP cliff
- Redis: `package_info` + `cve_query` both `bypass_force`; license has **0** L1 lookups
- At first timeouts: backends ~57, SQL CPU ~43% — pool/SQL **not** primary yet
- On 100: backends **~517 (pegged)**, SQL CPU **~97–100%**, disk reads ~14k/s, pod CPU ~3.2/4

**What we changed**
- License SQL: CD `DISTINCT ON` opt (Insights share was the lever)
- Comparator: `2026-08-17-package-info-cached-batch100` (same endpoint/flags/profile)

**What improved / didn't / got worse**
- Improved: CD `DISTINCT ON` Insights **~38% → ~3%**; mostly-2xx through **~50** (was collapse on early 50); abort stage **100** vs **50**
- Didn't improve: clean band still **~25 RPS / ~2500 PURL/s**
- Got worse: `_none_`

**DB query analysis**
- Insights (CPU share): **~79%** vulncheck malicious-packages join · **~11%** github malware advisories join · **~3%** CD `DISTINCT ON` · **~4%** thin CVE rank + hydrate
- App latency: `cve_query` is still the spike; license is not.

**Takeaway:** license opts worked on SQL share and 50 RPS is now mostly 2xx, but the clean band is still **~25 RPS** and we die on **100** with `cve_query` L2 p90 ~2.1 s plus SQL CPU ~100%. Next lever: cut CVE ranking time per PURL and the malicious-package joins — raising pool alone will not make 100 RPS clean.
```

**Notes for newer runs**

- Prefer **`component-data-service`** in the title/env lines when that is the pod under test (`/component-data-service/api/v1/...`); use **`vulnservice`** for `/vulnservice/api/v1/...`.
- If a change was under test, put it in **What we changed** (facts) and score it in **What improved / didn't / got worse**. **Why?** stays the bottleneck, not a changelog.
- No secrets. No markdown tables in Slack.

### Other follow-ups

| Ask | Action |
|-----|--------|
| Update `read-optimisation.md` | Only if bottleneck story changed (e.g. pool done → SQL CPU → pool again) |
| Elaborate a query | Open CDS/vulnservice SQL builder; explain join/rank/`ANY`/Go post-filter |

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
- [ ] Slack (when asked): `C0BRHMF92DN` + fixed summary format, formatted per § Formatting rules
- [ ] No credentials in docs or chat


# package_info/cached load test — 2026-08-17

**Endpoint:** `POST /vulnservice/api/v1/package_info/cached?skip_cache=true`  
**Command:** `SKIP_CACHE=true ./run.sh` (script default `SKIP_CACHE=true`)  
**Env:** QA · 1× vulnservice (1→4 CPU, 8→16Gi) + canary present · Cloud SQL `db-custom-2-8192` (2 vCPU / 8 GiB, POSTGRES_17)

> Compared to 2026-08-14: connection pool headroom is higher (backends peaked at **~256**, not ~64). **DB CPU is now the cliff.**

## Capacity

| | Value |
|--|------:|
| Max RPS applied (k6 target) | **1000** |
| Max RPS that stayed healthy (2xx, ~0% 5xx) | **~200–300** |
| Break | Ramp toward **500** → VUs/latency climb; at **1000** target SQL CPU ~**100%** and 5xx ~**22%** |

At end of run: **22.9%** fail · **22.4%** 5xx · 109,501 requests · ~292 delivered RPS avg · max VUs **3,713**.

## Latency

| | Stable (~200–300 RPS) | Overall run (incl. break) |
|--|----------------------:|--------------------------:|
| p50 | ~**300–450 ms** | **305 ms** (success-only **442 ms**) |
| p95 | low / flat | **15.7 s** (success-only **16.8 s**) |
| Max | — | **30 s** (k6 timeout) |

## Stage signals (Prometheus + GCP)

| Phase | Target | Delivered RPS | 5xx | SQL backends | SQL CPU | Read |
|-------|-------:|--------------:|----:|-------------:|--------:|------|
| Hold | **200** | ~200 | **0%** | rising (~6–127) | ~13–30% | **Stable** |
| Hold | **300** | ~290–300 | **0%** | ~45–60+ | ~40–50% | **Stable** |
| Ramp | → **500** | noisy; VUs 80→~3k | starts climbing | → **256** | ~50→**80%** | Latency cliff |
| Peak | **1000** | ~570–875 attempted | → **~22%** | **~256** | **~100%** | **Broken** |

### GCP DB peaks

| Metric | Peak |
|--------|-----:|
| Cloud SQL CPU | **~99.8–100%** of 2 vCPU |
| Cloud SQL backends (`vulnerability`) | **~256** |
| Cloud SQL memory | ~**68%** |
| Pod CPU | ~**2.6 / 4** cores |
| Pod memory | ~**1.3–2.2 GiB / 16 GiB** (spike during overload) |

## RCA: why it breaks past ~300→500 RPS

### Real bottleneck: **DB CPU**

**The cliff is Cloud SQL CPU saturation (~100% on 2 vCPU). Connections are no longer the binding constraint.**

| Signal at break | Observation | Meaning |
|-----------------|-------------|---------|
| Cloud SQL CPU | **~100%** of 2 vCPU | **Primary bottleneck** |
| Cloud SQL backends | **~256** (high, but pool no longer pegged at old 64) | Connections available enough to drive CPU to the wall |
| Pod CPU | ~**2.6 / 4** | App not CPU-limited |
| Pod memory | well under 16 GiB | Not memory-bound |

**Failure chain:**

```text
skip_cache bypasses Redis
  → every request hits Postgres heavily
  → ~75% CPU on product_cves⋈cves ranking query; ~20% on clearly_defined_licenses
  → 2-vCPU Cloud SQL saturates (~100% CPU)
  → queries slow / queue on the DB
  → latency and in-flight VUs explode
  → request contexts cancel
  → CVE path returns 500 (~22% 5xx)
```

### Why this differs from 2026-08-14

| | 2026-08-14 | **2026-08-17** |
|--|------------|----------------|
| SQL backends at cliff | **~64–65** (pool pegged) | **~256** |
| SQL CPU at cliff | ~**72%** | **~100%** |
| Real bottleneck | **DB connections** | **DB CPU** |
| Healthy 2xx RPS | ~200–300 | ~200–300 (same band) |
| Break | ramp to ~500 | ramp to ~500 / 1000 target |

Raising connection headroom moved the wall from **pool wait** to **database compute**. Capacity did not meaningfully increase: healthy RPS is still ~**200–300**.

### Query Insights (GCP) — what burned the CPU

Window **05:00–06:00 UTC** (covers both morning runs). Source: Cloud Monitoring `…/insights/perquery/*` for `qa-setup:vulnerability-qa` ([console](https://console.cloud.google.com/sql/instances/vulnerability-qa/insights;duration=PT1H;sort_by=TOTAL_EXEC_TIME/executed?project=qa-setup)).

| Rank | Share of query CPU | ~execs | mean latency | rows | Query |
|-----:|-------------------:|-------:|-------------:|-----:|-------|
| 1 | **~75%** (~19.5k s) | ~145k | **~134 ms** | ~2.1M | `product_cves ⋈ cves` + `dense_rank()` provider priority, filter `product/vendor/language = ANY(...)` |
| 2 | **~20%** (~5.2k s) | ~146k | ~36 ms | ~79k | `clearly_defined_licenses` `DISTINCT ON (namespace, name)` via `unnest` |
| 3 | ~1.6% | ~146k | ~3 ms | ~44k | `clearly_defined_licenses` exact `(ns,name,version)` |
| 4 | ~1.1% | ~163k | ~1.7 ms | ~63k | `vulncheck_licenses` by ns/path/version |
| — | **≪1%** | — | — | — | Full-table `vendor_aliases` / `product_aliases` (not the CPU story) |

**Read:** ~**95%+** of DB query CPU is **CVE join (#1) + clearly-defined license lookup (#2)**. Alias table scans are cheap here. #1 is CPU-heavy (low IO vs exec time); #2 is more IO-mixed. Long tail on #1 (many multi-second executions) drives saturation on a **2-vCPU** instance.

### Amplifiers

1. **`skip_cache`** — full Postgres fan-out every request (no Redis L1).
2. **CVE `product_cves ⋈ cves` ranking query** — dominant CPU consumer (~75%).
3. **`clearly_defined_licenses` DISTINCT ON** — second place (~20%).
4. **2-vCPU Cloud SQL** — small instance for this uncached query mix.
5. **Single primary pod** — all load on one app → one DB.

### Not the bottleneck

- **App connection starvation at 64** — backends reached ~256; CPU hit first/alongside as the limiter.
- **Pod CPU / memory** — headroom at the cliff.
- **Redis** — bypassed by design.

### Bottom line

Healthy at **~200–300 RPS** with ~**300–450 ms p50**. Breaks on the ramp toward **500** / under **1000** target because **Cloud SQL CPU saturates (~100% on 2 vCPU)**. Latency then blows out, contexts cancel, and CVE-path failures become **~22% 5xx**. Connections are no longer the story — **DB CPU is**.

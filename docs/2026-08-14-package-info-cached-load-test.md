# package_info/cached load test — 2026-08-14

**Endpoint:** `POST /vulnservice/api/v1/package_info/cached?skip_cache=true`  
**Command:** `SKIP_CACHE=true ./run.sh`  
**Env:** QA · 1× vulnservice (1→4 CPU, 8→16Gi) · Cloud SQL `db-custom-2-8192` (2 vCPU / 8 GiB)

## Capacity

| | Value |
|--|------:|
| Max RPS applied (k6 target) | **1000** |
| Max RPS that stayed healthy (2xx, ~0% fail) | **~200–300** |
| App-seen peak (requests that reached the handler) | **~336** (`skip_cache` flag) |
| Break | Ramp toward **500** → fail/5xx climb; 1000 is past the cliff |

At the end of the run (includes broken stages): **19.6%** fail · **19.3%** 5xx · mostly CVE DB `context canceled` → 500.

## Latency

| | Stable (~200–300 RPS) | Overall run (incl. break) |
|--|----------------------:|--------------------------:|
| p50 | ~**300–500 ms** | **335 ms** (success-only **465 ms**) |
| p95 | low / flat | **15.5 s** (success-only **16.5 s**) |
| Max | — | **30 s** (k6 timeout) |

Postgres CVE lookup p50 stayed low until the cliff, then jumped to **~846 ms**; p90 panels flatline at **2.5 s** because that is the metric histogram bucket ceiling, not a real 2.5s timeout.

## RCA: why it breaks past ~300→500 RPS

### Real bottleneck: **DB connections**

**The cliff is Postgres connection-pool saturation, not pod CPU/mem and not SQL CPU.**

| Signal at break | Observation | Meaning |
|-----------------|-------------|---------|
| Cloud SQL backends | **64–65** (pegged) | App pool / DB connections exhausted |
| Cloud SQL CPU | ~**72%** of 2 vCPU | Busy, but **not** fully CPU-bound |
| Pod CPU | ~**2.2 / 4** cores | Headroom left |
| Pod memory | ~**700 MiB / 16 GiB** | Not memory-bound |
| CVE Postgres p50 | ms → **846 ms** | Queries waiting / slow under contention |

**Failure chain:**

```text
skip_cache bypasses Redis
  → every request fans out to many Postgres queries
  → DB connections peg at ~64
  → new queries queue for a free connection
  → latency and in-flight VUs explode
  → request contexts cancel
  → CVE path returns 500 (5xx ~19%)
```

### Why so many connections per request

`skip_cache` bypasses Redis L1 (`package_info` + `cve_query`). Each request runs
license and CVE work concurrently:

```text
request
  ├─ license branch → several Postgres reads
  └─ CVE branch
       ├─ read all vendor aliases   (every request, no shared cache)
       ├─ read all product aliases  (every request, no shared cache)
       └─ query product_cves + cves
```

Multiple round-trips × concurrent branches × rising RPS fills the pool well
before the machine is out of CPU.

### Amplifiers (not the root cause)

1. **Alias full-table reads every CVE request** — extra connection pressure.
2. **CVE query is the slowest path** — p50 hits 846 ms first once queued.
3. **2-vCPU Cloud SQL** — less headroom once connections are saturated.
4. **Single pod** — all app concurrency shares one pool toward one DB.

### Not the bottleneck

- **Redis** — deliberately bypassed (`bypass_force` only).
- **Pod CPU / memory** — clear headroom at the cliff.
- **Cloud SQL memory** — no exhaustion signal.

### Bottom line

Healthy at **~200–300 RPS**. Breaks on the ramp to **500 RPS** because
**Postgres connections are exhausted (~64)**. Everything after that (latency
spike, VU blow-up, `context canceled`, 5xx) is a consequence of that queue.

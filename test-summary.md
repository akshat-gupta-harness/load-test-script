### Suite: single-purl refresh_cache=false cold-unique (all includes)
Config
- endpoint: package_info
- batch_size: 1
- refresh_cache: false
- include_*: all (`include_latest_version`, `include_eol`, `include_dependency_graph`, `include_package_score`, `refresh_package_score=true`)
- purl_set: cold-unique (`distinct_purls.csv`, round-robin per iteration)
- warmup: none
- ramp: 1 → 2 → 5 → 10 → 20 → 50 → 100 → 500 → 1k → 5k RPS (aborted mid 100→500)
- duration_per_step: mostly 1m hold; low steps 30s–1m; high ramps 2m + 1m hold
- pods / CPU req-limit / mem: 1 pod, 1→4 CPU, 8→16Gi
- env: QA (`qa.harness.io`)

Results (at cliff)
- max_sustainable_rps: ~100 (held through 100 RPS step; peak success ~129 RPS)
- max_sustainable_purl_per_s: ~100 (×1)
- cliff_rps: ~100–180 (failed during ramp to 500; peak attempted ~176 RPS)
- latency: p50 / p95 / p99 ≈ 311 / 29900 / ~31700 ms overall at cliff; successful-only p50 / p95 ≈ 315 / 1990 ms
- error_rate: 26.8% total (18.7% 503 + 8.1% timeouts); aborted on `http_req_failed > 25%`
- timeout: 30s

Resources at peak
- CPU: ~71% of limit (~2.9 / 4 cores); request util ~285% of 1-core request
- Memory: ~1.6 Gi peak used / 16 Gi limit (~2%)
- Cloud SQL: CPU ~23% (2 reserved cores), ~16 connections, mem ~49%, disk ~84% — not connection/CPU saturated
- Redis: unknown
- deps.dev / external: unknown (no exporter); 503 + timeout mix is consistent with upstream/service saturation

Verdict
- bottleneck: unknown (not local CPU/mem/DB); likely app concurrency / upstream or gateway (503s + 30s timeouts) while pod CPU only ~71% of limit
- notes: Aborted at 14m28s/22m with 3.5k VUs and 3.5k dropped iters — arrival rate outran capacity as latency hit the timeout wall. Sustainable ceiling looks ~100 RPS for this single-PURL cold-unique config; next step is hold longer at 100/150/200 to pin the cliff and check Redis/deps.dev.

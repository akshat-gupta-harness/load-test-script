import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';

// --- Tunables (edit here) ---
const LOAD = {
  startRate: 1,
  timeUnit: '1s',
  // ~400ms latency → VUs ≈ RPS × 0.4 (plus headroom if p95 climbs)
  preAllocatedVUs: 50,
  maxVUs: 5000,
  // Ramp + hold ladder: 1 → 2 → 5 → 10 → 20 → 50 → 100 → 500 → 1000 → 5000 RPS
  stages: [
    { target: 1, duration: '30s' },
    { target: 1, duration: '1m' },
    { target: 2, duration: '30s' },
    { target: 2, duration: '1m' },
    { target: 5, duration: '1m' },
    { target: 5, duration: '1m' },
    { target: 10, duration: '1m' },
    { target: 10, duration: '1m' },
    { target: 20, duration: '1m' },
    { target: 20, duration: '1m' },
    { target: 50, duration: '1m' },
    { target: 50, duration: '1m' },
    { target: 100, duration: '1m' },
    { target: 100, duration: '1m' },
    { target: 500, duration: '2m' },
    { target: 500, duration: '1m' },
    { target: 1000, duration: '2m' },
    { target: 1000, duration: '1m' },
    { target: 5000, duration: '2m' },
    { target: 5000, duration: '1m' },
  ],
};

const THRESHOLDS = {
  http_req_failed: [
    { threshold: 'rate<0.25', abortOnFail: true, delayAbortEval: '1m' },
  ],
  status_5xx_rate: [
    { threshold: 'rate<0.25', abortOnFail: true, delayAbortEval: '1m' },
  ],
};

const REQUEST_TIMEOUT = '30s';
const DEFAULT_BASE = 'https://qa.harness.io';
const PACKAGE_INFO_PATH =
  '/vulnservice/api/v1/package_info?refresh_cache=false&include_latest_version=true&include_eol=true&include_dependency_graph=true&include_package_score=true&refresh_package_score=true';

// --- Dataset (loaded once, shared across VUs) ---
const dataset = new SharedArray('purls', function () {
  const lines = open('./distinct_purls.csv').split('\n').slice(1);
  return lines
    .filter((line) => line && line.trim())
    .map((line) => {
      const i = line.indexOf(',');
      return line.slice(i + 1).replace(/^"|"$/g, '');
    });
});

const status2xx = new Counter('status_2xx');
const status4xx = new Counter('status_4xx');
const status5xx = new Counter('status_5xx');
const status5xxRate = new Rate('status_5xx_rate');

export const options = {
  scenarios: {
    ramping_stress_test: {
      executor: 'ramping-arrival-rate',
      startRate: LOAD.startRate,
      timeUnit: LOAD.timeUnit,
      preAllocatedVUs: LOAD.preAllocatedVUs,
      maxVUs: LOAD.maxVUs,
      stages: LOAD.stages,
    },
  },
  thresholds: THRESHOLDS,
  summaryTrendStats: ['p(50)', 'p(95)', 'avg', 'min', 'max'],
};

export default function () {
  const apiKey = __ENV.HARNESS_API_KEY;
  if (!apiKey) {
    throw new Error('HARNESS_API_KEY env var is required');
  }

  const base = (__ENV.BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const index = exec.scenario.iterationInTest % dataset.length;
  const purl = dataset[index];

  const res = http.post(
    `${base}${PACKAGE_INFO_PATH}`,
    JSON.stringify({ purls: [purl] }),
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'x-api-key': apiKey,
      },
      timeout: REQUEST_TIMEOUT,
    }
  );

  if (res.status >= 200 && res.status < 300) {
    status2xx.add(1);
    status5xxRate.add(false);
  } else if (res.status >= 400 && res.status < 500) {
    status4xx.add(1);
    status5xxRate.add(false);
  } else if (res.status >= 500 && res.status < 600) {
    status5xx.add(1);
    status5xxRate.add(true);
  } else {
    // timeouts / 0 / 3xx — count toward fail path but not 5xx rate
    status5xxRate.add(false);
  }
}

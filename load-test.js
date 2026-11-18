import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';

// --- Tunables (edit here) ---
// No-flags + warm cache clears 300 RPS easily — skip fine steps below that and
// climb to 5k. PROFILE=focus stays denser around 300–1000 for the next knee.
// PROFILE=batch100: 100 PURLs/POST, slow climb that stops at 500.
const PROFILES = {
  full: {
    stages: [
      { target: 200, duration: '30s' },
      { target: 200, duration: '30s' },
      { target: 300, duration: '30s' },
      { target: 300, duration: '30s' },
      { target: 500, duration: '30s' },
      { target: 500, duration: '45s' },
      { target: 1000, duration: '45s' },
      { target: 1000, duration: '1m' },
      { target: 1500, duration: '45s' },
      { target: 1500, duration: '1m' },
      { target: 2000, duration: '45s' },
      { target: 2000, duration: '1m' },
      { target: 3000, duration: '45s' },
      { target: 3000, duration: '1m' },
    ],
  },
  focus: {
    stages: [
      { target: 300, duration: '30s' },
      { target: 300, duration: '30s' },
      { target: 500, duration: '30s' },
      { target: 500, duration: '45s' },
      { target: 750, duration: '30s' },
      { target: 750, duration: '45s' },
      { target: 1000, duration: '45s' },
      { target: 1000, duration: '45s' },
    ],
  },
  // 1 PURL/POST, 5s ramp then 1m hold at each step.
  step: {
    stages: [10, 25, 50, 100, 150, 200, 300, 400, 500, 750, 1000].flatMap((t) => [
      { target: t, duration: '5s' },
      { target: t, duration: '1m' },
    ]),
  },
  // Slower climb: 1 PURL/POST, 10s ramp then 1m hold per step.
  slow: {
    stages: [10, 20, 30, 40, 50, 75, 100, 125, 150, 175, 200, 250, 300, 400, 500].flatMap((t) => [
      { target: t, duration: '10s' },
      { target: t, duration: '1m' },
    ]),
  },
  batch100: {
    batchSize: 100,
    stages: [
      { target: 10, duration: '30s' },
      { target: 10, duration: '45s' },
      { target: 25, duration: '30s' },
      { target: 25, duration: '45s' },
      { target: 50, duration: '30s' },
      { target: 50, duration: '1m' },
      { target: 100, duration: '45s' },
      { target: 100, duration: '1m' },
      { target: 150, duration: '45s' },
      { target: 150, duration: '1m' },
      { target: 200, duration: '45s' },
      { target: 200, duration: '1m' },
      { target: 300, duration: '45s' },
      { target: 300, duration: '1m' },
      { target: 400, duration: '45s' },
      { target: 400, duration: '1m' },
      { target: 500, duration: '45s' },
      { target: 500, duration: '2m' },
    ],
  },
};

const PROFILE = __ENV.PROFILE || 'full';
if (!PROFILES[PROFILE]) {
  throw new Error(`unknown PROFILE '${PROFILE}' (expected: ${Object.keys(PROFILES).join(', ')})`);
}

const profile = PROFILES[PROFILE];
const BATCH_SIZE = Math.max(
  1,
  Number(__ENV.BATCH_SIZE || profile.batchSize || 1) || 1
);

const LOAD = {
  startRate: 1,
  timeUnit: '1s',
  // skip_cache p95 can hit multi-seconds past 1k — need VU headroom.
  preAllocatedVUs: 2000,
  maxVUs: 10000,
  stages: profile.stages,
};

// A request counts as failed only after this client deadline. k6 does not
// queue: if every VU is busy, the iteration is dropped and is not a timeout.
// Abort only once 75% of requests fail, so a client-side timeout pile-up
// does not stop the ramp early.
const THRESHOLDS = {
  http_req_failed: [
    { threshold: 'rate<0.75', abortOnFail: true, delayAbortEval: '1m' },
  ],
  status_5xx_rate: [
    { threshold: 'rate<0.75', abortOnFail: true, delayAbortEval: '1m' },
  ],
};

const REQUEST_TIMEOUT = '5m';
const DEFAULT_BASE = 'https://qa.harness.io';

// The server reads these with url.Query().Has(name), so a param counts as ON by
// presence alone — `refresh_cache=false` still forces a refresh. A disabled flag
// must therefore be left out of the URL entirely.
function envFlag(name, fallback) {
  const v = __ENV[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

// Defaults off: server treats presence as true, so omit to disable.
const FLAGS = {
  refresh_cache: envFlag('REFRESH_CACHE', false),
  include_latest_version: envFlag('INCLUDE_LATEST_VERSION', false),
  include_eol: envFlag('INCLUDE_EOL', false),
  include_dependency_graph: envFlag('INCLUDE_DEPENDENCY_GRAPH', false),
  include_package_score: envFlag('INCLUDE_PACKAGE_SCORE', false),
  refresh_package_score: envFlag('REFRESH_PACKAGE_SCORE', false),
  skip_cache: envFlag('SKIP_CACHE', false),
};

const enabledFlags = Object.keys(FLAGS).filter((k) => FLAGS[k]);
// QA gateway: /component-data-service/api/v1/... ; local server: /api/v1/...
const API_PATH = (__ENV.API_PATH || '/component-data-service/api/v1/package_info/cached').replace(
  /\?.*$/,
  ''
);
const PACKAGE_INFO_PATH =
  API_PATH +
  (enabledFlags.length ? `?${enabledFlags.map((k) => `${k}=true`).join('&')}` : '');

// Walk the CSV from the end so this run hits PURLs that prior forward runs
// never warmed in Redis.
const REVERSE_PURLS = envFlag('REVERSE_PURLS', false);

// DATASET=maven reads ./datasets/maven.csv. Unset uses the mixed distinct_purls.csv.
function datasetFile() {
  const name = (__ENV.DATASET || '').trim();
  if (!name || name === 'all') return './distinct_purls.csv';
  if (name.includes('/')) return name;
  return `./datasets/${name.endsWith('.csv') ? name : `${name}.csv`}`;
}

const DATASET_FILE = datasetFile();

// --- Dataset (loaded once, shared across VUs) ---
const dataset = new SharedArray('purls', function () {
  const lines = open(DATASET_FILE).split(/\r?\n/).slice(1);
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
// Per-PURL coverage in 2xx responses (rate = % of returned items that have it).
const hasLatestVersion = new Rate('purl_has_latest_version');
const hasDependencyGraph = new Rate('purl_has_dependency_graph');
const hasEol = new Rate('purl_has_eol');

function nonEmpty(v) {
  if (Array.isArray(v)) return v.length > 0;
  return !!v && (typeof v !== 'object' || Object.keys(v).length > 0);
}

function ecosystemOf(purl) {
  const m = /^pkg:\/*([^/@?#]+)/i.exec(purl || '');
  return m ? m[1].toLowerCase() : 'unknown';
}

// Empty-bound thresholds exist only so k6 prints each ecosystem's sub-metric in the summary.
// SharedArray so the 276k-row scan runs once, not in every VU's init.
const ECOSYSTEMS = new SharedArray('ecosystems', () =>
  Array.from(new Set(dataset.map(ecosystemOf))).concat('unknown')
);
const COVERAGE_THRESHOLDS = {};
for (const eco of ECOSYSTEMS) {
  COVERAGE_THRESHOLDS[`purl_has_latest_version{ecosystem:${eco}}`] = ['rate>=0'];
  COVERAGE_THRESHOLDS[`purl_has_dependency_graph{ecosystem:${eco}}`] = ['rate>=0'];
  COVERAGE_THRESHOLDS[`purl_has_eol{ecosystem:${eco}}`] = ['rate>=0'];
}

function trackCoverage(res) {
  let items;
  try {
    items = res.json();
  } catch (e) {
    return;
  }
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const g = item.dependencyGraph || {};
    const tags = { ecosystem: ecosystemOf(item.purl) };
    hasLatestVersion.add(nonEmpty(item.latestVersion), tags);
    hasDependencyGraph.add(nonEmpty(g.nodes) || nonEmpty(g.edges), tags);
    hasEol.add(nonEmpty(item.eolDetails), tags);
  }
}

export const options = {
  scenarios: {
    ramping_stress_test: {
      executor: 'ramping-arrival-rate',
      startRate: LOAD.startRate,
      timeUnit: LOAD.timeUnit,
      preAllocatedVUs: LOAD.preAllocatedVUs,
      maxVUs: LOAD.maxVUs,
      stages: LOAD.stages,
      // Match the HTTP timeout so the scenario end does not cancel in-flight calls at 30s.
      gracefulStop: REQUEST_TIMEOUT,
    },
  },
  thresholds: { ...THRESHOLDS, ...COVERAGE_THRESHOLDS },
  summaryTrendStats: ['p(50)', 'p(95)', 'avg', 'min', 'max'],
};

// Echoes the resolved config once per run so a comparison run can be trusted
// to actually differ from its baseline.
export function setup() {
  const base = (__ENV.BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  console.log(
    `base=${base} profile=${PROFILE} batch_size=${BATCH_SIZE} dataset=${DATASET_FILE} purls=${dataset.length} path=${PACKAGE_INFO_PATH} reverse_purls=${REVERSE_PURLS} timeout=${REQUEST_TIMEOUT}`
  );
}

export default function () {
  const apiKey = __ENV.HARNESS_API_KEY;
  if (!apiKey) {
    throw new Error('HARNESS_API_KEY env var is required');
  }

  const base = (__ENV.BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const start = (exec.scenario.iterationInTest * BATCH_SIZE) % dataset.length;
  const purls = new Array(BATCH_SIZE);
  for (let j = 0; j < BATCH_SIZE; j++) {
    const i = (start + j) % dataset.length;
    purls[j] = REVERSE_PURLS ? dataset[dataset.length - 1 - i] : dataset[i];
  }

  const res = http.post(
    `${base}${PACKAGE_INFO_PATH}`,
    JSON.stringify({ purls }),
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
    if (['include_latest_version', 'include_eol', 'include_dependency_graph'].some((f) => enabledFlags.includes(f))) {
      trackCoverage(res);
    }
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

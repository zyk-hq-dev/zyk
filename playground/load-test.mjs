/**
 * Zyk Playground Load Test
 * Tests key endpoints under concurrent load without hitting Anthropic API
 * Usage: node load-test.mjs [base_url] [concurrency] [duration_seconds]
 */

const BASE_URL = process.argv[2] ?? "https://zyk.dev";
const CONCURRENCY = parseInt(process.argv[3] ?? "20", 10);
const DURATION_S  = parseInt(process.argv[4] ?? "30", 10);

// ─── helpers ────────────────────────────────────────────────────────────────

function now() { return Date.now(); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const stats = {};

function record(name, durationMs, ok) {
  if (!stats[name]) stats[name] = { total: 0, ok: 0, fail: 0, latencies: [] };
  stats[name].total++;
  stats[name][ok ? "ok" : "fail"]++;
  stats[name].latencies.push(durationMs);
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printReport() {
  console.log("\n─── Load Test Report ───────────────────────────────────");
  console.log(`Target: ${BASE_URL}  |  Concurrency: ${CONCURRENCY}  |  Duration: ${DURATION_S}s\n`);

  for (const [name, s] of Object.entries(stats)) {
    const p50  = percentile(s.latencies, 50).toFixed(0);
    const p95  = percentile(s.latencies, 95).toFixed(0);
    const p99  = percentile(s.latencies, 99).toFixed(0);
    const rps  = (s.total / DURATION_S).toFixed(1);
    const pct  = ((s.ok / s.total) * 100).toFixed(1);
    console.log(`${name}`);
    console.log(`  Requests: ${s.total}  |  OK: ${s.ok} (${pct}%)  |  Fail: ${s.fail}  |  RPS: ${rps}`);
    console.log(`  Latency p50: ${p50}ms  p95: ${p95}ms  p99: ${p99}ms`);
    console.log();
  }
}

// ─── test scenarios ─────────────────────────────────────────────────────────

// A fake sessionId — reads workflows for a non-existent session (fast, DB-safe)
const FAKE_SESSION = "load-test-00000000";

async function testHomePage() {
  const t = now();
  try {
    const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(10_000) });
    record("GET /", now() - t, res.ok);
  } catch {
    record("GET /", now() - t, false);
  }
}

async function testWorkflows() {
  const t = now();
  try {
    const res = await fetch(`${BASE_URL}/api/workflows?sessionId=${FAKE_SESSION}`, {
      signal: AbortSignal.timeout(10_000),
    });
    // 200 with empty list is fine
    record("GET /api/workflows", now() - t, res.status < 500);
  } catch {
    record("GET /api/workflows", now() - t, false);
  }
}

async function testRuns() {
  const t = now();
  try {
    const res = await fetch(
      `${BASE_URL}/api/runs?sessionId=${FAKE_SESSION}&limit=10&since_hours=1`,
      { signal: AbortSignal.timeout(10_000) }
    );
    record("GET /api/runs", now() - t, res.status < 500);
  } catch {
    record("GET /api/runs", now() - t, false);
  }
}

// SSE: connect, read first byte, disconnect — tests SSE handler overhead
async function testSSE() {
  const t = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000); // hold for up to 3s
  try {
    const res = await fetch(`${BASE_URL}/api/events?sessionId=${FAKE_SESSION}`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      // read one chunk then disconnect
      await reader.read();
      reader.cancel();
    }
    record("GET /api/events (SSE)", now() - t, res.ok);
  } catch (e) {
    // AbortError from our timer is expected
    record("GET /api/events (SSE)", now() - t, e.name === "AbortError");
  } finally {
    clearTimeout(timer);
  }
}

async function testSlackPending() {
  const t = now();
  const fakeId = `load-test-${Math.random().toString(36).slice(2)}`;
  try {
    const res = await fetch(`${BASE_URL}/api/slack/pending/${fakeId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    // Should return { pending: true } — any 2xx is fine
    record("GET /api/slack/pending/:id", now() - t, res.ok);
  } catch {
    record("GET /api/slack/pending/:id", now() - t, false);
  }
}

// ─── worker loop ─────────────────────────────────────────────────────────────

const scenarios = [
  { weight: 3, fn: testHomePage },
  { weight: 3, fn: testWorkflows },
  { weight: 2, fn: testRuns },
  { weight: 1, fn: testSSE },
  { weight: 1, fn: testSlackPending },
];

// Build weighted array
const weightedScenarios = scenarios.flatMap(s => Array(s.weight).fill(s.fn));

async function worker(endAt) {
  while (now() < endAt) {
    const fn = weightedScenarios[Math.floor(Math.random() * weightedScenarios.length)];
    await fn();
    // small jitter to spread load
    await sleep(Math.random() * 50);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nZyk Playground Load Test`);
  console.log(`Target:      ${BASE_URL}`);
  console.log(`Concurrency: ${CONCURRENCY} workers`);
  console.log(`Duration:    ${DURATION_S}s`);
  console.log(`\nStarting...\n`);

  // warm-up
  await testHomePage();
  console.log("Warm-up done. Running test...");

  const endAt = now() + DURATION_S * 1000;

  // progress indicator
  const progressInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((endAt - now()) / 1000));
    const totals = Object.values(stats).reduce((a, s) => a + s.total, 0);
    process.stdout.write(`\r  ${remaining}s remaining | ${totals} requests completed   `);
  }, 1000);

  // launch workers
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(endAt)));
  clearInterval(progressInterval);

  process.stdout.write("\n");
  printReport();
}

main().catch(e => { console.error(e); process.exit(1); });

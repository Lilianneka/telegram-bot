/**
 * Metrics unit tests.
 *
 * No live network calls, no Testnet RPC, no Telegram credentials.
 */

import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";

import { createMetrics } from "../dist/metrics.js";

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

async function httpRequest(method, url) {
  const { request } = await import("node:http");
  const { hostname, port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const r = request(
      { hostname, port: Number(port), path: pathname, method },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

test("counter: starts at zero", () => {
  const m = createMetrics();
  assert.equal(m.pollCycles.value(), 0);
  assert.equal(m.rpcRequests.value(), 0);
  assert.equal(m.rpcErrors.value(), 0);
  assert.equal(m.eventsDecoded.value(), 0);
  assert.equal(m.eventsSkipped.value(), 0);
  assert.equal(m.notificationsSent.value(), 0);
  assert.equal(m.notificationsFailed.value(), 0);
  assert.equal(m.staleCursorEvents.value(), 0);
});

test("counter: inc() increments by 1", () => {
  const m = createMetrics();
  m.pollCycles.inc();
  assert.equal(m.pollCycles.value(), 1);
  m.pollCycles.inc();
  assert.equal(m.pollCycles.value(), 2);
});

test("counter: inc(n) increments by n", () => {
  const m = createMetrics();
  m.rpcRequests.inc(5);
  assert.equal(m.rpcRequests.value(), 5);
  m.rpcRequests.inc(3);
  assert.equal(m.rpcRequests.value(), 8);
});

test("counter: inc(0) is a no-op", () => {
  const m = createMetrics();
  m.eventsDecoded.inc(0);
  assert.equal(m.eventsDecoded.value(), 0);
});

test("counter: inc(-1) throws RangeError", () => {
  const m = createMetrics();
  assert.throws(() => m.pollCycles.inc(-1), /RangeError|delta must be/);
});

test("counter: multiple counters are independent", () => {
  const m = createMetrics();
  m.pollCycles.inc();
  m.rpcRequests.inc(3);
  assert.equal(m.pollCycles.value(), 1);
  assert.equal(m.rpcRequests.value(), 3);
  assert.equal(m.eventsDecoded.value(), 0);
});

test("gauge: starts at zero", () => {
  const m = createMetrics();
  assert.equal(m.consecutiveFailures.value(), 0);
});

test("gauge: set() updates the value", () => {
  const m = createMetrics();
  m.consecutiveFailures.set(5);
  assert.equal(m.consecutiveFailures.value(), 5);
  m.consecutiveFailures.set(0);
  assert.equal(m.consecutiveFailures.value(), 0);
});

test("gauge: can decrease (unlike a counter)", () => {
  const m = createMetrics();
  m.consecutiveFailures.set(10);
  m.consecutiveFailures.set(3);
  assert.equal(m.consecutiveFailures.value(), 3);
});

test("activity baseline: gauges start at zero and can be updated independently", () => {
  const m = createMetrics();
  assert.equal(m.lastCycleEvents.value(), 0);
  assert.equal(m.activityBaselineEvents.value(), 0);
  assert.equal(m.activityAnomalies.value(), 0);

  m.lastCycleEvents.set(7);
  m.activityBaselineEvents.set(4);
  m.activityAnomalies.inc();

  assert.equal(m.lastCycleEvents.value(), 7);
  assert.equal(m.activityBaselineEvents.value(), 4);
  assert.equal(m.activityAnomalies.value(), 1);
});

test("activity baseline: rendered metrics expose the last count and baseline", () => {
  const m = createMetrics();
  m.lastCycleEvents.set(12);
  m.activityBaselineEvents.set(5);
  m.activityAnomalies.inc(2);

  const output = m.render();
  assert.ok(output.includes("# TYPE mimir_bot_last_cycle_events gauge"), output);
  assert.ok(output.includes("mimir_bot_last_cycle_events 12"), output);
  assert.ok(output.includes("# TYPE mimir_bot_activity_baseline_events gauge"), output);
  assert.ok(output.includes("mimir_bot_activity_baseline_events 5"), output);
  assert.ok(output.includes("# TYPE mimir_bot_activity_anomalies_total counter"), output);
  assert.ok(output.includes("mimir_bot_activity_anomalies_total 2"), output);
});

test("render: output ends with a newline", () => {
  const m = createMetrics();
  const output = m.render();
  assert.ok(output.endsWith("\n"), "Prometheus output must end with a newline");
});

test("render: contains all expected metric names", () => {
  const m = createMetrics();
  const output = m.render();

  const expectedNames = [
    "mimir_bot_poll_cycles_total",
    "mimir_bot_rpc_requests_total",
    "mimir_bot_rpc_errors_total",
    "mimir_bot_events_decoded_total",
    "mimir_bot_events_skipped_total",
    "mimir_bot_notifications_sent_total",
    "mimir_bot_notifications_failed_total",
    "mimir_bot_stale_cursor_events_total",
    "mimir_bot_consecutive_failures",
    "mimir_bot_last_cycle_events",
    "mimir_bot_activity_baseline_events",
    "mimir_bot_activity_anomalies_total",
  ];

  for (const name of expectedNames) {
    assert.ok(output.includes(name), `Missing metric: ${name}`);
  }
});

test("render: counters have # TYPE counter", () => {
  const m = createMetrics();
  const output = m.render();
  assert.ok(
    output.includes("# TYPE mimir_bot_poll_cycles_total counter"),
    "Missing TYPE counter for poll_cycles_total",
  );
  assert.ok(
    output.includes("# TYPE mimir_bot_notifications_sent_total counter"),
    "Missing TYPE counter for notifications_sent_total",
  );
});

test("render: gauge has # TYPE gauge", () => {
  const m = createMetrics();
  const output = m.render();
  assert.ok(
    output.includes("# TYPE mimir_bot_consecutive_failures gauge"),
    "Missing TYPE gauge for consecutive_failures",
  );
});

test("render: contains # HELP lines", () => {
  const m = createMetrics();
  const output = m.render();
  assert.ok(output.includes("# HELP mimir_bot_poll_cycles_total"), "Missing HELP for poll_cycles_total");
  assert.ok(output.includes("# HELP mimir_bot_consecutive_failures"), "Missing HELP for consecutive_failures");
});

test("render: initial all-zero values are present", () => {
  const m = createMetrics();
  const output = m.render();
  assert.ok(output.includes("mimir_bot_poll_cycles_total 0"), "Expected poll_cycles_total 0");
  assert.ok(output.includes("mimir_bot_consecutive_failures 0"), "Expected consecutive_failures 0");
});

test("render: incremented counter values appear in output", () => {
  const m = createMetrics();
  m.pollCycles.inc();
  m.pollCycles.inc();
  m.notificationsSent.inc(7);
  m.consecutiveFailures.set(3);

  const output = m.render();
  assert.ok(output.includes("mimir_bot_poll_cycles_total 2"), `output: ${output}`);
  assert.ok(output.includes("mimir_bot_notifications_sent_total 7"), `output: ${output}`);
  assert.ok(output.includes("mimir_bot_consecutive_failures 3"), `output: ${output}`);
});

test("render: multiple registries are independent", () => {
  const m1 = createMetrics();
  const m2 = createMetrics();
  m1.pollCycles.inc();
  assert.equal(m1.pollCycles.value(), 1);
  assert.equal(m2.pollCycles.value(), 0);
});

test("dropped samples: NaN and Infinity are counted and never rendered", () => {
  const m = createMetrics();
  m.consecutiveFailures.set(Number.NaN);
  m.consecutiveFailures.set(Number.POSITIVE_INFINITY);
  m.consecutiveFailures.set(Number.NEGATIVE_INFINITY);

  const output = m.render();
  assert.ok(!/NaN|Infinity/.test(output), `non-finite value leaked:\n${output}`);
  assert.ok(output.includes('mimir_bot_dropped_samples_total{reason="invalid_number"} 3'), output);
  assert.equal(m.consecutiveFailures.value(), 0);
});

test("dropped samples: unknown labels are counted under a bounded reason", () => {
  const m = createMetrics();
  m.recordDropped("unknown_label");
  m.recordDropped("unknown_label");
  const output = m.render();
  assert.ok(output.includes('mimir_bot_dropped_samples_total{reason="unknown_label"} 2'), output);
});

test("dropped samples: finite values are unaffected", () => {
  const m = createMetrics();
  m.consecutiveFailures.set(4);
  assert.equal(m.consecutiveFailures.value(), 4);
  assert.ok(!m.render().includes('reason="invalid_number"} 1'));
});

test("server: GET /metrics returns 200 with correct content-type", async () => {
  const m = createMetrics();
  const srv = await m.startServer(0);
  try {
    const res = await httpGet(`http://127.0.0.1:${srv.port}/metrics`);
    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
    assert.ok(
      res.headers["content-type"]?.includes("text/plain"),
      `Expected text/plain content-type; got ${res.headers["content-type"]}`,
    );
  } finally {
    await srv.close();
  }
});

test("server: GET /metrics returns Prometheus exposition format body", async () => {
  const m = createMetrics();
  m.pollCycles.inc(4);
  const srv = await m.startServer(0);
  try {
    const res = await httpGet(`http://127.0.0.1:${srv.port}/metrics`);
    assert.ok(res.body.includes("mimir_bot_poll_cycles_total 4"), `body: ${res.body}`);
    assert.ok(res.body.includes("# TYPE"), `Missing # TYPE lines; body: ${res.body}`);
    assert.ok(res.body.includes("# HELP"), `Missing # HELP lines; body: ${res.body}`);
  } finally {
    await srv.close();
  }
});

test("server: GET /health returns 200 OK", async () => {
  const m = createMetrics();
  const srv = await m.startServer(0);
  try {
    const res = await httpGet(`http://127.0.0.1:${srv.port}/health`);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("OK"), `Expected OK body; got ${res.body}`);
  } finally {
    await srv.close();
  }
});

test("server: unknown path returns 404", async () => {
  const m = createMetrics();
  const srv = await m.startServer(0);
  try {
    const res = await httpGet(`http://127.0.0.1:${srv.port}/unknown`);
    assert.equal(res.statusCode, 404);
  } finally {
    await srv.close();
  }
});

test("server: GET /metrics with query string returns 200 (query string is ignored)", async () => {
  const m = createMetrics();
  const srv = await m.startServer(0);
  try {
    const res = await httpGet(`http://127.0.0.1:${srv.port}/metrics?debug=1`);
    assert.equal(res.statusCode, 200);
  } finally {
    await srv.close();
  }
});

test("server: non-GET method returns 405", async () => {
  const m = createMetrics();
  const srv = await m.startServer(0);
  try {
    const res = await httpRequest("POST", `http://127.0.0.1:${srv.port}/metrics`);
    assert.equal(res.statusCode, 405, `Expected 405 for POST; got ${res.statusCode}`);
  } finally {
    await srv.close();
  }
});

test("server: /metrics response includes Cache-Control: no-store", async () => {
  const m = createMetrics();
  const srv = await m.startServer(0);
  try {
    const res = await httpGet(`http://127.0.0.1:${srv.port}/metrics`);
    assert.ok(
      res.headers["cache-control"]?.includes("no-store"),
      `Expected no-store; got ${res.headers["cache-control"]}`,
    );
  } finally {
    await srv.close();
  }
});

test("server: live counter updates are reflected in subsequent /metrics responses", async () => {
  const m = createMetrics();
  const srv = await m.startServer(0);
  try {
    const before = await httpGet(`http://127.0.0.1:${srv.port}/metrics`);
    assert.ok(before.body.includes("mimir_bot_rpc_errors_total 0"), `before: ${before.body}`);

    m.rpcErrors.inc(3);

    const after = await httpGet(`http://127.0.0.1:${srv.port}/metrics`);
    assert.ok(after.body.includes("mimir_bot_rpc_errors_total 3"), `after: ${after.body}`);
  } finally {
    await srv.close();
  }
});

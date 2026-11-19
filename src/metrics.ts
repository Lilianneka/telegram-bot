/**
 * Minimal in-process Prometheus-compatible metrics registry and HTTP server.
 *
 * Design constraints:
 *  - Zero external dependencies. Uses Node's built-in `node:http`.
 *  - Optional: the server is started only when `METRICS_PORT` is set.
 *  - Counters only increment (never reset), so a Prometheus server scraping
 *    them can derive rates with `rate()` / `increase()` reliably.
 *  - Gauges represent momentary state (e.g. consecutive_failures) that can
 *    go up or down.
 *  - The output format is Prometheus text exposition v0.0.4, which every
 *    current Prometheus/OpenMetrics scraper understands.
 *  - Secrets: the /metrics response carries only operational counters derived
 *    from in-process state. It never echoes env vars, bot tokens, or cursor
 *    file contents.
 *
 * Usage:
 *   const metrics = createMetrics();
 *   metrics.pollCycles.inc();
 *   metrics.notificationsSent.inc();
 *   const { close } = await metrics.startServer(9090);
 *   // on shutdown:
 *   await close();
 *
 * Pass a validation failure reason to `metrics.droppedSamples.inc("<reason>")`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// ── Metric types ──────────────────────────────────────────────────────────────

export interface Counter {
  /** Increment by 1 (default) or by `delta` (must be ≥ 0). */
  inc(delta?: number): void;
  /** Current value. */
  value(): number;
}

/**
 * Bounded-cardinality counter keyed by a fixed set of reason labels.
 * Unknown labels are folded into `unknown` so Prometheus cardinality stays bounded.
 */
export interface LabeledCounter {
  /** Increment the counter for `reason` (default 1). Unknown reasons map to "unknown". */
  inc(reason: string, delta?: number): void;
  /** Current value for a reason label. */
  value(reason: string): number;
}

/** Fixed set of reasons a metric sample can be dropped. Bounded for cardinality safety. */
export const DROP_REASONS = [
  "invalid_number",
  "unknown_label",
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

export interface Gauge {
  /** Set to `value`. */
  set(value: number): void;
  /** Current value. */
  value(): number;
}

/** A running HTTP server returned by {@link MetricsRegistry.startServer}. */
export interface MetricsServer {
  /** The port the server is actually listening on. */
  port: number;
  /** Gracefully close the server. Resolves when the socket is released. */
  close(): Promise<void>;
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * All metrics exposed at GET /metrics.
 *
 * Naming follows Prometheus conventions:
 *  - `_total` suffix for counters
 *  - `_gauge` suffix / no suffix for gauges
 *  - snake_case throughout
 *  - prefix `mimir_bot_` to avoid collisions in a shared Prometheus instance
 */
export interface MetricsRegistry {
  /** Total poll cycles started (one per POLL_INTERVAL_MS tick). */
  pollCycles: Counter;
  /** Total successful Soroban RPC calls (one per target per cycle on success). */
  rpcRequests: Counter;
  /** Total failed Soroban RPC calls. */
  rpcErrors: Counter;
  /** Total events returned by the RPC and handed to the decoder. */
  eventsDecoded: Counter;
  /** Total events the decoder handed back with payload.name === "unknown", plus
   *  those dropped by the MAX_NOTIFICATIONS_PER_CYCLE cap. */
  eventsSkipped: Counter;
  /** Total Telegram messages successfully sent. */
  notificationsSent: Counter;
  /** Total Telegram sends that threw (the cursor still advances). */
  notificationsFailed: Counter;
  /** Number of times a stale-cursor warning was emitted this process lifetime. */
  staleCursorEvents: Counter;
  /** Current count of consecutive full-cycle failures (gauge: resets to 0 on
   *  any success). */
  consecutiveFailures: Gauge;
  /** Events observed in the most recent complete poll cycle. */
  lastCycleEvents: Gauge;
  /** Rolling mean events per cycle at the most recent baseline comparison,
   *  rounded to a whole event. */
  activityBaselineEvents: Gauge;
  /** Complete cycles classified as a spike or drop against the rolling
   *  activity baseline. */
  activityAnomalies: Counter;
  /**
   * Samples dropped before exposure, labelled by bounded reason
   * (`invalid_number`, `unknown_label`, or `unknown`).
   */
  droppedSamples: LabeledCounter;
  /** Record a numeric sample for a gauge; non-finite values are dropped and counted. */
  setGaugeSafe(gauge: Gauge, value: number): void;

  /**
   * Render the registry as a Prometheus text exposition string.
   * Includes HELP and TYPE comment lines so Prometheus autodiscovery works.
   */
  render(): string;

  /**
   * Start an HTTP server on `port` that serves GET /metrics.
   *
   * Also serves GET /health (returns `200 OK\n`) as a minimal liveness probe.
   * Any other method or path returns 404.
   *
   * The server binds to 127.0.0.1 by default so it is not exposed to the
   * network without an explicit proxy. On a Docker host set METRICS_HOST or
   * bind via the compose port mapping instead.
   *
   * @param port TCP port (1–65535). Caller is responsible for validating this
   *             before calling startServer (see config.ts).
   * @param host Bind address (default: "127.0.0.1").
   */
  startServer(port: number, host?: string): Promise<MetricsServer>;
}

// ── Implementation ────────────────────────────────────────────────────────────

function makeCounter(name: string, help: string): Counter & { _name: string; _help: string } {
  let _value = 0;
  return {
    _name: name,
    _help: help,
    inc(delta = 1): void {
      if (delta < 0) throw new RangeError(`Counter.inc delta must be >= 0; got ${delta}`);
      _value += delta;
    },
    value(): number {
      return _value;
    },
  };
}

function makeGauge(name: string, help: string): Gauge & { _name: string; _help: string } {
  let _value = 0;
  return {
    _name: name,
    _help: help,
    set(value: number): void {
      _value = value;
    },
    value(): number {
      return _value;
    },
  };
}

const METRICS_PREFIX = "mimir_bot_";

function makeLabeledCounter(name: string, help: string, labels: readonly string[]): LabeledCounter & { _name: string; _help: string; _labels: readonly string[]; _entries(): [string, number][] } {
  const values = new Map<string, number>(labels.map((l) => [l, 0]));
  const known = new Set<string>(labels);
  return {
    _name: name,
    _help: help,
    _labels: labels,
    inc(reason: string, delta = 1): void {
      if (delta < 0) throw new RangeError(`LabeledCounter.inc delta must be >= 0; got ${delta}`);
      const key = known.has(reason) ? reason : "unknown";
      values.set(key, (values.get(key) ?? 0) + delta);
    },
    value(reason: string): number {
      return values.get(known.has(reason) ? reason : "unknown") ?? 0;
    },
    _entries(): [string, number][] {
      return [...values.entries()];
    },
  };
}

export function createMetrics(): MetricsRegistry {
  const pollCycles = makeCounter(
    `${METRICS_PREFIX}poll_cycles_total`,
    "Total number of poll cycles started.",
  );
  const rpcRequests = makeCounter(
    `${METRICS_PREFIX}rpc_requests_total`,
    "Total successful Soroban RPC getEvents calls.",
  );
  const rpcErrors = makeCounter(
    `${METRICS_PREFIX}rpc_errors_total`,
    "Total failed Soroban RPC getEvents calls.",
  );
  const eventsDecoded = makeCounter(
    `${METRICS_PREFIX}events_decoded_total`,
    "Total on-chain events returned by the RPC and passed through the decoder.",
  );
  const eventsSkipped = makeCounter(
    `${METRICS_PREFIX}events_skipped_total`,
    "Total events not notified: unknown type, no formatter, or MAX_NOTIFICATIONS_PER_CYCLE cap.",
  );
  const notificationsSent = makeCounter(
    `${METRICS_PREFIX}notifications_sent_total`,
    "Total Telegram messages successfully sent.",
  );
  const notificationsFailed = makeCounter(
    `${METRICS_PREFIX}notifications_failed_total`,
    "Total Telegram sends that threw an error (cursor still advanced).",
  );
  const staleCursorEvents = makeCounter(
    `${METRICS_PREFIX}stale_cursor_events_total`,
    "Number of times a stale-cursor warning was emitted (events in the gap are lost).",
  );
  const consecutiveFailures = makeGauge(
    `${METRICS_PREFIX}consecutive_failures`,
    "Current number of consecutive full-cycle RPC failures (resets to 0 on any success).",
  );
  const lastCycleEvents = makeGauge(
    `${METRICS_PREFIX}last_cycle_events`,
    "Events observed in the most recent complete poll cycle.",
  );
  const activityBaselineEvents = makeGauge(
    `${METRICS_PREFIX}activity_baseline_events`,
    "Rolling mean events per cycle at the most recent baseline comparison (rounded).",
  );
  const activityAnomalies = makeCounter(
    `${METRICS_PREFIX}activity_anomalies_total`,
    "Complete poll cycles classified as a spike or drop against the rolling activity baseline.",
  );
  const droppedSamples = makeLabeledCounter(
    `${METRICS_PREFIX}dropped_samples_total`,
    "Metric samples dropped before exposure, by bounded reason.",
    [...DROP_REASONS, "unknown"],
  );

  const counters = [
    pollCycles,
    rpcRequests,
    rpcErrors,
    eventsDecoded,
    eventsSkipped,
    notificationsSent,
    notificationsFailed,
    staleCursorEvents,
    activityAnomalies,
  ];
  const gauges = [consecutiveFailures, lastCycleEvents, activityBaselineEvents];

  function render(): string {
    const lines: string[] = [];

    for (const c of counters) {
      lines.push(`# HELP ${c._name} ${c._help}`);
      lines.push(`# TYPE ${c._name} counter`);
      lines.push(`${c._name} ${c.value()}`);
    }

    lines.push(`# HELP ${droppedSamples._name} ${droppedSamples._help}`);
    lines.push(`# TYPE ${droppedSamples._name} counter`);
    for (const [reason, v] of droppedSamples._entries()) {
      lines.push(`${droppedSamples._name}{reason="${reason}"} ${v}`);
    }

    for (const g of gauges) {
      lines.push(`# HELP ${g._name} ${g._help}`);
      lines.push(`# TYPE ${g._name} gauge`);
      lines.push(`${g._name} ${g.value()}`);
    }

    // Prometheus text format requires a trailing newline.
    return lines.join("\n") + "\n";
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // Only GET is meaningful for a read-only metrics endpoint.
    if (method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET" });
      res.end("Method Not Allowed\n");
      return;
    }

    // Strip query strings: /metrics?debug=1 should still serve metrics.
    const path = url.split("?")[0] ?? "/";

    if (path === "/metrics") {
      const body = render();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        // Instruct proxies not to cache — stale metrics are misleading.
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK\n");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found\n");
  }

  function startServer(port: number, host = "127.0.0.1"): Promise<MetricsServer> {
    return new Promise((resolve, reject) => {
      const server = createServer(handleRequest);

      server.once("error", reject);

      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = addr && typeof addr === "object" ? addr.port : port;

        console.log(`[metrics] server listening on http://${host}:${actualPort}/metrics`);

        const metricsServer: MetricsServer = {
          port: actualPort,
          close(): Promise<void> {
            return new Promise((res, rej) => {
              server.close((err) => {
                if (err) rej(err);
                else res();
              });
            });
          },
        };

        resolve(metricsServer);
      });
    });
  }

  return {
    pollCycles,
    rpcRequests,
    rpcErrors,
    eventsDecoded,
    eventsSkipped,
    notificationsSent,
    notificationsFailed,
    staleCursorEvents,
    consecutiveFailures,
    lastCycleEvents,
    activityBaselineEvents,
    activityAnomalies,
    droppedSamples,
    setGaugeSafe(gauge: Gauge, value: number): void {
      if (!Number.isFinite(value)) {
        droppedSamples.inc("invalid_number");
        return;
      }
      gauge.set(value);
    },
    render,
    startServer,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

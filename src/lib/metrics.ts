/**
 * Minimal in-process metrics registry, rendered in Prometheus text format.
 *
 * Deliberately dependency-free: counters and gauges in memory, exposed at
 * GET /metrics. For a single instance this is enough to alert on money-safety
 * events (webhook signature failures, stuck transfers) and request health.
 * A multi-instance deployment should scrape each instance or push to a
 * time-series store.
 */

type Labels = Record<string, string>;

const counters = new Map<string, number>();
const gauges = new Map<string, number>();

function seriesKey(name: string, labels?: Labels): string {
  if (!labels) return name;
  const parts = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .sort();
  return `${name}{${parts.join(",")}}`;
}

/** Increment a counter (monotonic). */
export function incCounter(name: string, labels?: Labels, by = 1): void {
  const k = seriesKey(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

/** Set a gauge (last value wins). */
export function setGauge(name: string, value: number, labels?: Labels): void {
  gauges.set(seriesKey(name, labels), value);
}

/** Render all metrics in Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [k, v] of counters) lines.push(`${k} ${v}`);
  for (const [k, v] of gauges) lines.push(`${k} ${v}`);

  const mem = process.memoryUsage();
  lines.push(`process_uptime_seconds ${Math.floor(process.uptime())}`);
  lines.push(`process_resident_memory_bytes ${mem.rss}`);
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);
  lines.push(`process_heap_total_bytes ${mem.heapTotal}`);

  return lines.join("\n") + "\n";
}

/** Test helper — reset all metrics. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
}

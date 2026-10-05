import { describe, expect, it } from "vitest";
import { createTestApp } from "./setup.js";
import { incCounter, setGauge, renderMetrics, resetMetrics } from "../src/lib/metrics.js";

describe("metrics", () => {
  it("renders counters and gauges in Prometheus format", () => {
    resetMetrics();
    incCounter("test_total", { a: "1" });
    incCounter("test_total", { a: "1" });
    setGauge("test_gauge", 42);
    const out = renderMetrics();
    expect(out).toContain('test_total{a="1"} 2');
    expect(out).toContain("test_gauge 42");
    expect(out).toContain("process_uptime_seconds");
  });

  it("exposes /metrics and counts requests", async () => {
    const app = await createTestApp();
    await app.inject({ method: "GET", url: "/" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("http_requests_total");
  });
});

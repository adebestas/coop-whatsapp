// k6 load smoke — proves the pilot instance survives a branch-office morning.
// Install k6 (https://k6.io/docs/get-started/installation/), then:
//   BASE_URL=https://staging.example.com K6_VUS=20 K6_DURATION=2m k6 run scripts/load-smoke.js
// /health hits the database, so this measures the real request path, not a static page.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const VUS = Number(__ENV.K6_VUS || 10);
const DURATION = __ENV.K6_DURATION || "1m";

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
  },
};

export default function () {
  const health = http.get(`${BASE_URL}/health`, { tags: { name: "health" } });
  check(health, {
    "health is 200": (r) => r.status === 200,
    "health reports ok": (r) => String(r.body).includes('"status":"ok"'),
  });

  if (Math.random() < 0.2) {
    const dashboard = http.get(`${BASE_URL}/dashboard/app.js`, { tags: { name: "dashboard-js" } });
    check(dashboard, { "dashboard js is served": (r) => r.status === 200 });
  }
  sleep(1);
}

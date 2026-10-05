import { describe, expect, it } from "vitest";
import { runSchedulerJob } from "../src/services/scheduler.js";
import { scheduleSchedulerJobs } from "../src/lib/queue.js";

describe("scheduler jobs (BullMQ dispatch)", () => {
  it("runs the tick job without throwing (no coops = no-op)", async () => {
    await expect(runSchedulerJob("tick")).resolves.toBeUndefined();
  });

  it("ignores an unknown job name", async () => {
    await expect(runSchedulerJob("does-not-exist")).resolves.toBeUndefined();
  });

  it("scheduleSchedulerJobs is a no-op when Redis is unavailable", async () => {
    await expect(scheduleSchedulerJobs()).resolves.toBeUndefined();
  });
});

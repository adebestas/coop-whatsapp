import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prisma } from "../tests/setup.js";
import { ensurePlatformOwner } from "../src/services/platform-bootstrap.js";
import { verifyPin } from "../src/lib/security.js";

const dir = mkdtempSync(join(tmpdir(), "coop-pin-test-"));
const pinFile = join(dir, "platform-owner-pin.txt");

describe("platform owner bootstrap PIN handling", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await prisma.platformAdmin.deleteMany();
    process.env.PLATFORM_OWNER_PHONE = "2348097000099";
    process.env.PLATFORM_OWNER_PIN_FILE = pinFile;
    delete process.env.PLATFORM_OWNER_PIN;
    if (existsSync(pinFile)) rmSync(pinFile);
  });

  afterAll(() => {
    delete process.env.PLATFORM_OWNER_PHONE;
    delete process.env.PLATFORM_OWNER_PIN_FILE;
    delete process.env.PLATFORM_OWNER_PIN;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the temp PIN to a file and never prints it", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await ensurePlatformOwner();

    expect(existsSync(pinFile)).toBe(true);
    const pin = readFileSync(pinFile, "utf8").trim();
    expect(pin).toMatch(/^\d{6}$/);

    const output = lines.join("\n");
    expect(output).not.toContain(pin);
    expect(output).toContain(pinFile);
  });

  it("refuses to create the owner when no PIN and no PIN file are configured", async () => {
    delete process.env.PLATFORM_OWNER_PIN_FILE;
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await ensurePlatformOwner();

    expect(await prisma.platformAdmin.count()).toBe(0);
    expect(errors.join("\n")).toMatch(/PLATFORM_OWNER_PIN/);
  });

  it("uses an operator-supplied PIN and writes no file", async () => {
    delete process.env.PLATFORM_OWNER_PIN_FILE;
    process.env.PLATFORM_OWNER_PIN = "246813";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await ensurePlatformOwner();

    const owner = await prisma.platformAdmin.findFirst({ where: { role: "owner" } });
    expect(owner).not.toBeNull();
    expect(verifyPin("246813", owner!.pin!)).toBe(true);
    expect(existsSync(pinFile)).toBe(false);
    expect(lines.join("\n")).not.toContain("246813");
  });
});

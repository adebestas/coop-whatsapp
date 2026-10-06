import { describe, expect, it } from "vitest";
import { AI_TOOLS, canUseTool } from "../src/lib/ai-tools.js";

describe("AI tool registry permissions", () => {
  it("member_list is admin-only", () => {
    expect(canUseTool(AI_TOOLS.member_list, "member")).toBe(false);
    expect(canUseTool(AI_TOOLS.member_list, "admin")).toBe(true);
    expect(canUseTool(AI_TOOLS.member_list, "superadmin")).toBe(true);
  });

  it("self-scoped tools are marked self; aggregate tools are coop", () => {
    expect(AI_TOOLS.member_balance.scope).toBe("self");
    expect(AI_TOOLS.member_affordability.scope).toBe("self");
    expect(AI_TOOLS.coop_overview.scope).toBe("coop");
  });

  it("every classifier intent has a registered tool", () => {
    const intents = [
      "member_balance",
      "member_savings",
      "member_loan",
      "coop_overview",
      "coop_contributions",
      "coop_loans",
      "coop_withdrawals",
      "coop_trends",
      "coop_performance",
      "member_affordability",
      "member_list",
      "help",
    ];
    for (const i of intents) expect(AI_TOOLS[i]).toBeTruthy();
  });
});

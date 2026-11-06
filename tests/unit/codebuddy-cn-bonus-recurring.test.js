// CodeBuddy CN mixes recurring refill packs with one-shot bonus packs.
// Bonus packs ("Bonus Pack N") must surface recurring:false so the dashboard
// shows "Expires in" instead of implying a monthly refill. The usage handler
// tags the flag and parseQuotaData must forward it.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The billing POST must never reach the network.
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { getCodeBuddyCnUsage, getCodeBuddyIntlUsage } from "open-sse/services/usage/codebuddy-cn.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

describe("parseQuotaData codebuddy-cn recurring flag", () => {
  it("forwards recurring:false for bonus packs and true for refill packs", () => {
    const data = {
      plan: "CodeBuddy CN",
      quotas: {
        Monthly: { used: 6.54, total: 500, resetAt: "2026-07-31T00:00:00Z", recurring: true },
        "Bonus Pack 1": { used: 12, total: 100, resetAt: "2026-07-15T00:00:00Z", recurring: false },
      },
    };

    const out = parseQuotaData("codebuddy-cn", data);
    const byName = Object.fromEntries(out.map((q) => [q.name, q]));

    expect(byName["Monthly"].recurring).toBe(true);
    expect(byName["Bonus Pack 1"].recurring).toBe(false);
  });

  it("defaults recurring to true when the flag is absent (back-compat)", () => {
    const data = { quotas: { Monthly: { used: 0, total: 100, resetAt: null } } };
    const out = parseQuotaData("codebuddy-cn", data);
    expect(out[0].recurring).toBe(true);
  });
});

// Field shapes and the pack distribution were read off a live account's own
// billing response (37 packs), not invented: CycleStartTime/CycleEndTime are
// ISO strings with a space, DeductionStartTime/DeductionEndTime are
// epoch-milliseconds integers, and every pack had DeductionEnd == CycleEnd with
// AutoRenewFlag 0 — i.e. all one-shot credits.
const CYCLE_ISO = "2026-11-07 15:16:31";
const CYCLE_ISO_MS = new Date("2026-11-07T15:16:31").getTime();
const pack = (over = {}) => ({
  AccountId: 1,
  CapacityUnit: "credits",
  CapacityType: 1,
  AutoRenewFlag: 0,
  CycleStartTime: "2026-10-07 15:16:32",
  CycleEndTime: CYCLE_ISO,
  DeductionStartTime: CYCLE_ISO_MS - 31 * 86400000,
  DeductionEndTime: CYCLE_ISO_MS,
  CycleCapacityUsedPrecise: "6.54",
  CycleCapacitySizePrecise: "500",
  CapacityUsedPrecise: "6.54",
  CapacitySizePrecise: "500",
  ...over,
});

const billing = (accounts) => ({
  code: 0,
  msg: "OK",
  data: { Response: { Data: { TotalCount: accounts.length, Accounts: accounts } } },
});

describe("getCodeBuddyUsage pack classification", () => {
  beforeEach(() => vi.clearAllMocks());

  const run = async (accounts) => {
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify(billing(accounts)), { status: 200, headers: { "content-type": "application/json" } }));
    return getCodeBuddyCnUsage("tok");
  };

  it("labels a one-shot pack (DeductionEnd == CycleEnd) as bonus, not refill", async () => {
    const out = await run([pack()]);
    const names = Object.keys(out.quotas);
    expect(names).toEqual(["Bonus Pack 1"]);
    expect(out.quotas["Bonus Pack 1"].recurring).toBe(false);
  });

  it("labels a recurring pack (validity end far past the cycle end) with its cadence", async () => {
    const out = await run([pack({ DeductionEndTime: CYCLE_ISO_MS + 120 * 86400000 })]);
    const names = Object.keys(out.quotas);
    expect(names).toEqual(["Monthly"]);
    expect(out.quotas.Monthly.recurring).toBe(true);
    expect(out.quotas.Monthly.used).toBe(6.54);
    expect(out.quotas.Monthly.total).toBe(500);
  });

  it("does not lose the recurring pack when the epoch fields arrive as strings", async () => {
    // Same instant, quoted — the parser has to accept both because the two
    // fields are not the same type in the first place.
    const out = await run([pack({ DeductionEndTime: String(CYCLE_ISO_MS + 120 * 86400000) })]);
    expect(Object.keys(out.quotas)).toEqual(["Monthly"]);
  });

  it("surfaces an expired session per provider rather than as a CN row", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("{}", { status: 401 }));
    const intl = await getCodeBuddyIntlUsage("tok");
    expect(intl.message).toContain("codebuddy-intl");
    expect(intl.message).not.toContain("CodeBuddy CN");
    const cn = await getCodeBuddyCnUsage("tok");
    expect(cn.message).toContain("codebuddy-cn");
  });

  it("reports an empty package list per provider too", async () => {
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ code: 0, msg: "OK", data: { Response: { Data: { Accounts: [] } } } }), { status: 200, headers: { "content-type": "application/json" } }));
    expect((await getCodeBuddyIntlUsage("tok")).message).toContain("codebuddy-intl");
  });
});

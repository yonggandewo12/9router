// The CodeBuddy live catalog comes from the gateway's own account config, and two things
// about it are easy to get wrong (both measured 2026-11-06):
//   - published ≠ chat-usable: the image/video rows are in the table and 400 on
//     /v2/chat/completions with code 11103, but they announce themselves through `tags`,
//     so the filter is data-driven.
//   - usable ≠ published: the five gateway routers answer and are NOT in the table, so a
//     naive "trust the table" refresh would hide four working models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { normalizeCodeBuddyModels } from "open-sse/services/codebuddyModels.js";
import registry from "open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

const row = (over) => ({
  id: "glm-5.3",
  name: "GLM-5.3",
  credits: "x0.69 credits",
  maxInputTokens: 1000000,
  maxOutputTokens: 131072,
  supportsToolCall: true,
  supportsImages: true,
  supportsReasoning: true,
  ...over,
});

const payload = (models) => ({ code: 0, msg: "OK", data: { models } });

describe("codebuddy live catalog normalization", () => {
  it("keeps chat rows with the server's own numbers", () => {
    const models = normalizeCodeBuddyModels(payload([row()]), "codebuddy-cn");
    expect(models.find((m) => m.id === "glm-5.3")).toMatchObject({
      name: "GLM-5.3",
      contextLength: 1000000,
      maxOutputTokens: 131072,
      rateMultiplier: 0.69,
      capabilities: { vision: true, tools: true, reasoning: true },
    });
  });

  it("drops the media rows that 400 on the chat endpoint", () => {
    const ids = normalizeCodeBuddyModels(payload([
      row({ id: "hunyuan-image-alpha", name: "Hunyuan Image Alpha", tags: ["text-to-image"] }),
      row({ id: "hunyuan-image-alpha-edit", tags: ["image-to-image"] }),
      row({ id: "kling-video-v3", tags: ["text-to-video", "image-to-video"] }),
      row({ id: "minimax-video-h3", videoGeneration: true }),
      row({ id: "glm-5.3" }),
    ]), "codebuddy-cn").map((m) => m.id);
    expect(ids).toContain("glm-5.3");
    for (const media of ["hunyuan-image-alpha", "hunyuan-image-alpha-edit", "kling-video-v3", "minimax-video-h3"]) {
      expect(ids).not.toContain(media);
    }
  });

  it("carries the gateway routers even though the table omits them", () => {
    const models = normalizeCodeBuddyModels(payload([row({ id: "glm-5.3" })]), "codebuddy-cn");
    const ids = models.map((m) => m.id);
    for (const router of ["auto", "fast-model", "balanced-model", "deep-model"]) {
      expect(ids).toContain(router);
    }
    expect(models.find((m) => m.id === "auto")).toMatchObject({ router: true });
  });

  it("does not duplicate a router the table happens to publish", () => {
    const models = normalizeCodeBuddyModels(payload([
      row({ id: "auto", name: "Auto", credits: "x0.20 credits" }),
    ]), "codebuddy-cn");
    expect(models.filter((m) => m.id === "auto")).toHaveLength(1);
    expect(models.find((m) => m.id === "auto")).toMatchObject({ rateMultiplier: 0.2 });
  });

  it("leaves the rate out rather than inventing one", () => {
    const models = normalizeCodeBuddyModels(payload([
      row({ id: "hunyuan-chat", credits: undefined }),
      row({ id: "default", credits: "免费" }),
    ]), "codebuddy-cn");
    expect(models.find((m) => m.id === "hunyuan-chat")).not.toHaveProperty("rateMultiplier");
    expect(models.find((m) => m.id === "default")).not.toHaveProperty("rateMultiplier");
  });

  it("tolerates an empty or unauthenticated payload", () => {
    // Without a bearer the route answers 200 with models: null — the caller then falls
    // back to the static registry instead of publishing an empty picker.
    expect(normalizeCodeBuddyModels({ code: 0, data: { models: null } }, "codebuddy-cn")).toEqual([]);
    expect(normalizeCodeBuddyModels({}, "codebuddy-cn")).toEqual([]);
    expect(normalizeCodeBuddyModels(payload([{ name: "no id" }]), "codebuddy-cn")).toEqual([]);
  });

  it("de-duplicates repeated ids in one table", () => {
    const models = normalizeCodeBuddyModels(payload([row(), row({ name: "GLM-5.3 dup" })]), "codebuddy-cn");
    expect(models.filter((m) => m.id === "glm-5.3")).toHaveLength(1);
  });
});

describe("codebuddy registry hygiene", () => {
  it("publishes glm-5.1 / glm-5.0-turbo and marks them thinkingRequired", () => {
    const cn = registry.find((p) => p.id === "codebuddy-cn");
    const ids = cn.models.map((m) => m.id);
    expect(ids).toContain("glm-5.1");
    expect(ids).toContain("glm-5.0-turbo");
    // Both 400 code 11150 on a bare request, so the flag that makes the executor inject
    // an effort has to be set or the id is a selectable dead end again.
    for (const id of ["glm-5.1", "glm-5.0-turbo"]) {
      expect(getCapabilitiesForModel("codebuddy-cn", id).thinkingRequired).toBe(true);
    }
    expect(getCapabilitiesForModel("codebuddy-cn", "glm-5.3").thinkingRequired).toBeFalsy();
  });
});

// The table alone cannot answer "is this callable" — seven published CN rows 400 on chat
// (probed 2026-11-06) — so resolveCodeBuddyModels verifies each id with the smallest
// possible plain request and only drops the ones the gateway itself disavows.
import { resolveCodeBuddyModels, clearCodeBuddyCatalogCache, markModelUnusable, requiresReasoningEffort } from "open-sse/services/codebuddyModels.js";

const chatReply = (id, { code = "", content = "ok" } = {}) => ({
  status: code ? 400 : 200,
  json: () => Promise.resolve({}),
  text: () => Promise.resolve(
    code
      ? `data: ${JSON.stringify({ code, msg: "gateway refused" })}\n\n`
      : `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  ),
});

function stubFetch(table, replies = {}) {
  const calls = { config: 0, chat: [] };
  const fn = async (url, opts = {}) => {
    if (url.endsWith("/v3/config")) {
      calls.config++;
      return { ok: true, status: 200, json: async () => payload(table), text: async () => "" };
    }
    const model = JSON.parse(opts.body).model;
    calls.chat.push(model);
    return chatReply(model, replies[model] || {});
  };
  return { fn, calls };
}

// Two production contracts, and the difference between them is the whole point: /v1/models
// is polled by clients and must never block on ~10s of real completions, while a dashboard
// page a human is watching waits for the verified list. Tests that assert verdicts use
// `verified`; see the "poll must not block" case for the other one.
const verified = (opts) => resolveCodeBuddyModels({ ...opts, wait: true });

describe("codebuddy catalog verification pass", () => {
  const table = [
    row({ id: "glm-5.3" }),
    row({ id: "glm-4.6" }),
    row({ id: "glm-5.0-turbo" }),
    row({ id: "hunyuan-chat" }),
  ];

  beforeEach(() => clearCodeBuddyCatalogCache());

  it("drops the ids the gateway disavows and keeps the ones that answer", async () => {
    const { fn, calls } = stubFetch(table, {
      "glm-4.6": { code: "11102" },
      "glm-5.0-turbo": { code: "11150" },
    });
    const result = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    expect(result.models.map((m) => m.id)).toEqual(["glm-5.3", "hunyuan-chat", "auto", "fast-model", "balanced-model", "deep-model"]);
    expect(result.dropped).toEqual([
      { id: "glm-4.6", reason: "retired upstream" },
      { id: "glm-5.0-turbo", reason: "rejects a request without reasoning_effort" },
    ]);
    // Routers are never in the table, so they are verified too rather than trusted.
    expect(calls.chat).toContain("auto");
  });

  it("keeps a model whose probe told it nothing (401/429/timeout are not verdicts)", async () => {
    const flaky = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) return { ok: true, status: 200, json: async () => payload(table), text: async () => "" };
      return { ok: false, status: 429, json: async () => ({}), text: async () => "too many" };
    };
    const result = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: flaky });
    expect(result.models.map((m) => m.id)).toContain("glm-4.6");
    expect(result.dropped).toEqual([]);
  });

  it("reuses cached verdicts instead of re-probing on the next call", async () => {
    const first = stubFetch(table, { "glm-4.6": { code: "11102" } });
    await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: first.fn });
    const probesAfterFirst = first.calls.chat.length;

    const second = stubFetch(table, { "glm-4.6": { code: "11102" } });
    const again = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: second.fn });
    expect(second.calls.config).toBe(0);            // catalog cached too
    expect(second.calls.chat.length).toBe(0);       // verdicts cached → no re-probe
    expect(again.dropped.map((d) => d.id)).toEqual(["glm-4.6"]);
    expect(probesAfterFirst).toBeGreaterThan(0);
  });

  it("reads a refusal that lands after the first chunk as a refusal", async () => {
    const fn = async (url) => (url.endsWith("/v3/config")
      ? { ok: true, status: 200, json: async () => payload([row({ id: "glm-4.6" })]), text: async () => "" }
      : {
        ok: false, status: 400, json: async () => ({}),
        // Some paths print a role/content frame before the refusal. Counting the chunk as
        // the answer would keep an id the gateway has already retired.
        text: async () => [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}`,
          `data: ${JSON.stringify({ code: 11102, msg: "model [glm-4.6] service info not found" })}`,
          "",
        ].join("\n"),
      });
    const result = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    expect(result.dropped.map((d) => d.id)).toContain("glm-4.6");
    expect(result.models.map((m) => m.id)).not.toContain("glm-4.6");
  });

  it("forceRefresh re-probes and can bring a model back", async () => {
    const s1 = stubFetch(table, { "glm-4.6": { code: "11102" } });
    await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: s1.fn });
    const s2 = stubFetch(table); // glm-4.6 answers now
    const back = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: s2.fn, forceRefresh: true });
    expect(back.models.map((m) => m.id)).toContain("glm-4.6");
    expect(back.dropped).toEqual([]);
  });

  it("probes with the output capped, and reads the gateway's code:0 as success", async () => {
    const bodies = [];
    const fn = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) return { ok: true, status: 200, json: async () => payload(table), text: async () => "" };
      const body = JSON.parse(opts.body);
      bodies.push(body);
      // The live reply: a role frame, then finish_reason "length" with no text, and frames
      // that carry code:0 for success. Treating either half of that as a refusal would keep
      // the id permanently inconclusive.
      return {
        ok: true, status: 200, json: async () => ({}),
        text: async () => [
          `data: ${JSON.stringify({ code: 0, choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
          `data: ${JSON.stringify({ code: 0, choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}`,
          "data: [DONE]",
          "",
        ].join("\n"),
      };
    };
    const result = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    expect(result.dropped).toEqual([]);
    expect(result.models).toHaveLength(table.length + 4);   // nothing pruned
    // An uncapped "ok" is a 127 KB, 10s, x2-rate reply on `default` — measured 2026-11-06.
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.max_tokens).toBeLessThanOrEqual(16);
      expect(body.stream).toBe(true);
    }
  });

  it("returns nothing on an unauthenticated or empty catalog so the caller falls back", async () => {
    const noToken = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "", fetchFn: async () => { throw new Error("must not fetch"); } });
    expect(noToken).toMatchObject({ models: [], warning: expect.stringContaining("no token") });

    const empty = stubFetch([]);
    const noRows = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: empty.fn });
    expect(noRows.models).toEqual([]);
    expect(noRows.warning).toContain("empty");
  });
});

describe("codebuddy verdict cache semantics", () => {
  beforeEach(() => clearCodeBuddyCatalogCache());
  afterEach(() => vi.useRealTimers());

  it("ages the caches out instead of trusting them forever", async () => {
    const table = [row({ id: "glm-5.3" }), row({ id: "glm-4.6" })];
    const s1 = stubFetch(table, { "glm-4.6": { code: "11102" } });
    await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: s1.fn });
    expect(s1.calls.config).toBe(1);

    // A second connection is a second account key: its own table, its own verdicts.
    const s2 = stubFetch(table, { "glm-4.6": { code: "11102" } });
    await verified({ providerId: "codebuddy-cn", accessToken: "OTHER", fetchFn: s2.fn });
    expect(s2.calls.config).toBe(1);

    // Past both TTLs the daemon must stop trusting what it stored — and the sweep that
    // keeps a long-running process from accumulating one cache per token rotation runs on
    // the same boundary, so it may not skip a re-read or a re-probe.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    const s3 = stubFetch(table, { "glm-4.6": { code: "11102" } });
    const aged = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: s3.fn });
    expect(s3.calls.config).toBe(1);                 // catalog expired → re-read
    expect(s3.calls.chat.length).toBeGreaterThan(0); // verdicts expired → re-proved
    expect(aged.dropped.map((d) => d.id)).toEqual(["glm-4.6"]);
  });
  it("probes a newly published id instead of trusting its presence in the table", async () => {
    const s1 = stubFetch([row({ id: "glm-5.3" })]);
    await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: s1.fn });

    // The server publishes a second model. Only an explicit refresh re-reads the config —
    // a cached catalog cannot show a new id — and the new row must be verified like every
    // other one, not waved in because the table listed it.
    const s2 = stubFetch([row({ id: "glm-5.3" }), row({ id: "brand-new", credits: "x0.10 credits" })], { "brand-new": { code: "11102" } });
    const second = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: s2.fn, forceRefresh: true });
    expect(s2.calls.chat).toContain("brand-new");
    expect(second.models.map((m) => m.id)).not.toContain("brand-new");
  });

  it("does not hammer an id it could not reach, and tries again on the retry clock", async () => {
    const unreachable = async (url) => (url.endsWith("/v3/config")
      ? { ok: true, status: 200, json: async () => payload([row({ id: "glm-5.3" })]), text: async () => "" }
      : { ok: false, status: 429, json: async () => ({}), text: async () => "busy" });
    const first = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: unreachable });
    expect(first.models.map((m) => m.id)).toContain("glm-5.3");  // fail-open, never pruned
    expect(first.dropped).toEqual([]);

    // A client poll would otherwise pay for a doomed round trip (up to the probe timeout)
    // on every call, so the failed attempt is remembered for a while…
    const immediate = stubFetch([row({ id: "glm-5.3" })]);
    await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: immediate.fn });
    expect(immediate.calls.chat.length).toBe(0);

    // …and retried once that window passes. The guess is still never trusted: the id stays
    // in, and the next pass proves it.
    const retried = stubFetch([row({ id: "glm-5.3" })]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: retried.fn });
    expect(retried.calls.chat).toContain("glm-5.3");
  });
});

describe("codebuddy 11150 self-healing", () => {
  beforeEach(() => clearCodeBuddyCatalogCache());

  it("keeps an id that only answers with an injected effort, and records why", async () => {
    const fn = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || "{}");
      if (url.endsWith("/v3/config")) return { ok: true, status: 200, json: async () => payload([row({ id: "glm-5.1" })]), text: async () => "" };
      // 11150 unless the request carries reasoning_effort — exactly glm-5.1's behaviour
      if (!body.reasoning_effort) return { ok: false, status: 400, json: async () => ({}), text: async () => `data: ${JSON.stringify({ code: 11150, msg: "no effort" })}` };
      return chatReply(body.model);
    };
    const result = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    expect(result.models.map((m) => m.id)).toContain("glm-5.1");
    expect(result.dropped).toEqual([]);
    expect(requiresReasoningEffort("codebuddy-cn", "glm-5.1")).toBe(true);
  });

  it("drops the id when even an effort does not help", async () => {
    const fn = async (url) => (url.endsWith("/v3/config")
      ? { ok: true, status: 200, json: async () => payload([row({ id: "broken" })]), text: async () => "" }
      : { ok: false, status: 400, json: async () => ({}), text: async () => `data: ${JSON.stringify({ code: 11150, msg: "no" })}` });
    const result = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    expect(result.dropped.map((d) => d.id)).toContain("broken");
    expect(result.models.map((m) => m.id)).not.toContain("broken");
  });

  it("records a retirement seen in live traffic so the next refresh drops it at once", async () => {
    const table = [row({ id: "glm-5.3" }), row({ id: "minimax-m2.5" })];
    const ok = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) return { ok: true, status: 200, json: async () => payload(table), text: async () => "" };
      return chatReply(JSON.parse(opts.body).model);
    };
    const first = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: ok });
    expect(first.models.map((m) => m.id)).toContain("minimax-m2.5");

    markModelUnusable("codebuddy-cn", "minimax-m2.5", "retired upstream");
    // No probe needed: the report is itself the verdict, so even a client poll that must
    // not block drops the id on the very next call.
    const second = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: ok });
    expect(second.models.map((m) => m.id)).not.toContain("minimax-m2.5");
    expect(second.dropped).toEqual([{ id: "minimax-m2.5", reason: "retired upstream" }]);
  });
});

// The executor is what makes glm-5.1 callable for a client that asks for nothing.
import { CodeBuddyExecutor } from "open-sse/executors/codebuddy-cn.js";

const CnExecutor = CodeBuddyExecutor;

describe("codebuddy executor effort injection", () => {
  const executor = new CodeBuddyExecutor();
  const base = () => ({ model: "glm-5.1", messages: [{ role: "user", content: "hi" }] });

  it("injects reasoning_effort for a thinkingRequired model on a plain request", () => {
    const out = executor.transformRequest("glm-5.1", base(), true, {});
    expect(out.reasoning_effort).toBe("low");
    // …and deliberately not reasoning_summary, which is what #2071 was about.
    expect(out.reasoning_summary).toBeUndefined();
  });

  it("leaves models that accept a bare request untouched", () => {
    const out = executor.transformRequest("glm-5.3", { ...base(), model: "glm-5.3" }, true, {});
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("never overrides an effort the client asked for", () => {
    const out = executor.transformRequest("glm-5.1", { ...base(), reasoning_effort: "high" }, true, {});
    expect(out.reasoning_effort).toBe("high");
    expect(out.reasoning_summary).toBe("auto");
  });

  it("still drops reasoning_effort:none (the gateway has no none)", () => {
    const out = executor.transformRequest("glm-5.3", { ...base(), model: "glm-5.3", reasoning_effort: "none" }, true, {});
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("learns a retirement from the gateway's own error text", async () => {
    const res = { status: 400 };
    executor.parseError(res, JSON.stringify({ code: 11102, msg: "model [kimi-k2-thinking] service info not found" }));
    // Recorded as unusable, so the next refresh drops it without waiting for the TTL.
    const refreshed = await verified({
      providerId: "codebuddy-cn",
      accessToken: "T",
      fetchFn: async (url, opts = {}) => (url.endsWith("/v3/config")
        ? { ok: true, status: 200, json: async () => payload([row({ id: "kimi-k2-thinking" })]), text: async () => "" }
        : chatReply(JSON.parse(opts.body).model)),
    });
    expect(refreshed.models.map((m) => m.id)).not.toContain("kimi-k2-thinking");
  });
});

describe("codebuddy probe tiering (model-call budget)", () => {
  beforeEach(() => clearCodeBuddyCatalogCache());

  const table = [
    row({ id: "glm-5.3" }),          // agent-listed → trusted, never probed
    row({ id: "space-bunny" }),      // agent-listed
    row({ id: "minimax-m2.5" }),     // not listed, retired → probed and dropped
    row({ id: "glm-5.0-turbo" }),    // not listed, needs effort → probed, kept
  ];

  const fn = async (url, opts = {}) => {
    if (url.endsWith("/v3/config")) {
      const data = { models: table, agents: [{ name: "cli", models: ["glm-5.3", "space-bunny"] }] };
      return { ok: true, status: 200, json: async () => ({ code: 0, data }), text: async () => "" };
    }
    const body = JSON.parse(opts.body);
    if (body.model === "minimax-m2.5") return { ok: false, status: 400, json: async () => ({}), text: async () => `data: ${JSON.stringify({ code: 11102, msg: "model [minimax-m2.5] service info not found" })}` };
    if (body.model === "glm-5.0-turbo" && !body.reasoning_effort) return { ok: false, status: 400, json: async () => ({}), text: async () => `data: ${JSON.stringify({ code: 11150, msg: "no effort" })}` };
    return chatReply(body.model);
  };

  it("only probes the ambiguous tail, not the whole table", async () => {
    const calls = [];
    const spy = async (url, opts = {}) => {
      if (!url.endsWith("/v3/config")) calls.push(JSON.parse(opts.body).model);
      return fn(url, opts);
    };
    const result = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: spy });
    expect(calls).not.toContain("glm-5.3");
    expect(calls).not.toContain("space-bunny");
    expect(calls).toContain("minimax-m2.5");
    expect(result.models.map((m) => m.id)).toContain("glm-5.3");
    expect(result.dropped.map((d) => d.id)).toEqual(["minimax-m2.5"]);
    // 4 routers + 2 ambiguous ids, not 4 routers + 30 table ids.
    expect(calls.filter((c) => !["auto", "fast-model", "balanced-model", "deep-model"].includes(c)).length).toBeLessThanOrEqual(3);
  });

  it("lets a live 11102 override the agent-listed trust", async () => {
    // Warm the cache first, so glm-5.3 holds a positive agent-listed verdict.
    await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    markModelUnusable("codebuddy-cn", "glm-5.3", "retired upstream");
    const result = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    expect(result.models.map((m) => m.id)).not.toContain("glm-5.3");
  });

  it("answers a client poll from the table and proves the rest in the background", async () => {
    const calls = [];
    const spy = async (url, opts = {}) => {
      if (!url.endsWith("/v3/config")) calls.push(JSON.parse(opts.body).model);
      return fn(url, opts);
    };
    // /v1/models is polled by SDKs, so a cold pass may not hold it open for ~10s: the poll
    // answers from the table and the pass proves the rest behind it.
    const cold = await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: spy });
    expect(cold.dropped).toEqual([]);
    expect(cold.models.map((m) => m.id)).toContain("minimax-m2.5");

    // A caller that does wait joins that same pass rather than returning a half-answer,
    // and sharing is what keeps the budget at one pass (6 ids + 1 effort retry).
    const settled = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: spy });
    expect(settled.dropped.map((d) => d.id)).toEqual(["minimax-m2.5"]);
    expect(settled.models.map((m) => m.id)).not.toContain("minimax-m2.5");
    expect(calls.length).toBeLessThanOrEqual(7);
  });
});

describe("codebuddy oversized prompt", () => {
  it("reports 11115 as 413 without trusting the gateway's own numbers", () => {
    const parsed = new CnExecutor().parseError(
      { status: 400 },
      JSON.stringify({ code: 11115, msg: "prompt is too long: 100001 tokens > 100000 maximum" })
    );
    expect(parsed.status).toBe(413);
    expect(parsed.message).toContain("100001 tokens");
  });
});

describe("codebuddy-intl parity", () => {
  beforeEach(() => clearCodeBuddyCatalogCache());

  it("learns its own thinkingRequired verdict and injects for it", async () => {
    const { CodeBuddyIntlExecutor } = await import("open-sse/executors/codebuddy-intl.js");
    const intl = new CodeBuddyIntlExecutor();
    // An intl id that refuses a bare request: the refresh must discover it and the intl
    // executor must then inject, using the same helper as codebuddy-cn.
    const fetchFn = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) {
        const data = { models: [row({ id: "gpt-6-sol" })], agents: [] };
        return { ok: true, status: 200, json: async () => ({ code: 0, data }), text: async () => "" };
      }
      const body = JSON.parse(opts.body);
      if (!body.reasoning_effort) return { ok: false, status: 400, json: async () => ({}), text: async () => `data: ${JSON.stringify({ code: 11150, msg: "no effort" })}` };
      return chatReply(body.model);
    };
    const result = await verified({ providerId: "codebuddy-intl", accessToken: "T", fetchFn });
    expect(result.models.map((m) => m.id)).toContain("gpt-6-sol");

    const out = intl.transformRequest("gpt-6-sol", { model: "gpt-6-sol", messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.stream).toBe(true);
    expect(out.reasoning_effort).toBe("low");
  });

  it("keeps verdicts per provider instead of leaking them across the gateway family", async () => {
    markModelUnusable("codebuddy-intl", "gpt-5.6-sol", "retired upstream");
    const cn = await verified({
      providerId: "codebuddy-cn",
      accessToken: "T",
      fetchFn: async (url, opts = {}) => (url.endsWith("/v3/config")
        ? { ok: true, status: 200, json: async () => payload([row({ id: "gpt-5.6-sol" })]), text: async () => "" }
        : chatReply(JSON.parse(opts.body).model)),
    });
    expect(cn.models.map((m) => m.id)).toContain("gpt-5.6-sol");
  });

  it("records a retirement named in the intl error text", async () => {
    const { CodeBuddyIntlExecutor } = await import("open-sse/executors/codebuddy-intl.js");
    const intl = new CodeBuddyIntlExecutor();
    intl.parseError({ status: 400 }, JSON.stringify({ code: 11102, msg: "model [gpt-6-astra] service info not found" }));
    const result = await resolveCodeBuddyModels({
      providerId: "codebuddy-intl",
      accessToken: "T",
      fetchFn: async (url) => {
        const data = { models: [row({ id: "gpt-6-astra" })], agents: [{ name: "cli", models: ["gpt-6-astra"] }] };
        return { ok: true, status: 200, json: async () => ({ code: 0, data }), text: async () => "" };
      },
    });
    // Agent-listed trust would keep it; the recorded 11102 has to win — and it wins on a
    // poll, which does not probe anything it can decide from a report.
    expect(result.models.map((m) => m.id)).not.toContain("gpt-6-astra");
  });
});

describe("codebuddy final-review fixes", () => {
  beforeEach(() => clearCodeBuddyCatalogCache());

  it("shares one probe pass between concurrent callers", async () => {
    let chats = 0;
    const slow = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) {
        const data = { models: [row({ id: "glm-5.0-turbo" })], agents: [] };
        return { ok: true, status: 200, json: async () => ({ code: 0, data }), text: async () => "" };
      }
      chats++;
      await new Promise((r) => setTimeout(r, 30));
      const body = JSON.parse(opts.body);
      // Only the ambiguous id refuses a bare request; the routers answer as they do live.
      if (body.model === "glm-5.0-turbo" && !body.reasoning_effort) return { ok: false, status: 400, json: async () => ({}), text: async () => `data: ${JSON.stringify({ code: 11150 })}` };
      return chatReply(body.model);
    };
    const [a, b] = await Promise.all([
      verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: slow }),
      verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: slow }),
    ]);
    expect(a.models.map((m) => m.id)).toEqual(b.models.map((m) => m.id));
    // 1 ambiguous id × 2 shapes (bare + effort) + 4 routers, once — not twice.
    expect(chats).toBeLessThanOrEqual(6);
  });

  it("treats a reasoning-only reply as an answer, not an inconclusive probe", async () => {
    const fn = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) {
        const data = { models: [row({ id: "think-only" })], agents: [] };
        return { ok: true, status: 200, json: async () => ({ code: 0, data }), text: async () => "" };
      }
      return {
        ok: true, status: 200, json: async () => ({}),
        text: async () => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`,
      };
    };
    const first = await verified({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: fn });
    expect(first.models.map((m) => m.id)).toContain("think-only");
    let secondCalls = 0;
    const counting = async (url, opts) => { if (!url.endsWith("/v3/config")) secondCalls++; return fn(url, opts); };
    await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn: counting });
    expect(secondCalls).toBe(0);   // verdict cached → no re-probe loop
  });

  it("budgets the LONGEST window the gateway offers, not a client-side default", () => {
    // supportedLengths / defaultLength are desktop-app history budgets, not wire
    // parameters: a 493,746-token prompt was accepted with no opt-in (measured 2026-11-06).
    const models = normalizeCodeBuddyModels(payload([
      row({ id: "kimi-k2.8-preview", maxInputTokens: 1000000, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1000000] } }),
      row({ id: "hy4free", maxInputTokens: 960000, maxAllowedSize: 960000 }),
      row({ id: "narrow", maxInputTokens: 96000, contextWindow: { supportedLengths: [32000, 64000] } }),
    ]), "codebuddy-cn");
    expect(models.find((m) => m.id === "kimi-k2.8-preview").contextLength).toBe(1000000);
    expect(models.find((m) => m.id === "hy4free").contextLength).toBe(960000);
    expect(models.find((m) => m.id === "narrow").contextLength).toBe(96000);
  });
});

// The point of the overlay: what /v1/models advertises and what the chat path believes
// must be the same numbers. Before it, the router read the static tables for a live-only
// id and got DEFAULT_CAPABILITIES — measured against the account table, 31 of 33 chat ids
// disagreed, mostly on maxOutput (262144 believed, 32000 real).
import { clearLiveCapabilities } from "open-sse/providers/liveCapabilities.js";

describe("live capability overlay reaches the router", () => {
  beforeEach(() => { clearCodeBuddyCatalogCache(); clearLiveCapabilities(); });

  it("publishes the verified rows so getCapabilitiesForModel uses them", async () => {
    const table = [
      row({ id: "hunyuan-chat", supportsReasoning: false, supportsImages: false, maxInputTokens: 200000, maxOutputTokens: 8192 }),
      row({ id: "step-5-preview", supportsImages: true, maxInputTokens: 1000000, maxOutputTokens: 64000 }),
    ];
    const fetchFn = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) return { ok: true, status: 200, json: async () => ({ code: 0, data: { models: table, agents: [] } }), text: async () => "" };
      return chatReply(JSON.parse(opts.body).model);
    };
    const before = getCapabilitiesForModel("codebuddy-cn", "hunyuan-chat");
    expect(before.reasoning).toBe(true);        // heuristic guess
    expect(before.maxOutput).not.toBe(8192);

    await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn });

    const after = getCapabilitiesForModel("codebuddy-cn", "hunyuan-chat");
    expect(after.reasoning).toBe(false);        // the table's own answer
    expect(after.maxOutput).toBe(8192);
    expect(getCapabilitiesForModel("codebuddy-cn", "step-5-preview").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("codebuddy-cn", "step-5-preview").vision).toBe(true);
  });

  it("does not leak the overlay onto another provider", async () => {
    const fetchFn = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) return { ok: true, status: 200, json: async () => ({ code: 0, data: { models: [row({ id: "glm-5.3", maxOutputTokens: 64000 })], agents: [] } }), text: async () => "" };
      return chatReply(JSON.parse(opts.body).model);
    };
    await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn });
    expect(getCapabilitiesForModel("codebuddy-cn", "glm-5.3").maxOutput).toBe(64000);
    expect(getCapabilitiesForModel("some-other-provider", "glm-5.3").maxOutput).not.toBe(64000);
  });

  it("answers the same way for the wire alias the chat path uses", async () => {
    // cbcn/… is what a client sends and what /api/models passes to this function; the
    // overlay is keyed by provider id. A miss here would advertise the table's numbers
    // and route with the heuristic ones — the exact split brain the overlay closes.
    const fetchFn = async (url, opts = {}) => {
      if (url.endsWith("/v3/config")) return { ok: true, status: 200, json: async () => ({ code: 0, data: { models: [row({ id: "glm-5.3", maxOutputTokens: 64000, supportsToolCall: false })], agents: [] } }), text: async () => "" };
      return chatReply(JSON.parse(opts.body).model);
    };
    await resolveCodeBuddyModels({ providerId: "codebuddy-cn", accessToken: "T", fetchFn });
    expect(getCapabilitiesForModel("cbcn", "glm-5.3").maxOutput).toBe(64000);
    expect(getCapabilitiesForModel("cbcn", "glm-5.3").tools).toBe(false);
    expect(getCapabilitiesForModel("cbcn", "cbcn/glm-5.3").maxOutput).toBe(64000);
  });
});

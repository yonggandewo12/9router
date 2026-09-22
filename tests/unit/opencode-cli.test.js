import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";

const { spawnMock, DATA_DIR } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  DATA_DIR: `${(process.env.TMPDIR || "/tmp").replace(/\/$/, "")}/9router-opencode-cli-test`,
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
// Keep the pinned workspace writes out of the real ~/.9router.
vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyFetch: vi.fn((url) => fetch(url)),
  proxyAwareFetch: vi.fn((url, options) => fetch(url, options)),
}));

import {
  normalizeConversation,
  buildCliArgs,
  runOpenCodeCli,
  isOpenCodeCliAvailable,
  listCliFreeModels,
} from "../../open-sse/executors/opencode-cli.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { resolveSessionId } from "../../open-sse/utils/sessionManager.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill() { this.killed = true; }
}

let children = [];
beforeEach(() => {
  children = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  process.env.OPENCODE_TRANSPORT = "cli";
});

function lastArgs() {
  return spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];
}

function evt(obj) { return JSON.stringify(obj) + "\n"; }

async function readAll(response) {
  return response.text();
}

const USER = (text) => ({ role: "user", content: text });
const ASSISTANT = (text) => ({ role: "assistant", content: text });
const SYS = (text) => ({ role: "system", content: text });

describe("normalizeConversation", () => {
  it("collects image parts from every wire shape as attachments", () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    const chat = normalizeConversation({
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ] }],
    });
    expect(chat.turns[0].text).toContain("[image #1]");
    expect(chat.images).toEqual([{ base64: png, mime: "image/png" }]);

    const claude = normalizeConversation({
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } }] },
      ],
    });
    expect(claude.images).toEqual([{ base64: png, mime: "image/jpeg" }]);

    const responses = normalizeConversation({
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x.test/a.png" }] }],
    });
    expect(responses.images).toEqual([{ url: "https://x.test/a.png" }]);
  });

  it("caps attachments and marks the overflow as omitted", () => {
    const blocks = Array.from({ length: 10 }, () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA=="} }));
    const { turns, images } = normalizeConversation({ messages: [{ role: "user", content: blocks }] });
    expect(images).toHaveLength(8);
    expect(turns[0].text.match(/\[image #\d\]/g)).toHaveLength(8);
    expect(turns[0].text).toContain("[image omitted]");
  });

  it("flattens chat bodies and lifts system messages out", () => {
    const { system, turns } = normalizeConversation({
      messages: [
        { role: "system", content: "be terse" },
        USER("hi"),
        { role: "assistant", content: "yo", tool_calls: [{ id: "c1", function: { name: "get_weather" } }] },
        { role: "tool", tool_call_id: "c1", content: "sunny" },
        USER("and now?"),
      ],
    });
    expect(system).toBe("be terse");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(turns[2].text).toContain("get_weather");
    expect(turns[2].text).toContain("sunny");
  });

  it("handles claude content blocks and responses input items", () => {
    const claude = normalizeConversation({
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: {} }] }],
    });
    expect(claude.system).toBe("sys");
    expect(claude.turns[0].text).toContain("look");
    expect(claude.turns[0].text).toContain("image omitted");

    const responses = normalizeConversation({
      input: [
        { type: "reasoning", id: "r1" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "function_call", name: "bash", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "x", output: "file list" },
      ],
    });
    expect(responses.turns.map((t) => t.role)).toEqual(["user", "assistant", "tool"]);
    expect(responses.turns[1].text).toContain("bash");
  });
});

describe("buildCliArgs", () => {
  it("prefixes the model and maps a thinking suffix onto --variant", () => {
    const args = buildCliArgs({ model: "muse-spark-1.3-contributor-free(xhigh)", body: {}, sid: "ses_abc", prompt: "hi" });
    expect(args.slice(0, 6)).toEqual(["run", "--format", "json", "-m", "opencode/muse-spark-1.3-contributor-free", "--variant"]);
    expect(args).toContain("xhigh");
    expect(args).toContain("-s");
    expect(args.at(-1)).toBe("hi");
  });

  it("separates the prompt with -- so the array-valued --file cannot swallow it", () => {
    // Live failure being guarded: without `--`, opencode consumes the prompt as a
    // second --file value and dies with "File not found: <prompt>".
    expect(buildCliArgs({ model: "big-pickle", body: {}, sid: null, prompt: "hi there", files: ["/tmp/a.png", "/tmp/b.png"] }))
      .toEqual([
        "run", "--format", "json",
        "-m", "opencode/big-pickle",
        "--file", "/tmp/a.png",
        "--file", "/tmp/b.png",
        "--", "hi there",
      ]);
  });

  it("forwards reasoning_effort for models that declare levels, drops it otherwise", () => {
    // Muse declares openai-style levels, so a plain effort is forwarded verbatim.
    const muse = buildCliArgs({ model: "muse-spark-1.3-contributor-free", body: { reasoning_effort: "low" }, sid: null, prompt: "p" });
    expect(muse).toContain("low");
    expect(muse).not.toContain("-s");

    // big-pickle declares no thinking levels → an arbitrary effort must not reach the CLI.
    const plain = buildCliArgs({ model: "big-pickle", body: { reasoning_effort: "low" }, sid: null, prompt: "p" });
    expect(plain).not.toContain("--variant");
    expect(plain).not.toContain("low");

    // max is not selectable on Muse → clamps to the highest declared level (xhigh),
    // mirroring the HTTP transport's normalizeOpencodeReasoning.
    const clamped = buildCliArgs({ model: "muse-spark-1.3-contributor-free(max)", body: {}, sid: null, prompt: "p" });
    expect(clamped).toContain("xhigh");
    expect(clamped).not.toContain("max");

    // "none"/"auto" never become variants.
    const off = buildCliArgs({ model: "muse-spark-1.3-contributor-free(none)", body: {}, sid: null, prompt: "p" });
    expect(off).not.toContain("--variant");
  });
});

describe("session continuity", () => {
  // Drives one full turn through the public API and returns the spawn argv.
  async function takeTurn({ ids, messages, model = "big-pickle", reply = "the reply", sid = "ses_keep" }) {
    const before = children.length;
    const result = await runOpenCodeCli({ model, body: { messages }, ...ids });
    expect(children.length).toBe(before + 1);
    const child = children.at(-1);
    child.stdout.emit("data", Buffer.from(evt({ type: "text", sessionID: sid, part: { text: reply } })));
    child.emit("close", 0);
    await readAll(result.response);
    return lastArgs();
  }

  it("reuses the opencode session and sends only the new tail", async () => {
    const ids = { credentials: { connectionId: "conn-keep" }, providerSessionId: "conv-keep" };
    const first = await takeTurn({ ids, messages: [USER("one")] });
    expect(first).not.toContain("-s");

    const second = await takeTurn({
      ids,
      messages: [USER("one"), ASSISTANT("the reply"), USER("two")],
    });
    expect(second).toContain("-s");
    expect(second[second.indexOf("-s") + 1]).toBe("ses_keep");
    expect(second.at(-1)).toBe("user: two");
  });

  it("replays everything when the client edited an earlier turn", async () => {
    const ids = { credentials: { connectionId: "conn-edit" }, providerSessionId: "conv-edit" };
    await takeTurn({ ids, messages: [USER("one")] });
    const args = await takeTurn({ ids, messages: [USER("one edited"), ASSISTANT("the reply"), USER("two")] });
    expect(args).not.toContain("-s");
    expect(args.at(-1)).toContain("one edited");
    expect(args.at(-1)).toContain("two");
  });

  it("keeps parallel conversations under one connection on separate sessions", async () => {
    const ids = { credentials: { connectionId: "conn-parallel" }, providerSessionId: "conv-parallel" };
    const a1 = await takeTurn({ ids, messages: [USER("topic A question")], reply: "A-answer", sid: "ses_a" });
    const b1 = await takeTurn({ ids, messages: [USER("topic B question")], reply: "B-answer", sid: "ses_b" });
    expect(a1).not.toContain("-s");
    expect(b1).not.toContain("-s"); // conversation B must not hijack A's session slot

    const a2 = await takeTurn({
      ids,
      messages: [USER("topic A question"), ASSISTANT("A-answer"), USER("follow up A")],
      reply: "A2", sid: "ses_a2",
    });
    expect(a2[a2.indexOf("-s") + 1]).toBe("ses_a"); // A still continues its own session
    expect(a2.at(-1)).toBe("user: follow up A");
  });

  it("replays everything when the system prompt changed", async () => {
    const ids = { credentials: { connectionId: "conn-sys" }, providerSessionId: "conv-sys" };
    await takeTurn({ ids, messages: [SYS("style a"), USER("one")] });
    const args = await takeTurn({
      ids,
      messages: [SYS("style b"), USER("one"), ASSISTANT("the reply"), USER("two")],
    });
    expect(args).not.toContain("-s");
    expect(args.at(-1)).toContain("style b");
  });
});

describe("runOpenCodeCli", () => {
  it("re-emits CLI events as OpenAI SSE with real token usage", async () => {
    process.env.OPENCODE_TRANSPORT = "cli";
    const result = await runOpenCodeCli({
      model: "nemotron-3.5-lightning-free",
      body: { messages: [USER("hi")] },
      credentials: { connectionId: "conn-emit" },
      providerSessionId: "conv-emit",
    });
    expect(result.responseFormat).toBe("openai");
    expect(result.url).toBe("opencode-cli://run");
    expect(result.response.status).toBe(200);
    expect(lastArgs().slice(0, 5)).toEqual(["run", "--format", "json", "-m", "opencode/nemotron-3.5-lightning-free"]);

    const child = children.at(-1);
    child.stdout.emit("data", Buffer.from(evt({ type: "text", sessionID: "ses_emit", part: { text: "hel" } })));
    child.stdout.emit("data", Buffer.from(evt({ type: "text", part: { text: "lo" } })));
    child.stdout.emit("data", Buffer.from(evt({ type: "step_finish", part: { tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 40 } }, cost: 0 } })));
    child.stdout.emit("data", Buffer.from("not json at all\n"));
    child.emit("close", 0);

    const sse = await readAll(result.response);
    const dataLines = sse.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    expect(dataLines.at(-1)).toBe("[DONE]");
    const chunks = dataLines.filter((l) => l !== "[DONE]").map((l) => JSON.parse(l));
    const contents = chunks.filter((c) => c.choices?.[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content);
    expect(contents.join("")).toBe("hello");
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const final = chunks.filter((c) => c.choices?.[0]?.finish_reason).at(-1);
    expect(final.choices[0].finish_reason).toBe("stop");
    expect(final.usage).toEqual({ prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 });
  });

  it("surfaces a CLI error event instead of faking success", async () => {
    const result = await runOpenCodeCli({
      model: "mimo-v2.5-free",
      body: { messages: [USER("hi")] },
      credentials: { connectionId: "conn-err" },
      providerSessionId: "conv-err",
    });
    const child = children.at(-1);
    child.stdout.emit("data", Buffer.from(evt({
      type: "error",
      sessionID: "ses_err",
      error: { name: "APIError", data: { message: "OpenCode's free tier can only be used from within OpenCode", statusCode: 403 } },
    })));
    child.emit("close", 1);
    const sse = await readAll(result.response);
    expect(sse).toContain('"type":"opencode_cli_error"');
    expect(sse).toContain("only be used from within OpenCode");
    expect(sse).toContain('"code":"403"');
    expect(sse).not.toContain("[DONE]");

    // A failed turn must not leave a half-recorded session behind: the next
    // request in the same conversation starts clean rather than passing -s.
    const retry = await runOpenCodeCli({
      model: "mimo-v2.5-free",
      body: { messages: [USER("hi")] },
      credentials: { connectionId: "conn-err" },
      providerSessionId: "conv-err",
    });
    expect(lastArgs()).not.toContain("-s");
    children.at(-1).emit("close", 0);
    await readAll(retry.response);
  });

  it("materializes base64 images into --file attachments and removes them after the turn", async () => {
    const png = Buffer.from("fake-png-bytes").toString("base64");
    const result = await runOpenCodeCli({
      model: "muse-spark-1.3-contributor-free",
      body: {
        messages: [{ role: "user", content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
        ] }],
      },
      credentials: { connectionId: "conn-img" },
      providerSessionId: "conv-img",
    });
    const args = lastArgs();
    expect(args).toContain("--file");
    const file = args[args.indexOf("--file") + 1];
    expect(file.endsWith(".png")).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    const child = children.at(-1);
    child.stdout.emit("data", Buffer.from(evt({ type: "text", sessionID: "ses_img", part: { text: "a picture" } })));
    child.emit("close", 0);
    await readAll(result.response);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("treats a text-less CLI exit as an error instead of an empty success", async () => {
    const result = await runOpenCodeCli({
      model: "nemotron-3.5-lightning-free",
      body: { messages: [USER("hi")] },
      credentials: { connectionId: "conn-empty-text" },
      providerSessionId: "conv-empty-text",
    });
    const child = children.at(-1);
    // Upstream can drop the request silently: step events, no text, clean exit.
    child.stdout.emit("data", Buffer.from(evt({ type: "step_start", sessionID: "ses_empty" })));
    child.stdout.emit("data", Buffer.from(evt({ type: "step_finish", part: { tokens: { input: 10, output: 0 }, reason: "stop" } })));
    child.stderr.emit("data", Buffer.from("gateway closed without a completion"));
    child.emit("close", 0);

    const sse = await readAll(result.response);
    expect(sse).toContain("returned no assistant text");
    expect(sse).toContain("gateway closed without a completion");
    expect(sse).toContain('"code":"empty_reply"');
    expect(sse).not.toContain("[DONE]");
  });

  it("gives concurrent identical images distinct attachment files", async () => {
    const png = Buffer.from("identical-bytes").toString("base64");
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
    ] }] };
    const a = await runOpenCodeCli({ model: "big-pickle", body, credentials: { connectionId: "conn-race-a" }, providerSessionId: "conv-race-a" });
    const argsA = lastArgs();
    const b = await runOpenCodeCli({ model: "big-pickle", body, credentials: { connectionId: "conn-race-b" }, providerSessionId: "conv-race-b" });
    const argsB = lastArgs();
    const fileA = argsA[argsA.indexOf("--file") + 1];
    const fileB = argsB[argsB.indexOf("--file") + 1];
    expect(fileA).not.toBe(fileB);

    // A finishing and cleaning up must not unlink B's in-flight attachment.
    children[0].stdout.emit("data", Buffer.from(evt({ type: "text", sessionID: "ses_a", part: { text: "ok" } })));
    children[0].emit("close", 0);
    await readAll(a.response);
    expect(fs.existsSync(fileA)).toBe(false);
    expect(fs.existsSync(fileB)).toBe(true);

    children[1].stdout.emit("data", Buffer.from(evt({ type: "text", sessionID: "ses_b", part: { text: "ok" } })));
    children[1].emit("close", 0);
    await readAll(b.response);
    expect(fs.existsSync(fileB)).toBe(false);
  });

  it("reports a spawn failure as an error frame", async () => {
    const result = await runOpenCodeCli({
      model: "big-pickle",
      body: { messages: [USER("hi")] },
      credentials: { connectionId: "conn-spawn" },
      providerSessionId: "conv-spawn",
    });
    const child = children.at(-1);
    child.emit("error", Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }));
    const sse = await readAll(result.response);
    expect(sse).toContain("opencode CLI not found");
  });

  it("ignores the request when there is no text to send", async () => {
    const result = await runOpenCodeCli({
      model: "big-pickle",
      body: { messages: [{ role: "system", content: "only system" }] },
      credentials: { connectionId: "conn-empty" },
      providerSessionId: "conv-empty",
    });
    expect(result.response.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("translated claude client → CLI continuation", () => {
  // Mirrors what chatCore actually hands the executor for a Claude Code client:
  // the claude body translated to openai (system becomes messages[0]) plus the
  // sessionSeed from sessionManager. Continuity must survive that real shape.
  const SYSTEM = "Answer with the exact words requested.";
  const ASK = "Reply with exactly: chain-alpha";
  const blocks = (t) => [{ type: "text", text: t }];
  const headers = { "user-agent": "claude-cli/2.0" };

  async function turn(claudeBody, seed, reply) {
    const translated = translateRequest(
      FORMATS.CLAUDE, FORMATS.OPENAI, "nemotron-3.5-lightning-free",
      structuredClone(claudeBody), false, {}, "opencode"
    );
    const before = children.length;
    const result = await runOpenCodeCli({
      model: "nemotron-3.5-lightning-free",
      body: translated,
      credentials: { connectionId: "conn-translated" },
      providerSessionId: seed,
    });
    expect(children.length).toBe(before + 1);
    const child = children.at(-1);
    child.stdout.emit("data", Buffer.from(evt({ type: "text", sessionID: "ses_translated", part: { text: reply } })));
    child.emit("close", 0);
    await readAll(result.response);
    return lastArgs();
  }

  it("sends only the delta on the follow-up turn", async () => {
    const turn1 = { model: "oc/x", system: SYSTEM, messages: [{ role: "user", content: blocks(ASK) }] };
    const turn2 = { model: "oc/x", system: SYSTEM, messages: [
      { role: "user", content: blocks(ASK) },
      { role: "assistant", content: blocks("chain-alpha") },
      { role: "user", content: blocks("Which phrase did I ask for? Reply with it only.") },
    ] };
    const seed1 = resolveSessionId({ headers, body: turn1, connectionId: "conn-translated", scope: "opencode" });
    const seed2 = resolveSessionId({ headers, body: turn2, connectionId: "conn-translated", scope: "opencode" });
    expect(seed2).toBe(seed1);

    const firstArgs = await turn(turn1, seed1, "chain-alpha");
    expect(firstArgs).not.toContain("-s");

    const secondArgs = await turn(turn2, seed2, "chain-alpha");
    expect(secondArgs).toContain("-s");
    expect(secondArgs[secondArgs.indexOf("-s") + 1]).toBe("ses_translated");
    expect(secondArgs.at(-1)).toBe("user: Which phrase did I ask for? Reply with it only.");
  });
});

describe("CLI free-model whitelist", () => {
  it("parses the CLI's own listing into a set of servable ids", async () => {
    const pending = listCliFreeModels({ ttlMs: 0 });
    const child = children.at(-1);
    child.stdout.emit("data", Buffer.from("\n\u001b[1mopencode/big-pickle\nopencode/nemotron-3.5-lightning-free\r\nsome header\n"));
    child.emit("close", 0);
    expect([...(await pending)]).toEqual(["big-pickle", "nemotron-3.5-lightning-free"]);
  });

  it("returns null on a non-zero exit (caller falls back to suffix filtering)", async () => {
    const pending = listCliFreeModels({ ttlMs: 0 });
    children.at(-1).emit("close", 1);
    expect(await pending).toBeNull();
  });

  it("sits out a backoff window after a failure instead of re-spawning", async () => {
    // Relies on the previous test having just failed the probe.
    const before = spawnMock.mock.calls.length;
    expect(await listCliFreeModels({ ttlMs: 0 })).toBeNull();
    expect(spawnMock.mock.calls.length).toBe(before);
  });
});

describe("transport selection", () => {
  it("OPENCODE_TRANSPORT=http disables the CLI even when installed", async () => {
    process.env.OPENCODE_TRANSPORT = "http";
    expect(await isOpenCodeCliAvailable()).toBe(false);
  });

  it("OPENCODE_TRANSPORT=cli forces it on", async () => {
    process.env.OPENCODE_TRANSPORT = "cli";
    expect(await isOpenCodeCliAvailable()).toBe(true);
  });
});

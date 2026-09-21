// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Provider cần executor riêng (buildUrl/buildHeaders không nằm ở DefaultExecutor) → bỏ qua ở golden này.
// Chúng được lock riêng ở 11-provider edge tests / unit test chuyên biệt.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan",
  // Signs every request with a Huawei SDK-HMAC-SHA256 signature instead of
  // carrying a bearer key — locking it here would freeze DefaultExecutor's
  // output and call it the contract. Locked in tests/unit/codearts.test.js.
  "codearts",
]);

// Sanitize header:  khử token + field thời gian động (kimi X-Msh-Device-Id) để snapshot ổn định.
// Machine-derived identity headers: lock presence only (Linux CI ≠ dev Mac).
// X-Msh-Version is the app version, so it changes on every release bump.
const VOLATILE_HEADER_NAME = /^(x-platform(-version)?|x-msh-device-(id|model|name)|x-msh-version)$/i;
function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    // Lock the *presence* of machine-derived headers, never their values
    // (cline X-PLATFORM*, kimi X-Msh-Device-*) — snapshots must pass on Linux CI.
    if (VOLATILE_HEADER_NAME.test(k)) {
      out[k] = "<VOLATILE>";
      continue;
    }
    out[k] = typeof v === "string"
      ? v.replace(/Bearer .+/, "Bearer <TOK>")
          .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
          .replace(/kimi-\d{10,}/g, "kimi-<TS>")
          // Release bumps must not break the golden file (UA / X-*-VERSION headers).
          .replace(/\b\d+\.\d+\.\d+\b/g, "<VER>")
      : v;
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}

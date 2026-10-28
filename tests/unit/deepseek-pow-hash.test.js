// The PoW solver is vendored (upstream v0.5.112 ported it to a noble-hashes
// keccak) and ships as a loose runtime asset that a worker thread imports from
// its own directory — the exact file whose absence broke 0.6.16. There is no
// live-cookie test that reaches it, so pin the surface the worker and the solver
// wrapper depend on, and that an unsolvable target costs bounded time instead of
// spinning.
import { describe, expect, it } from "vitest";

import { findDeepSeekPowNonce, MAX_DEEPSEEK_POW_DIFFICULTY } from "../../open-sse/lib/deepseek-pow-hash.js";

describe("DeepSeek PoW hash module", () => {
  it("exports what the worker and the solver wrapper import", () => {
    expect(typeof findDeepSeekPowNonce).toBe("function");
    expect(MAX_DEEPSEEK_POW_DIFFICULTY).toBe(250000);
  });

  it("returns -1 within the attempt budget when no nonce matches", () => {
    // The acceptance rule is a full 32-byte digest equality, so a random target
    // is unsolvable: the point here is a bounded search, not a found nonce.
    const started = Date.now();
    const nonce = findDeepSeekPowNonce("probe", "00".repeat(32), 20000);
    expect(nonce).toBe(-1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not throw on a short challenge (the wrapper validates first)", () => {
    expect(() => findDeepSeekPowNonce("probe", "abcd", 10)).not.toThrow();
  });
});

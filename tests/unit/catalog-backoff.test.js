// /v1/models is polled by clients; a connection whose live catalog cannot be
// fetched must not pay a rejected round trip (and a log line) on every poll.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  catalogFetchInBackoff,
  clearCatalogFetchBackoff,
  noteCatalogFetchFailure,
  __resetCatalogBackoffForTest,
} from "../../open-sse/services/catalogBackoff.js";

beforeEach(() => __resetCatalogBackoffForTest());

describe("catalog fetch backoff", () => {
  it("is clear until a failure is noted", () => {
    expect(catalogFetchInBackoff("codearts:conn-1")).toBe(false);
    noteCatalogFetchFailure("codearts:conn-1");
    expect(catalogFetchInBackoff("codearts:conn-1")).toBe(true);
    expect(catalogFetchInBackoff("codearts:conn-2")).toBe(false);
  });

  it("a success clears the entry so a recovered connection is re-probed", () => {
    noteCatalogFetchFailure("cursor:dead");
    clearCatalogFetchBackoff("cursor:dead");
    expect(catalogFetchInBackoff("cursor:dead")).toBe(false);
  });

  it("expires on its own", () => {
    vi.useFakeTimers();
    try {
      noteCatalogFetchFailure("zed:x");
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      expect(catalogFetchInBackoff("zed:x")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

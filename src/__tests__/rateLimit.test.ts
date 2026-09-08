import {describe, expect, it} from "vitest";

import {createRateLimiter} from "../rateLimit";

describe("createRateLimiter", () => {
  it("allows up to the limit inside the window, then reports the wait", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.take("bot", 0)).toEqual({ allowed: true });
    expect(limiter.take("bot", 100)).toEqual({ allowed: true });

    const denied = limiter.take("bot", 200);
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.retryAfterMs).toBe(800);
  });

  it("frees a slot once the oldest hit leaves the window", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.take("bot", 0).allowed).toBe(true);
    expect(limiter.take("bot", 999).allowed).toBe(false);
    expect(limiter.take("bot", 1001).allowed).toBe(true);
  });

  it("counts each key separately", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.take("bot-a", 0).allowed).toBe(true);
    expect(limiter.take("bot-b", 0).allowed).toBe(true);
    expect(limiter.take("bot-a", 0).allowed).toBe(false);
  });
});

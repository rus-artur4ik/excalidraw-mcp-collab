export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type RateLimiter = {
  /** Records a hit and reports whether it fit inside the window. */
  take: (key: string, now?: number) => RateLimitVerdict;
};

// In-memory sliding window. The service is single-process by design (see
// README "Deploy notes"), so this needs no shared store; it exists to keep a
// looping agent from filling the owner's board list, not to be a security
// boundary — the per-bot permission is.
export const createRateLimiter = (opts: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter => {
  const { limit, windowMs, maxKeys = 500 } = opts;
  const hits = new Map<string, number[]>();

  const prune = (cutoff: number): void => {
    for (const [key, times] of hits) {
      const recent = times.filter((at) => at > cutoff);
      if (recent.length) {
        hits.set(key, recent);
      } else {
        hits.delete(key);
      }
    }
  };

  return {
    take: (key, now = Date.now()) => {
      const cutoff = now - windowMs;
      if (hits.size > maxKeys) {
        prune(cutoff);
      }
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { allowed: false, retryAfterMs: recent[0] + windowMs - now };
      }
      recent.push(now);
      hits.set(key, recent);
      return { allowed: true };
    },
  };
};

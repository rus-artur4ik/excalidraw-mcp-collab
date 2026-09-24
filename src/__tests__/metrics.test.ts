import http from "http";
import type {AddressInfo} from "net";

import {afterEach, describe, expect, it, vi} from "vitest";

const queries: string[] = [];

vi.mock("../firebase", () => {
  const counts: Record<string, number> = {
    "boards": 42,
    "boards|archived==true": 5,
    "scenes|updatedAt>=24h": 2,
    "scenes|updatedAt>=7d": 9,
  };
  const DAY = 24 * 60 * 60_000;
  const NOW = 1_000 * DAY;
  const query = (key: string) => ({
    where: (field: string, op: string, value: unknown) => {
      const suffix =
        field === "updatedAt"
          ? `${field}${op}${value === NOW - DAY ? "24h" : value === NOW - 7 * DAY ? "7d" : String(value)}`
          : `${field}${op}${String(value)}`;
      return query(`${key}|${suffix}`);
    },
    count: () => ({
      get: async () => {
        queries.push(key);
        return {data: () => ({count: counts[key] ?? -1})};
      },
    }),
  });
  return {
    auth: () => ({}),
    db: () => ({collection: (name: string) => query(name)}),
  };
});

import {loadBoardStats} from "../boardStats";
import {
  countConnect,
  countToolCall,
  renderMetrics,
  resetMetricsForTest,
  setBoardStats,
  startBoardStatsRefresher,
  startMetricsServer,
} from "../metrics";

const DAY = 24 * 60 * 60_000;

afterEach(() => {
  resetMetricsForTest();
  queries.length = 0;
});

describe("renderMetrics", () => {
  it("renders connect and tool counters", () => {
    countConnect("missing_token");
    countConnect("missing_token");
    countConnect("ok");
    countToolCall("create_elements", "ok");
    countToolCall("create_elements", "ok");
    countToolCall("create_elements", "error");
    countToolCall("list_boards", "ok");
    const text = renderMetrics();
    expect(text).toContain('excalidraw_mcp_connects_total{result="missing_token"} 2\n');
    expect(text).toContain('excalidraw_mcp_connects_total{result="ok"} 1\n');
    expect(text).toContain('excalidraw_mcp_connects_total{result="invalid_token"} 0\n');
    expect(text).toContain('excalidraw_mcp_tool_calls_total{tool="create_elements",result="ok"} 2\n');
    expect(text).toContain('excalidraw_mcp_tool_calls_total{tool="create_elements",result="error"} 1\n');
    expect(text).toContain('excalidraw_mcp_tool_calls_total{tool="list_boards",result="ok"} 1\n');
  });

  it("omits board gauges until the first refresh, then renders them", () => {
    expect(renderMetrics()).not.toContain("excalidraw_boards{");
    setBoardStats({active: 37, archived: 5, edited24h: 2, edited7d: 9}, 1_700_000_000_500);
    const text = renderMetrics();
    expect(text).toContain('excalidraw_boards{state="active"} 37\n');
    expect(text).toContain('excalidraw_boards{state="archived"} 5\n');
    expect(text).toContain('excalidraw_boards_edited{window="24h"} 2\n');
    expect(text).toContain('excalidraw_boards_edited{window="7d"} 9\n');
    expect(text).toContain("excalidraw_board_stats_refreshed_timestamp_seconds 1700000000\n");
  });
});

describe("loadBoardStats", () => {
  it("derives active boards from total minus archived and counts edited scenes", async () => {
    const stats = await loadBoardStats(1_000 * DAY);
    expect(stats).toEqual({active: 37, archived: 5, edited24h: 2, edited7d: 9});
    expect(queries.sort()).toEqual([
      "boards",
      "boards|archived==true",
      "scenes|updatedAt>=24h",
      "scenes|updatedAt>=7d",
    ]);
  });
});

describe("startBoardStatsRefresher", () => {
  it("counts failures and keeps the last good value", async () => {
    setBoardStats({active: 1, archived: 0, edited24h: 0, edited7d: 1});
    const onError = vi.fn();
    const timer = startBoardStatsRefresher(async () => {
      throw new Error("quota");
    }, 60_000, onError);
    clearInterval(timer);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const text = renderMetrics();
    expect(text).toContain("excalidraw_board_stats_errors_total 1\n");
    expect(text).toContain('excalidraw_boards{state="active"} 1\n');
  });
});

describe("startMetricsServer", () => {
  it("is disabled by a zero port", () => {
    expect(startMetricsServer(0)).toBeNull();
  });

  it("serves /metrics and 404s everything else", async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));

    const server = startMetricsServer(port)!;
    await new Promise((resolve) => server.once("listening", resolve));
    const get = (path: string) =>
      new Promise<{status: number; body: string}>((resolve, reject) => {
        http
          .get({host: "127.0.0.1", port, path}, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({status: res.statusCode ?? 0, body}));
          })
          .on("error", reject);
      });
    try {
      const ok = await get("/metrics");
      expect(ok.status).toBe(200);
      expect(ok.body).toContain("excalidraw_mcp_connects_total");
      expect((await get("/healthz")).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

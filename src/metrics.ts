// Prometheus exposition for the access backend, without a client library.
// Served on its own port (METRICS_PORT, default 9464): the public proxy only
// routes /mcp, /files and /exports here, and a separate listener keeps scrapes
// out of the request log.
import http from "http";

export type ConnectResult = "ok" | "missing_token" | "invalid_token" | "bot_unavailable";
export type ToolResult = "ok" | "error";

export type BoardStats = {
  active: number;
  archived: number;
  edited24h: number;
  edited7d: number;
};

const connects: Record<ConnectResult, number> = {
  ok: 0,
  missing_token: 0,
  invalid_token: 0,
  bot_unavailable: 0,
};
// tool -> result -> count; tool names come from registerTool, a closed set.
const toolCalls = new Map<string, Record<ToolResult, number>>();
let boardStats: BoardStats | null = null;
let boardStatsAt = 0;
let boardStatsErrors = 0;

export const countConnect = (result: ConnectResult): void => {
  connects[result] += 1;
};

export const countToolCall = (tool: string, result: ToolResult): void => {
  const entry = toolCalls.get(tool) ?? { ok: 0, error: 0 };
  entry[result] += 1;
  toolCalls.set(tool, entry);
};

export const setBoardStats = (stats: BoardStats, at: number = Date.now()): void => {
  boardStats = stats;
  boardStatsAt = at;
};

export const countBoardStatsError = (): void => {
  boardStatsErrors += 1;
};

export const resetMetricsForTest = (): void => {
  (Object.keys(connects) as ConnectResult[]).forEach((key) => (connects[key] = 0));
  toolCalls.clear();
  boardStats = null;
  boardStatsAt = 0;
  boardStatsErrors = 0;
};

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export const renderMetrics = (): string => {
  const lines: string[] = [
    "# HELP excalidraw_mcp_connects_total MCP requests by how the connect token resolved.",
    "# TYPE excalidraw_mcp_connects_total counter",
    ...(Object.keys(connects) as ConnectResult[]).map(
      (key) => `excalidraw_mcp_connects_total{result="${key}"} ${connects[key]}`,
    ),
    "# HELP excalidraw_mcp_tool_calls_total MCP tool calls by tool and outcome.",
    "# TYPE excalidraw_mcp_tool_calls_total counter",
  ];
  for (const [tool, results] of [...toolCalls].sort(([a], [b]) => a.localeCompare(b))) {
    for (const result of Object.keys(results) as ToolResult[]) {
      lines.push(
        `excalidraw_mcp_tool_calls_total{tool="${escapeLabel(tool)}",result="${result}"} ${results[result]}`,
      );
    }
  }
  lines.push(
    "# HELP excalidraw_board_stats_errors_total Failed Firestore refreshes of the board gauges.",
    "# TYPE excalidraw_board_stats_errors_total counter",
    `excalidraw_board_stats_errors_total ${boardStatsErrors}`,
  );
  // Gauges appear only after the first successful refresh: a missing series
  // reads as "unknown", a zero would read as "no boards".
  if (boardStats) {
    lines.push(
      "# HELP excalidraw_boards Boards in Firestore by state.",
      "# TYPE excalidraw_boards gauge",
      `excalidraw_boards{state="active"} ${boardStats.active}`,
      `excalidraw_boards{state="archived"} ${boardStats.archived}`,
      "# HELP excalidraw_boards_edited Boards whose scene history got a new version within the window.",
      "# TYPE excalidraw_boards_edited gauge",
      `excalidraw_boards_edited{window="24h"} ${boardStats.edited24h}`,
      `excalidraw_boards_edited{window="7d"} ${boardStats.edited7d}`,
      "# HELP excalidraw_board_stats_refreshed_timestamp_seconds When the board gauges were last read from Firestore.",
      "# TYPE excalidraw_board_stats_refreshed_timestamp_seconds gauge",
      `excalidraw_board_stats_refreshed_timestamp_seconds ${Math.floor(boardStatsAt / 1000)}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

export const startMetricsServer = (port: number): http.Server | null => {
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.end(renderMetrics());
  });
  server.listen(port);
  return server;
};

// Refreshes the Firestore-backed gauges on a timer. Count aggregations cost one
// read per 1000 matched index entries, so four queries every 5 minutes stay
// around 1 200 reads a day on a small board collection.
export const startBoardStatsRefresher = (
  load: () => Promise<BoardStats>,
  intervalMs: number,
  onError: (error: unknown) => void = () => undefined,
): NodeJS.Timeout => {
  const tick = async () => {
    try {
      setBoardStats(await load());
    } catch (error) {
      countBoardStatsError();
      onError(error);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return timer;
};

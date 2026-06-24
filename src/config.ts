import "dotenv/config";

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const config = {
  port: Number(process.env.PORT ?? 3015),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "excalidraw-team",
  firebaseWebApiKey: required("FIREBASE_WEB_API_KEY", "MISSING_WEB_API_KEY"),
  wsServerUrl: process.env.WS_SERVER_URL ?? "http://localhost:3002",
  dataDir: process.env.DATA_DIR ?? "./data",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  internalSecret: process.env.INTERNAL_SECRET ?? "",
};

export const getMcpUrl = (port: number): string => {
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl.replace(/\/$/, "")}/mcp`;
  }
  return `http://localhost:${port}/mcp`;
};

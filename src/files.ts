import { promises as fs } from "fs";
import path from "path";

import { config } from "./config";
import { authorize, resolveIdentity } from "./acl";

import type { Request, Response } from "express";

const dataRoot = path.resolve(config.dataDir);

const sanitize = (relativePath: string): string | null => {
  const normalized = path
    .normalize(relativePath)
    .replace(/^(\.\.(\/|\\|$))+/, "");
  const absolute = path.resolve(dataRoot, normalized);
  if (absolute !== dataRoot && !absolute.startsWith(dataRoot + path.sep)) {
    return null;
  }
  return absolute;
};

const roomIdFromPath = (relativePath: string): string | null => {
  const match = relativePath.match(/^files\/rooms\/([^/]+)\//);
  return match ? match[1] : null;
};

const isShareLinkPath = (relativePath: string): boolean =>
  /^files\/shareLinks\//.test(relativePath);

const bearer = (req: Request): string | undefined => {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  return undefined;
};

const checkAccess = async (
  req: Request,
  relativePath: string,
  mode: "read" | "write",
): Promise<boolean> => {
  if (isShareLinkPath(relativePath)) {
    return true;
  }
  const roomId = roomIdFromPath(relativePath);
  if (!roomId) {
    return false;
  }
  const identity = await resolveIdentity(bearer(req));
  const access = await authorize(roomId, identity);
  return mode === "read" ? access.canRead : access.canWrite;
};

const relPath = (req: Request): string =>
  (req.params as { path?: string }).path ??
  req.path.replace(/^\//, "");

export async function putFile(req: Request, res: Response): Promise<void> {
  const relativePath = relPath(req);
  if (!(await checkAccess(req, relativePath, "write"))) {
    res.sendStatus(403);
    return;
  }
  const absolute = sanitize(relativePath);
  if (!absolute) {
    res.sendStatus(400);
    return;
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, req.body as Buffer);
  res.sendStatus(204);
}

export async function getFile(req: Request, res: Response): Promise<void> {
  const relativePath = relPath(req);
  if (!(await checkAccess(req, relativePath, "read"))) {
    res.sendStatus(403);
    return;
  }
  const absolute = sanitize(relativePath);
  if (!absolute) {
    res.sendStatus(400);
    return;
  }
  try {
    const data = await fs.readFile(absolute);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.send(data);
  } catch {
    res.sendStatus(404);
  }
}

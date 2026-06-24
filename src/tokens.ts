import { randomBytes } from "crypto";

import { db } from "./firebase";

import type { McpTokenDoc, Role } from "./types";

const COLLECTION = "mcpTokens";

export const generateToken = (): string => randomBytes(32).toString("hex");

export async function createToken(params: {
  uid: string;
  email: string | null;
  boardId: string;
  role: Role;
}): Promise<{ token: string; doc: McpTokenDoc }> {
  const token = generateToken();
  const doc: McpTokenDoc = {
    uid: params.uid,
    email: params.email,
    boardId: params.boardId,
    role: params.role,
    createdAt: Date.now(),
    revoked: false,
  };
  await db().collection(COLLECTION).doc(token).set(doc);
  return { token, doc };
}

export async function getToken(token: string): Promise<McpTokenDoc | null> {
  const snap = await db().collection(COLLECTION).doc(token).get();
  return snap.exists ? (snap.data() as McpTokenDoc) : null;
}

export async function listTokens(params: {
  uid: string;
  boardId?: string;
}): Promise<{ token: string; doc: McpTokenDoc }[]> {
  let query = db()
    .collection(COLLECTION)
    .where("uid", "==", params.uid) as FirebaseFirestore.Query;
  if (params.boardId) {
    query = query.where("boardId", "==", params.boardId);
  }
  const snap = await query.get();
  return snap.docs.map((d) => ({ token: d.id, doc: d.data() as McpTokenDoc }));
}

export async function revokeToken(token: string): Promise<void> {
  await db().collection(COLLECTION).doc(token).update({ revoked: true });
}

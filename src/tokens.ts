import {randomBytes} from "crypto";

import {db} from "./firebase";
import {logError, logInfo, opaqueRef} from "./logger";

import type {McpTokenDoc} from "./types";

const COLLECTION = "mcpTokens";

export const generateToken = (): string => randomBytes(32).toString("hex");

export async function createToken(params: {
  uid: string;
  email: string | null;
  botId?: string;
  name?: string | null;
}): Promise<{ token: string; doc: McpTokenDoc }> {
  const token = generateToken();
  const doc: McpTokenDoc = {
    uid: params.uid,
    email: params.email,
    createdAt: Date.now(),
    revoked: false,
    ...(params.botId ? { botId: params.botId } : {}),
    ...(params.name != null ? { name: params.name } : {}),
  };
  try {
    await db().collection(COLLECTION).doc(token).set(doc);
    logInfo("firestore.mcp_token.created", {
      tokenRef: opaqueRef(token),
    });
    return { token, doc };
  } catch (error) {
    logError("firestore.mcp_token.create_failed", error);
    throw error;
  }
}

export async function getToken(token: string): Promise<McpTokenDoc | null> {
  const tokenRef = opaqueRef(token);
  try {
    const snap = await db().collection(COLLECTION).doc(token).get();
    logInfo("firestore.mcp_token.loaded", {
      tokenRef,
      exists: snap.exists,
    });
    return snap.exists ? (snap.data() as McpTokenDoc) : null;
  } catch (error) {
    logError("firestore.mcp_token.load_failed", error, { tokenRef });
    throw error;
  }
}

export async function listTokens(params: {
  uid: string;
  botId?: string;
}): Promise<{ token: string; doc: McpTokenDoc }[]> {
  try {
    const snap = await db()
      .collection(COLLECTION)
      .where("uid", "==", params.uid)
      .get();
    const tokens = snap.docs
      .map((d) => ({ token: d.id, doc: d.data() as McpTokenDoc }))
      .filter(({ doc }) => !params.botId || doc.botId === params.botId);
    logInfo("firestore.mcp_token.listed", {
      botId: params.botId,
      count: tokens.length,
    });
    return tokens;
  } catch (error) {
    logError("firestore.mcp_token.list_failed", error, {
      botId: params.botId,
    });
    throw error;
  }
}

export async function touchToken(token: string): Promise<void> {
  try {
    await db()
      .collection(COLLECTION)
      .doc(token)
      .update({ lastUsedAt: Date.now() });
  } catch (error) {
    logError("firestore.mcp_token.touch_failed", error, {
      tokenRef: opaqueRef(token),
    });
  }
}

export async function revokeToken(token: string): Promise<void> {
  const tokenRef = opaqueRef(token);
  try {
    await db().collection(COLLECTION).doc(token).update({ revoked: true });
    logInfo("firestore.mcp_token.revoked", { tokenRef });
  } catch (error) {
    logError("firestore.mcp_token.revoke_failed", error, { tokenRef });
    throw error;
  }
}

import {randomBytes} from "crypto";

import {db} from "./firebase";
import {logError, logInfo, opaqueRef} from "./logger";

import type {McpTokenDoc} from "./types";

const COLLECTION = "mcpTokens";

export const generateToken = (): string => randomBytes(32).toString("hex");

export async function createToken(params: {
  uid: string;
  email: string | null;
  botId: string;
  name?: string;
}): Promise<{ token: string; doc: McpTokenDoc }> {
  const token = generateToken();
  const doc: McpTokenDoc = {
    uid: params.uid,
    email: params.email,
    botId: params.botId,
    name: params.name ?? "",
    createdAt: Date.now(),
    revoked: false,
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
  let query = db()
    .collection(COLLECTION)
    .where("uid", "==", params.uid) as FirebaseFirestore.Query;
  if (params.botId) {
    query = query.where("botId", "==", params.botId);
  }
  try {
    const snap = await query.get();
    logInfo("firestore.mcp_token.listed", {
      botId: params.botId,
      count: snap.size,
    });
    return snap.docs.map((d) => ({
      token: d.id,
      doc: d.data() as McpTokenDoc,
    }));
  } catch (error) {
    logError("firestore.mcp_token.list_failed", error, {
      botId: params.botId,
    });
    throw error;
  }
}

export async function countActiveTokensForBot(botId: string): Promise<number> {
  try {
    const snap = await db()
      .collection(COLLECTION)
      .where("botId", "==", botId)
      .where("revoked", "==", false)
      .get();
    return snap.size;
  } catch (error) {
    logError("firestore.mcp_token.count_failed", error, { botId });
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

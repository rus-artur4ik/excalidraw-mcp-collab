export type ExcalidrawElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  roundness: { type: number; value?: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  index: string | null;
  isDeleted: boolean;
  groupIds: string[];
  frameId: string | null;
  boundElements: { id: string; type: string }[] | null;
  updated: number;
  link: string | null;
  locked: boolean;
  [key: string]: unknown;
};

export type Role = "editor" | "viewer";

export type BotPolicy = "none" | "read" | "write";

export const DEFAULT_BOT_POLICY: BotPolicy = "write";

export type BoardDoc = {
  ownerUid?: string;
  ownerEmail?: string;
  type?: "personal" | "team";
  teamId?: string;
  title?: string;
  readPolicy?: "public" | "members";
  writePolicy?: "everyone" | "whitelist" | "owner";
  editors?: string[];
  botPolicy?: BotPolicy;
};

export type TeamDoc = {
  admins?: string[];
  editorEmails?: string[];
  viewerEmails?: string[];
};

export type McpTokenDoc = {
  uid: string;
  email: string | null;
  createdAt: number;
  revoked: boolean;
  // Legacy single-board tokens still carry these; account-scoped tokens omit them.
  boardId?: string;
  role?: Role;
};

export type Identity = {
  uid: string | null;
  email: string | null;
};

export type Access = {
  canRead: boolean;
  canWrite: boolean;
};

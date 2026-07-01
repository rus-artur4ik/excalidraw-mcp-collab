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

export type Visibility = "private" | "team" | "link";
export type TeamRole = "admin" | "editor" | "viewer";

export const TEAM_ID = "chats-team";

export type BoardDoc = {
  ownerUid?: string;
  ownerEmail?: string;
  title?: string;
  visibility?: Visibility;
  editors?: string[];
  viewers?: string[];
  botPolicy?: BotPolicy;
  archived?: boolean;
  type?: "personal" | "team";
  teamId?: string;
  readPolicy?: "public" | "members";
  writePolicy?: "everyone" | "whitelist" | "owner";
};

export type TeamDoc = {
  name?: string;
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

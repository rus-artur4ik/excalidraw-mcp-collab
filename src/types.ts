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

export type BoardDoc = {
  ownerUid?: string;
  ownerEmail?: string;
  type?: "personal" | "team";
  teamId?: string;
  readPolicy?: "public" | "members";
  writePolicy?: "everyone" | "whitelist" | "owner";
  editors?: string[];
};

export type TeamDoc = {
  admins?: string[];
  editorEmails?: string[];
  viewerEmails?: string[];
};

export type McpTokenDoc = {
  uid: string;
  email: string | null;
  boardId: string;
  role: Role;
  createdAt: number;
  revoked: boolean;
};

export type Identity = {
  uid: string | null;
  email: string | null;
};

export type Access = {
  canRead: boolean;
  canWrite: boolean;
};

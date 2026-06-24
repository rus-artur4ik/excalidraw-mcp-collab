import { cert, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { config } from "./config";

let app: App | null = null;

const getApp = (): App => {
  if (!app) {
    app = initializeApp({
      credential: cert(config.serviceAccountPath),
      projectId: config.firebaseProjectId,
    });
  }
  return app;
};

export const auth = (): Auth => getAuth(getApp());

export const db = (): Firestore => getFirestore(getApp());

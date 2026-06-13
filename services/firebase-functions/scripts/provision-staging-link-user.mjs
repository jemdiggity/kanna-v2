#!/usr/bin/env node

export const LINK_USER = {
  projectId: "kanna-staging",
  email: "upvote.sieve.7t@icloud.com",
  password: "password123",
  displayName: "Link",
  photoURL: "file://services/firebase/emulator-seed/assets/link-avatar.png",
  deviceToken: "staging-link-device-token",
};

export function buildDeviceDocument(uid, now = new Date()) {
  return {
    userId: uid,
    email: LINK_USER.email,
    displayName: LINK_USER.displayName,
    environment: "staging",
    updatedAt: now.toISOString(),
  };
}

export function buildDryRunResult() {
  const uid = "dry-run-link-user";
  return {
    projectId: LINK_USER.projectId,
    uid,
    email: LINK_USER.email,
    displayName: LINK_USER.displayName,
    photoURL: LINK_USER.photoURL,
    devicePath: `devices/${LINK_USER.deviceToken}`,
    deviceDocument: buildDeviceDocument(uid),
    dryRun: true,
  };
}

async function upsertLinkUser({ admin, dryRun = false }) {
  if (dryRun) {
    return buildDryRunResult();
  }

  const auth = admin.auth();
  const db = admin.firestore();
  const user = await getOrCreateUser(auth, dryRun);
  const deviceDocument = buildDeviceDocument(user.uid);

  if (!dryRun) {
    await db
      .collection("devices")
      .doc(LINK_USER.deviceToken)
      .set(deviceDocument, { merge: true });
  }

  return {
    projectId: LINK_USER.projectId,
    uid: user.uid,
    email: LINK_USER.email,
    displayName: LINK_USER.displayName,
    photoURL: LINK_USER.photoURL,
    devicePath: `devices/${LINK_USER.deviceToken}`,
    deviceDocument,
    dryRun,
  };
}

async function getOrCreateUser(auth, dryRun) {
  try {
    const existing = await auth.getUserByEmail(LINK_USER.email);
    if (!dryRun) {
      await auth.updateUser(existing.uid, {
        password: LINK_USER.password,
        displayName: LINK_USER.displayName,
        photoURL: LINK_USER.photoURL,
        emailVerified: true,
      });
    }
    return { uid: existing.uid };
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw error;
    }
    if (dryRun) {
      return { uid: "dry-run-link-user" };
    }
    const created = await auth.createUser({
      email: LINK_USER.email,
      password: LINK_USER.password,
      displayName: LINK_USER.displayName,
      photoURL: LINK_USER.photoURL,
      emailVerified: true,
    });
    return { uid: created.uid };
  }
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  if (dryRun) {
    console.log(JSON.stringify(buildDryRunResult(), null, 2));
    return;
  }

  const { default: admin } = await import("firebase-admin");

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: LINK_USER.projectId });
  }

  const result = await upsertLinkUser({ admin, dryRun });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { upsertLinkUser };

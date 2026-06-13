#!/usr/bin/env node

export const BUFFY_USER = {
  projectId: "kanna-staging",
  email: "upvote.sieve.7t@icloud.com",
  password: "password123",
  displayName: "Buffy the Bug Slayer",
  photoURL: "file://services/firebase/emulator-seed/assets/buffy-avatar.jpg",
  deviceToken: "staging-buffy-device-token",
};

export function buildDeviceDocument(uid, now = new Date()) {
  return {
    userId: uid,
    email: BUFFY_USER.email,
    displayName: BUFFY_USER.displayName,
    environment: "staging",
    updatedAt: now.toISOString(),
  };
}

export function buildDryRunResult() {
  const uid = "dry-run-buffy-user";
  return {
    projectId: BUFFY_USER.projectId,
    uid,
    email: BUFFY_USER.email,
    displayName: BUFFY_USER.displayName,
    photoURL: BUFFY_USER.photoURL,
    devicePath: `devices/${BUFFY_USER.deviceToken}`,
    deviceDocument: buildDeviceDocument(uid),
    dryRun: true,
  };
}

async function upsertBuffyUser({ admin, dryRun = false }) {
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
      .doc(BUFFY_USER.deviceToken)
      .set(deviceDocument, { merge: true });
  }

  return {
    projectId: BUFFY_USER.projectId,
    uid: user.uid,
    email: BUFFY_USER.email,
    displayName: BUFFY_USER.displayName,
    photoURL: BUFFY_USER.photoURL,
    devicePath: `devices/${BUFFY_USER.deviceToken}`,
    deviceDocument,
    dryRun,
  };
}

async function getOrCreateUser(auth, dryRun) {
  try {
    const existing = await auth.getUserByEmail(BUFFY_USER.email);
    if (!dryRun) {
      await auth.updateUser(existing.uid, {
        password: BUFFY_USER.password,
        displayName: BUFFY_USER.displayName,
        photoURL: BUFFY_USER.photoURL,
        emailVerified: true,
      });
    }
    return { uid: existing.uid };
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw error;
    }
    if (dryRun) {
      return { uid: "dry-run-buffy-user" };
    }
    const created = await auth.createUser({
      email: BUFFY_USER.email,
      password: BUFFY_USER.password,
      displayName: BUFFY_USER.displayName,
      photoURL: BUFFY_USER.photoURL,
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
    admin.initializeApp({ projectId: BUFFY_USER.projectId });
  }

  const result = await upsertBuffyUser({ admin, dryRun });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { upsertBuffyUser };

# Firebase Admin callable initialization: Cloud Run E2E gap (2026-08-22)

## Incident and root cause

Staging revision `createcheckoutsession-00004-ley` failed every authenticated
checkout call after logging `Callable request verification passed` because the
handler's `getFirestore()` could not find the default Firebase app. The guard
was `if (getApps().length === 0) initializeApp()`, so it incorrectly treated
"some app exists" as "the default app exists."

The immutable revision and build artifacts establish how that state arose:

- Cloud Build `4cca25a4-2114-4c73-b433-21642565f4a7` used Node `24.19.0`,
  generated a lockfile from the uploaded lockfile-free package, and installed
  `firebase-functions@7.3.2` with npm.
- That release's `lib/common/app.js` catches a missing default app during
  callable token verification and initializes an app named
  `__FIREBASE_FUNCTIONS_SDK__` instead.
- The callable verifier uses that named app to validate the auth token. It then
  logs the successful verification and invokes Kanna's handler. At that point
  `getApps()` is non-empty, but the default app still does not exist, so the
  lazy guard skips initialization and the implicit `getFirestore()` lookup
  throws exactly the observed `FirebaseAppError`.
- A fresh package-only npm install resolves one deduplicated
  `firebase-admin@13.10.0` shared by `firebase-functions@7.3.2`; the failure did
  not require two installed Admin SDK copies. Node 24 was already pinned in
  `firebase.json`, and the same Admin sequence works on Node 24 when callable
  verification has not first created the named SDK app.

The class fix eagerly initializes Kanna's app at module evaluation and passes
that app explicitly to Firestore and Auth. The functions package now commits
the npm lockfile consumed by Cloud Build.

## Remaining E2E gap

CI cannot execute Google's current Cloud Functions buildpack and managed
callable request-verification layer byte-for-byte without deploying a cloud
function. The regression test therefore builds the real entry point, starts it
in a credential-free child Node process with the Functions SDK's named app
already present, evaluates the real compiled entry point, repeats the Admin
auto-initializer to cover test re-evaluation safety, and proves that the default
app plus Firestore/Auth service initialization succeeds without mocks.

A full E2E becomes practical when staging deployments are available to CI with
an isolated Firebase project, Auth user, and Stripe test secret. It should
deploy the committed lockfile through the Node 24 buildpack, invoke the callable
with a real Firebase ID token, and assert that execution reaches the checkout
adapter rather than failing Firebase Admin initialization.

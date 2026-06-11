/**
 * Kanna Firebase Functions entry point.
 *
 * Kanna deploys no Cloud Functions. Desktop relay credentials are provisioned
 * directly in Firestore by the signed-in desktop app and verified by the relay
 * (services/relay/src/auth.ts). This module intentionally exports no functions
 * so `firebase deploy --only functions` cannot resurrect retired endpoints
 * (such as the removed createPairingCode bootstrap).
 */
export {};

/**
 * Source commit baked into the relay image at build time.
 *
 * `kd cloud deploy --relay` submits the working tree to Cloud Build, so nothing
 * about a running relay used to say which source it came from. The deploy passes
 * the resolved short sha as the `_COMMIT` substitution, `services/relay/Dockerfile`
 * turns it into `KANNA_RELAY_COMMIT`, and `/health` reports it.
 */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/** `/health` reports this when the image was built without a commit (local dev). */
export const UNKNOWN_BUILD_COMMIT = "unknown";

/**
 * Read the baked commit, accepting only a bare sha. `/health` is unauthenticated,
 * so anything else — a branch name, a build id, junk — is reported as unknown
 * rather than echoed back.
 */
export function resolveBuildCommit(env: NodeJS.ProcessEnv): string {
  const commit = env.KANNA_RELAY_COMMIT?.trim().toLowerCase();
  return commit && COMMIT_PATTERN.test(commit) ? commit : UNKNOWN_BUILD_COMMIT;
}

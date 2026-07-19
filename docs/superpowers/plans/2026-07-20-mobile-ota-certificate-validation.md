# Mobile OTA Certificate Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Expo SDK 57 accept signed staging OTA manifests and make `kd` reject incompatible certificates before cloud mutation.

**Architecture:** Reissue the committed public certificate from the existing private key with Code Signing EKU, then isolate certificate parsing and key matching in a small KD runtime module. The existing OTA orchestration calls that module before publish/provision writes and exposes its result as a read-only doctor check. Runtime `2.1.1` separates native builds containing the new certificate from runtime `2.1.0`.

**Tech Stack:** TypeScript, Node `crypto.X509Certificate`, Vitest, Expo SDK 57, OpenSSL for reproducible certificate issuance, `pnpm`, canonical `./kd mobile ota` workflows, Xcode physical-device Release install.

---

## File Structure

- Create `tools/kd/src/runtime/mobile-ota-certificate.ts`: parse and validate the committed X.509 certificate, validity window, Code Signing EKU, and optional private-key match without exposing key material.
- Create `tools/kd/src/runtime/mobile-ota-certificate.test.ts`: focused unit coverage for the validator and the repository certificate.
- Create `tools/kd/src/runtime/fixtures/ota-codesign-no-eku.pem`: public-only copy of the rejected certificate for regression coverage.
- Create `apps/mobile/certs/ota-codesign.cnf`: reproducible OpenSSL subject and extension profile.
- Modify `apps/mobile/certs/ota-codesign.pem`: replace only the public certificate while preserving the existing private key.
- Modify `tools/kd/src/runtime/mobile-ota.ts`: invoke validation at publish, provision-secret, and doctor boundaries.
- Modify `tools/kd/src/runtime/mobile-ota.test.ts`: prove invalid certificates prevent writes and doctor reports failure.
- Modify `apps/mobile/src/mobileEnvironments.json`: bump the native compatibility boundary to `2.1.1`.
- Modify `apps/mobile/src/mobileAppConfig.test.ts`: assert runtime `2.1.1` for every environment.
- Modify `AGENTS.md`: document certificate requirements, runtime bumps, validation, and staging/production authorization.

### Task 1: Add a failing certificate compatibility test

**Files:**
- Create: `tools/kd/src/runtime/mobile-ota-certificate.test.ts`
- Create: `tools/kd/src/runtime/fixtures/ota-codesign-no-eku.pem`

- [ ] **Step 1: Preserve the rejected public certificate as a regression fixture**

Read the certificate from commit `60701aa1` and add the public PEM, unchanged, at `tools/kd/src/runtime/fixtures/ota-codesign-no-eku.pem`. Do not read or copy the private key for this step.

- [ ] **Step 2: Write failing validator tests**

Create `mobile-ota-certificate.test.ts` with the repository paths resolved from `import.meta.url` and these cases:

```ts
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateMobileOtaCertificate } from "./mobile-ota-certificate.js";

const repositoryCertificatePath = fileURLToPath(
  new URL("../../../../apps/mobile/certs/ota-codesign.pem", import.meta.url)
);
const missingEkuCertificatePath = fileURLToPath(
  new URL("./fixtures/ota-codesign-no-eku.pem", import.meta.url)
);

describe("mobile OTA certificate validation", () => {
  it("accepts the committed Expo code-signing certificate", async () => {
    await expect(
      validateMobileOtaCertificate({ certificatePath: repositoryCertificatePath })
    ).resolves.toMatchObject({
      keyId: "kanna-mobile-ota-v1",
      codeSigning: true,
    });
  });

  it("rejects a certificate without Code Signing EKU", async () => {
    await expect(
      validateMobileOtaCertificate({ certificatePath: missingEkuCertificatePath })
    ).rejects.toThrow("Code Signing extended key usage (1.3.6.1.5.5.7.3.3)");
  });

  it("rejects malformed certificate input without echoing it", async () => {
    await expect(
      validateMobileOtaCertificate({ certificatePem: "not a certificate" })
    ).rejects.toThrow("committed mobile OTA certificate is not valid X.509");
  });

  it("rejects a private key that does not match the certificate", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(
      validateMobileOtaCertificate({
        certificatePem: await readFile(repositoryCertificatePath, "utf8"),
        privateKeyPem,
      })
    ).rejects.toThrow("does not match the committed mobile OTA certificate");
  });
});
```

- [ ] **Step 3: Run the test to verify RED**

Run:

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota-certificate.test.ts --maxWorkers=2
```

Expected: FAIL because `mobile-ota-certificate.ts` does not exist.

### Task 2: Implement the certificate validator

**Files:**
- Create: `tools/kd/src/runtime/mobile-ota-certificate.ts`
- Test: `tools/kd/src/runtime/mobile-ota-certificate.test.ts`

- [ ] **Step 1: Add the minimal validator implementation**

Implement the module using only Node APIs:

```ts
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";

const CODE_SIGNING_EKU_OID = "1.3.6.1.5.5.7.3.3";
export const OTA_CERTIFICATE_RELATIVE_PATH = "apps/mobile/certs/ota-codesign.pem";

export interface MobileOtaCertificateValidationInput {
  certificatePath?: string;
  certificatePem?: string;
  privateKeyPath?: string;
  privateKeyPem?: string;
  now?: Date;
}

export interface MobileOtaCertificateValidation {
  keyId: "kanna-mobile-ota-v1";
  codeSigning: true;
  validFrom: string;
  validTo: string;
}

export async function validateMobileOtaCertificate(
  input: MobileOtaCertificateValidationInput
): Promise<MobileOtaCertificateValidation> {
  const certificatePem = input.certificatePem ??
    (input.certificatePath ? await readFile(input.certificatePath, "utf8") : undefined);
  if (!certificatePem) throw new Error("The committed mobile OTA certificate is missing.");

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error("The committed mobile OTA certificate is not valid X.509.");
  }

  if (!certificate.keyUsage?.includes(CODE_SIGNING_EKU_OID)) {
    throw new Error(
      `The committed mobile OTA certificate must include Code Signing extended key usage (${CODE_SIGNING_EKU_OID}).`
    );
  }

  const now = (input.now ?? new Date()).getTime();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new Error("The committed mobile OTA certificate is outside its validity window.");
  }

  const privateKeyPem = input.privateKeyPem ??
    (input.privateKeyPath ? await readFile(input.privateKeyPath, "utf8") : undefined);
  if (privateKeyPem) {
    let privatePublicKey: Buffer;
    try {
      privatePublicKey = createPublicKey(createPrivateKey(privateKeyPem)).export({
        type: "spki",
        format: "der",
      });
    } catch {
      throw new Error("The supplied mobile OTA private key is invalid.");
    }
    const certificatePublicKey = certificate.publicKey.export({ type: "spki", format: "der" });
    if (
      privatePublicKey.length !== certificatePublicKey.length ||
      !timingSafeEqual(privatePublicKey, certificatePublicKey)
    ) {
      throw new Error("The supplied mobile OTA private key does not match the committed mobile OTA certificate.");
    }
  }

  return {
    keyId: "kanna-mobile-ota-v1",
    codeSigning: true,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
  };
}
```

Keep all errors free of PEM contents or derived key bytes.

- [ ] **Step 2: Run the focused tests**

Run the Task 1 Vitest command.

Expected: the missing-EKU, malformed, and mismatch tests PASS; the repository-certificate test FAILS with the device's missing-EKU error. This isolates the remaining failure to the committed certificate.

### Task 3: Reissue the public certificate and bump the native runtime

**Files:**
- Create: `apps/mobile/certs/ota-codesign.cnf`
- Modify: `apps/mobile/certs/ota-codesign.pem`
- Modify: `apps/mobile/src/mobileEnvironments.json`
- Modify: `apps/mobile/src/mobileAppConfig.test.ts`
- Test: `tools/kd/src/runtime/mobile-ota-certificate.test.ts`

- [ ] **Step 1: Add the reproducible OpenSSL profile**

Create `ota-codesign.cnf`:

```ini
[req]
distinguished_name = subject
prompt = no
x509_extensions = code_signing

[subject]
CN = Kanna Mobile OTA v1
O = Kanna
OU = Mobile

[code_signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
```

- [ ] **Step 2: Generate the replacement public certificate into a temporary file**

Run without printing the private key:

```bash
OTA_CERT_DIR=$(mktemp -d /tmp/kanna-ota-cert.XXXXXX)
openssl req -new -x509 -sha256 -days 3650 \
  -key "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem" \
  -config apps/mobile/certs/ota-codesign.cnf \
  -out "$OTA_CERT_DIR/ota-codesign.pem"
openssl x509 -in "$OTA_CERT_DIR/ota-codesign.pem" -noout -purpose
```

Expected: `Code Signing : Yes`. Replace `apps/mobile/certs/ota-codesign.pem` with only the generated public PEM using `apply_patch`.

- [ ] **Step 3: Verify public-key continuity without outputting key material**

Run a Node assertion that imports the local private key, derives its SPKI public key, compares it with the replacement certificate's SPKI using `timingSafeEqual`, and produces no output on success.

Expected: exit 0.

- [ ] **Step 4: Bump runtime compatibility and assertions**

Change every `runtimeVersion` in `mobileEnvironments.json` from `2.1.0` to `2.1.1`, and update all `2.1.0` runtime assertions in `mobileAppConfig.test.ts` to `2.1.1`.

- [ ] **Step 5: Run certificate and mobile config tests to verify GREEN**

Run:

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota-certificate.test.ts --maxWorkers=2
pnpm --dir apps/mobile exec vitest run src/mobileAppConfig.test.ts --maxWorkers=2
```

Expected: both files PASS.

- [ ] **Step 6: Commit the validator and certificate/runtime migration**

```bash
git add tools/kd/src/runtime/mobile-ota-certificate.ts tools/kd/src/runtime/mobile-ota-certificate.test.ts tools/kd/src/runtime/fixtures/ota-codesign-no-eku.pem apps/mobile/certs/ota-codesign.cnf apps/mobile/certs/ota-codesign.pem apps/mobile/src/mobileEnvironments.json apps/mobile/src/mobileAppConfig.test.ts
git commit -m "fix(mobile): issue Expo-compatible OTA certificate"
```

### Task 4: Add KD workflow guardrails with integration tests

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.ts`
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`
- Test: `tools/kd/src/runtime/mobile-ota-certificate.test.ts`

- [ ] **Step 1: Extend test repo fixtures with the committed certificate**

Update `makeRepoFixture()` to create `apps/mobile/certs` and copy the committed public certificate into `ota-codesign.pem`. Add an optional `certificatePem` parameter so failure tests can write `"not a certificate"`.

- [ ] **Step 2: Write failing publish, provision-secret, and doctor tests**

Add tests with these exact expectations:

```ts
it("rejects publish before export when the committed certificate is invalid", async () => {
  const repoRoot = await makeRepoFixture({ certificatePem: "not a certificate" });
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await expect(
    executeMobileOtaPublishWithContext(
      { staging: true, production: false, dryRun: true },
      { repoRoot, env: {}, runner }
    )
  ).rejects.toThrow("not valid X.509");
  expect(calls).toEqual([{ command: "git", args: ["status", "--porcelain"] }]);
});

it("rejects provision-secret before cloud commands when the key mismatches", async () => {
  const repoRoot = await makeRepoFixture();
  const keyPath = join(repoRoot, "mismatched-private-key.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(
    keyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  );
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await expect(
    executeMobileOtaProvisionSecretWithContext(
      { staging: true, production: false, keyPath },
      { repoRoot, env: {}, runner }
    )
  ).rejects.toThrow("does not match the committed mobile OTA certificate");
  expect(calls).toEqual([]);
});

it("reports an invalid committed certificate as a read-only doctor failure", async () => {
  const repoRoot = await makeRepoFixture({ certificatePem: "not a certificate" });
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = makeSuccessfulDoctorRunner(calls);
  const result = await executeMobileOtaDoctorWithContext(
    { staging: true, production: false },
    { repoRoot, env: {}, runner }
  );
  expect(result.ok).toBe(false);
  expect(result.message).toContain("FAIL certificate");
  expect(result.message).toContain("not valid X.509");
  expect(calls.some(({ args }) => args.includes("cp"))).toBe(false);
  expect(calls.some(({ args }) => args.includes("rsync"))).toBe(false);
  expect(calls.some(({ args }) => args.includes("create"))).toBe(false);
  expect(calls.some(({ args }) => args.includes("add-iam-policy-binding"))).toBe(false);
});
```

Add `generateKeyPairSync` to the existing `node:crypto` import. Extract the runner body from the existing `runs a read-only staging OTA doctor` test into a test-only `makeSuccessfulDoctorRunner(calls)` helper without changing its command responses, and use that helper from both doctor tests. Do not introduce a production abstraction solely for tests.

- [ ] **Step 3: Run the KD tests to verify RED**

Run:

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts src/runtime/mobile-ota-certificate.test.ts --maxWorkers=2
```

Expected: the three integration tests FAIL because the orchestration does not invoke certificate validation.

- [ ] **Step 4: Integrate validation at each boundary**

Import `OTA_CERTIFICATE_RELATIVE_PATH` and `validateMobileOtaCertificate`. Add:

```ts
function otaCertificatePath(repoRoot: string): string {
  return join(repoRoot, OTA_CERTIFICATE_RELATIVE_PATH);
}
```

Then:

- in publish, call `validateMobileOtaCertificate({ certificatePath: otaCertificatePath(context.repoRoot) })` after the read-only cleanliness check and before deleting/exporting `dist`;
- in provision-secret, replace the bare `readFile(input.keyPath)` with validation using both `certificatePath` and `privateKeyPath` before the first `gcloud` command;
- in doctor, run certificate validation locally, append `PASS certificate` with its validity window or `FAIL certificate` with the sanitized error, then continue all existing read-only checks.

- [ ] **Step 5: Run focused KD tests to verify GREEN**

Run the Task 4 Step 3 command.

Expected: both files PASS with no unexpected cloud calls.

- [ ] **Step 6: Commit the workflow guardrails**

```bash
git add tools/kd/src/runtime/mobile-ota.ts tools/kd/src/runtime/mobile-ota.test.ts
git commit -m "fix(kd): validate OTA signing certificate"
```

### Task 5: Document the certificate contract and authorization

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/specs/mobile-ota-updates.md`

- [ ] **Step 1: Update operator documentation**

Document beside the existing OTA commands:

- the certificate path and private-key path;
- required critical `digitalSignature` key usage and Code Signing EKU;
- the `ota-codesign.cnf` regeneration workflow;
- mandatory runtime bump after replacing the embedded certificate;
- `provision-secret`, `publish`, and `doctor` validation behavior;
- staging agent publish/rollback authorization; and
- explicit HITL approval for production publish/rollback.

Do not restore the stale blanket physical-device automation policy removed from current main. Preserve the current wording that device apply verification is normally human-only, while noting that this task's explicit user authorization covers the selected iPhone 15 validation.

- [ ] **Step 2: Run documentation and focused checks**

```bash
git diff --check
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts src/runtime/mobile-ota-certificate.test.ts tests/cli.test.ts tests/cloud-deploy.test.ts --maxWorkers=2
```

Expected: clean diff and all selected tests PASS.

- [ ] **Step 3: Commit documentation**

```bash
git add AGENTS.md docs/specs/mobile-ota-updates.md
git commit -m "docs: define mobile OTA certificate contract"
```

### Task 6: Run repository-wide verification

**Files:**
- Verify only; no expected modifications.

- [ ] **Step 1: Run the required KD suite**

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts src/runtime/mobile-ota-certificate.test.ts tests/cli.test.ts tests/cloud-deploy.test.ts --maxWorkers=2
```

Expected: all files and tests PASS.

- [ ] **Step 2: Run monorepo tests**

```bash
pnpm test
```

Expected: all Turbo tasks PASS.

- [ ] **Step 3: Run serialized daemon tests**

```bash
(cd crates/daemon && cargo test -- --test-threads=1)
```

Expected: all daemon test binaries PASS.

- [ ] **Step 4: Verify branch ancestry, mergeability, and whitespace**

```bash
git merge-base --is-ancestor origin/main HEAD
git merge-tree "$(git merge-base HEAD origin/main)" HEAD origin/main | rg '^<<<<<<<|^=======$|^>>>>>>>' && exit 1 || true
git diff --check
git status --short --branch
```

Expected: ancestry exit 0, no conflict markers, clean diff check, and clean worktree.

### Task 7: Validate runtime `2.1.1` end to end on staging

**Files:**
- Live staging state only; no production operations.

- [ ] **Step 1: Run pre-publication staging doctor and interpret the expected pointer gap**

```bash
./kd mobile ota doctor --staging
./kd mobile ota status --staging
```

Expected before publication: local certificate check PASS; runtime is `2.1.1`; doctor/status may be nonzero only because runtime `2.1.1` has no pointer yet.

- [ ] **Step 2: Confirm no secret or relay mutation is required**

The private key is unchanged and the previously served manifest signature matched its public key, so do not create another Secret Manager version or redeploy the relay unless fresh read-only evidence contradicts that state.

- [ ] **Step 3: Install the standalone staging build on the explicit iPhone 15**

Confirm `Jerome's iPhone 15` is available, then target it by its exact physical-device name:

```bash
KANNA_IOS_PHYSICAL_DEVICE_NAME="Jerome's iPhone 15" ./kd mobile run --device --staging --install
```

Expected: Release build succeeds, bundle id is `build.kanna.app.staging`, environment is staging, and Metro is not required.

- [ ] **Step 4: Publish a post-install staging update**

```bash
./kd mobile ota publish --staging
```

Expected: a new immutable runtime `2.1.1` update ID and staging pointer. Do not run a production flag.

- [ ] **Step 5: Trigger and inspect the device update check**

Relaunch the installed staging app on the selected iPhone 15. Copy the read-only Expo Updates log from:

```text
Library/Application Support/dev.expo.modules.core.logging.expo-updates.txt
```

Expected: no missing-EKU error, manifest accepted, update downloaded/pending, and the app displays `Update ready — Restart to apply`.

- [ ] **Step 6: Apply and verify the update**

Have the user tap restart. Relaunch if needed, then inspect the fresh device log.

Expected: the published update becomes launchable and no Expo error recovery marks it failed.

- [ ] **Step 7: Capture final read-only staging evidence**

```bash
./kd mobile ota doctor --staging
./kd mobile ota status --staging
git diff --check
git status --short --branch
```

Expected: every doctor check PASS, status points to the new runtime `2.1.1` update, and the worktree is clean. Production remains untouched.

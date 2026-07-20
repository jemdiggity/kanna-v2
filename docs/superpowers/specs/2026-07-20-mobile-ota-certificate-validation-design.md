# Mobile OTA Certificate Validation Design

## Context

The staging OTA relay, bucket, pointer, manifest signing, and native runtime configuration are live for runtime `2.1.0`. The staging iPhone app reaches the relay, but Expo SDK 57 rejects every returned manifest with:

```text
Code signature validation failed: Certificate missing code signing extended key usage
```

The committed certificate at `apps/mobile/certs/ota-codesign.pem` contains the correct public key for the existing private signing key, but it lacks the X.509 Code Signing extended key usage required by Expo SDK 57. The application currently swallows the resulting update-check error, so the cloud-only doctor reported green while the device could not accept an update.

## Decision

Preserve the existing uncompromised private key and reissue its public certificate. The replacement certificate must:

- contain the same RSA public key as `$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem`;
- declare critical `digitalSignature` key usage;
- declare Code Signing extended key usage (`1.3.6.1.5.5.7.3.3`);
- retain key id `kanna-mobile-ota-v1`; and
- be the only public certificate committed at `apps/mobile/certs/ota-codesign.pem`.

The private key must never be printed, copied into the repository, or included in command output. There is no evidence of compromise, so rotating the keypair would add Secret Manager, relay, and rollback coordination without improving the current security posture. Disabling manifest signature validation is not acceptable.

## Runtime Compatibility

The public certificate is embedded by Expo as native update configuration. Replacing it therefore requires a runtime bump from `2.1.0` to `2.1.1` in every entry of `apps/mobile/src/mobileEnvironments.json`, keeping the repository's shared native compatibility boundary coherent.

Only staging runtime `2.1.1` will be installed or published in this task. No production secret, bucket, channel pointer, relay deployment, application installation, or OTA publication will be changed. Updating the source runtime registry prepares a future production native build without mutating live production.

## Canonical Validation

Certificate validation belongs in the `kd` mobile OTA workflow so a cloud-only preflight cannot miss a native rejection again.

Add a focused certificate utility in `tools/kd/src/runtime/mobile-ota.ts` that uses Node's crypto APIs to parse the committed certificate and verify:

1. the file is a valid X.509 certificate;
2. Code Signing is present in extended key usage;
3. the certificate is currently valid; and
4. when a private key path is supplied, the key's derived public key matches the certificate public key.

Integrate the utility at these boundaries:

- `provision-secret` validates the certificate and private-key match before enabling APIs or writing Secret Manager;
- `publish` validates the certificate before exporting or uploading an update;
- `doctor` adds an explicit read-only certificate check and fails when the certificate cannot be accepted by Expo.

Validation errors must identify the missing or mismatched property without including PEM contents, derived key material, or secret paths beyond the user-supplied path already present in the command invocation.

The certificate reissue procedure must be documented in `AGENTS.md` alongside the OTA workflow. It must state the required X.509 extensions, runtime bump requirement, canonical validation commands, and the rule that live staging operations use only `./kd mobile ota ...`. Production publication and rollback remain human-approved.

## Data Flow

The corrected path is:

1. A native staging build embeds the reissued public certificate and runtime `2.1.1`.
2. `./kd mobile ota publish --staging` validates the committed certificate, exports runtime `2.1.1`, uploads the immutable update, and advances only the staging pointer.
3. The staging relay signs the manifest with the existing private key from Secret Manager.
4. Expo SDK 57 verifies the signature using the embedded certificate, downloads the update, and reports it as pending.
5. Kanna displays the existing update-ready banner and reloads only after the user accepts.

## Error Handling

Certificate failures stop before cloud mutation:

- invalid or unreadable certificate: report that the committed OTA certificate is invalid;
- missing Code Signing EKU: report the exact required EKU;
- expired or not-yet-valid certificate: report the validity failure;
- private-key mismatch: reject `provision-secret` before creating a new secret version.

`doctor` remains read-only. Its summary must include the local certificate result alongside the existing bucket, pointer, secret, IAM, relay, and manifest checks.

## Testing and Verification

Use test-driven development for the new validation behavior. Add focused tests covering:

- a valid certificate with Code Signing EKU;
- the current failure mode, a certificate without Code Signing EKU;
- a malformed certificate;
- a certificate/private-key mismatch;
- `provision-secret` performing no cloud command after validation fails;
- `publish` performing no export or cloud command after validation fails; and
- `doctor` reporting certificate failure while remaining read-only.

Update mobile configuration assertions for runtime `2.1.1`. Run the existing cross-system suites required by the task, including the focused KD tests, `pnpm test`, daemon Rust tests, and `git diff --check`.

Live validation is staging-only:

1. validate the reissued certificate against the local private key without printing either;
2. reprovision the staging secret only if the key/certificate match check or deployed relay state requires it;
3. deploy the staging relay only if repository relay behavior or configuration changes require deployment;
4. install the standalone runtime `2.1.1` staging app on the explicitly selected iPhone 15;
5. publish a fresh runtime `2.1.1` staging OTA after installation;
6. run fresh read-only staging doctor and status checks; and
7. confirm from the device's Expo Updates log and visible banner that the update downloads and applies.

No `--production` command, production cloud write, or production application release is permitted.

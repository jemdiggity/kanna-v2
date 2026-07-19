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

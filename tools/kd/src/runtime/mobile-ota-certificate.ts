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
  const certificatePem =
    input.certificatePem ??
    (input.certificatePath ? await readFile(input.certificatePath, "utf8") : undefined);
  if (!certificatePem) {
    throw new Error("The committed mobile OTA certificate is missing.");
  }

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

  const privateKeyPem =
    input.privateKeyPem ??
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

    const certificatePublicKey = certificate.publicKey.export({
      type: "spki",
      format: "der",
    });
    if (
      privatePublicKey.length !== certificatePublicKey.length ||
      !timingSafeEqual(privatePublicKey, certificatePublicKey)
    ) {
      throw new Error(
        "The supplied mobile OTA private key does not match the committed mobile OTA certificate."
      );
    }
  }

  return {
    keyId: "kanna-mobile-ota-v1",
    codeSigning: true,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
  };
}

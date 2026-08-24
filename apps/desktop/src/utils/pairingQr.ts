import QRCode from "qrcode";

export async function renderPairingQr(payload: string): Promise<string> {
  if (!payload.trim()) throw new Error("Pairing payload is empty.");

  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 370,
    color: { dark: "#08111EFF", light: "#FFFFFFFF" },
  });
}

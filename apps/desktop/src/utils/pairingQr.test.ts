import { beforeEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { renderPairingQr } from "./pairingQr";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(),
  },
}));

describe("renderPairingQr", () => {
  beforeEach(() => {
    vi.mocked(QRCode.toDataURL).mockReset();
  });

  it("renders a high-contrast pairing QR with stable dimensions", async () => {
    vi.mocked(QRCode.toDataURL).mockResolvedValue("data:image/png;base64,qr");

    await expect(renderPairingQr("pairing-payload")).resolves.toBe("data:image/png;base64,qr");
    expect(QRCode.toDataURL).toHaveBeenCalledWith("pairing-payload", {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 370,
      color: { dark: "#08111EFF", light: "#FFFFFFFF" },
    });
  });

  it("rejects an empty pairing payload", async () => {
    await expect(renderPairingQr("   ")).rejects.toThrow("Pairing payload is empty.");
    expect(QRCode.toDataURL).not.toHaveBeenCalled();
  });
});

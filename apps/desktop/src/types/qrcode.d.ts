declare module "qrcode" {
  interface QrCodeOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    width?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }

  const QRCode: {
    toDataURL(text: string, options?: QrCodeOptions): Promise<string>;
  };

  export default QRCode;
}

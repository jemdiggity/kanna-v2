import { networkInterfaces } from "node:os";

export function selectPreferredLanAddress(): string | undefined {
  const interfaces = networkInterfaces();
  const preferredInterfaceNames = ["en0", "en1", "bridge100"];

  for (const interfaceName of preferredInterfaceNames) {
    const entries = interfaces[interfaceName];
    const ipv4Address = entries?.find(
      (entry) => entry.family === "IPv4" && entry.internal === false
    )?.address;

    if (ipv4Address) {
      return ipv4Address;
    }
  }

  for (const entries of Object.values(interfaces)) {
    const ipv4Address = entries?.find(
      (entry) => entry.family === "IPv4" && entry.internal === false
    )?.address;

    if (ipv4Address) {
      return ipv4Address;
    }
  }

  return undefined;
}

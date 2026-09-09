import { z } from "zod";
import type { CloudEnvironmentName } from "./environment";
import type { MobileOtaContext } from "./mobile-ota";

const buildSchema = z.object({
  environment: z.string(), channel: z.string(), runtimeVersion: z.string().nullable(),
  nativeVersion: z.string().nullable(), nativeBuild: z.string().nullable(),
  updateId: z.string().nullable(), source: z.string(), reportedAtUnixMs: z.number().int().nonnegative().max(8_640_000_000_000_000)
});
const devicesSchema = z.object({
  desktopId: z.string(),
  devices: z.array(z.object({ deviceId: z.string(), deviceName: z.string(), build: buildSchema.nullable() }))
});
const pointerSchema = z.object({
  currentUpdateId: z.string().min(1), runtimeVersion: z.string().optional(), createdAt: z.string().optional()
});
export interface OtaObservation {
  status: "PASS" | "WARN";
  detail: string;
}

export async function observeMobileDevices(
  context: MobileOtaContext, environment: CloudEnvironmentName, channel: string, runtime: string, updateId?: string
): Promise<OtaObservation> {
  const url = context.env.KANNA_OTA_DEVICE_SERVER_URL ?? (environment === "staging" ? "http://127.0.0.1:48121" : "http://127.0.0.1:48120");
  // Separate contracts: crates/kanna-server/src/config.rs uses production;
  // apps/mobile/src/mobileEnvironment.ts uses prod for mobile build reports.
  const expectedServerEnvironment = environment;
  const expectedMobileEnvironment = environment === "production" ? "prod" : environment;
  const lines = [`device source: ${url} (paired devices on this desktop; last LAN reports, not a fleet census)`];
  try {
    const parsedUrl = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname) || parsedUrl.protocol !== "http:" || parsedUrl.username || parsedUrl.password) {
      throw new Error("KANNA_OTA_DEVICE_SERVER_URL must be a local HTTP server");
    }
    let reportedEnvironment = "UNKNOWN (status unreadable or environment missing)";
    try {
      const status = await context.runner.run("curl", ["--silent", "--show-error", "--fail", "--max-time", "5", `${url.replace(/\/$/, "")}/v1/status`], {
        cwd: context.repoRoot, env: context.env
      });
      if (status.exitCode === 0) {
        const parsed = z.object({ environment: z.string().min(1) }).safeParse(parseJson(status.stdout));
        if (parsed.success) reportedEnvironment = parsed.data.environment;
      }
    } catch {
      // An unavailable status cannot establish which desktop owns the inventory.
    }
    if (reportedEnvironment !== expectedServerEnvironment) {
      throw new Error(`desktop at ${url} reported environment ${reportedEnvironment}; expected ${expectedServerEnvironment}; no devices counted`);
    }
    const result = await context.runner.run("curl", ["--silent", "--show-error", "--fail", "--max-time", "5", `${url.replace(/\/$/, "")}/v1/mobile/builds`], {
      cwd: context.repoRoot, env: context.env
    });
    if (result.exitCode !== 0) throw new Error("desktop build inventory unavailable (offline or server predates reporting)");
    const inventory = devicesSchema.parse(JSON.parse(result.stdout));
    lines.push(`desktop: ${inventory.desktopId}`);
    let warnings = false;
    let compatible = 0;
    const runtimes = new Set<string>();
    for (const device of inventory.devices) {
      const build = device.build;
      if (!build) {
        warnings = true;
        lines.push(`${device.deviceName} (${device.deviceId}): UNKNOWN — no build report; launch a reporting-capable app on LAN`);
        continue;
      }
      if (build.channel !== channel || build.environment !== expectedMobileEnvironment) {
        lines.push(`${device.deviceName}: other environment/channel ${build.environment}/${build.channel}, runtime ${build.runtimeVersion ?? "unknown"}`);
        continue;
      }
      const age = Date.now() - build.reportedAtUnixMs;
      const fresh = Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60 * 1000;
      const runtimeKnown = build.runtimeVersion && (build.source === "ota" || build.source === "embedded") && build.runtimeVersion !== "Unknown";
      if (runtimeKnown) runtimes.add(build.runtimeVersion!);
      const matches = runtimeKnown && build.runtimeVersion === runtime;
      if (matches && fresh) compatible++;
      if (!matches || !fresh || (updateId && build.updateId !== updateId)) warnings = true;
      lines.push(`${device.deviceName} (${device.deviceId}): runtime ${build.runtimeVersion ?? "unknown"}, build ${build.nativeVersion ?? "unknown"} (${build.nativeBuild ?? "unknown"}), ${build.source} update ${build.updateId ?? "none"}; reported ${new Date(build.reportedAtUnixMs).toISOString()}${fresh ? "" : " [STALE/invalid observation: over 24h or clock mismatch]"}`);
      if (runtimeKnown && !matches) lines.push(`WARNING OTA DRIFT: the reported build cannot receive runtime ${runtime}; install a compatible native build to receive this publication.`);
      if (matches) lines.push(updateId && build.source === "ota" && build.updateId === updateId && fresh
        ? "Applied update confirmed by last device report."
        : "Runtime compatible; application of the channel update is NOT confirmed.");
    }
    if (!compatible) {
      warnings = true;
      lines.push(`WARNING: no recently observed paired device runs published runtime ${runtime} on ${channel}. Reported runtimes: ${[...runtimes].sort().join(", ") || "UNKNOWN (no device runtime data for this channel)"}.`);
    }
    if (warnings) lines.push("WARNING: device delivery is not fully verified; see observations above.");
    return { status: warnings ? "WARN" : "PASS", detail: lines.join("\n") };
  } catch (error) {
    return { status: "WARN", detail: `${lines.join("\n")}\nWARNING: device reachability UNKNOWN; ${error instanceof Error && !(error instanceof z.ZodError) && !(error instanceof SyntaxError) ? error.message : "invalid desktop build inventory"}. Publish success does not confirm device delivery.` };
  }
}

export async function observeRuntimePointers(
  context: MobileOtaContext, bucket: string, channel: string, runtime: string
): Promise<OtaObservation> {
  const prefix = `gs://${bucket}/ota/ios/`;
  try {
    const result = await context.runner.run("gcloud", ["storage", "ls", `${prefix}*/channels/${channel}.json`], { cwd: context.repoRoot, env: context.env });
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error("channel pointer listing unavailable or empty");
    const paths = [...new Set(result.stdout.trim().split(/\s+/))].sort();
    const pointers: Array<{ runtime: string; updateId: string; createdAt?: string }> = [];
    const lines: string[] = [];
    let warnings = false;
    for (const path of paths) {
      const relative = path.startsWith(prefix) ? path.slice(prefix.length) : "";
      const parts = relative.split("/");
      if (parts.length !== 3 || parts[1] !== "channels" || parts[2] !== `${channel}.json`) throw new Error("unexpected pointer listing");
      const value = await context.runner.run("gcloud", ["storage", "cat", path], { cwd: context.repoRoot, env: context.env });
      const parsed = value.exitCode === 0 ? pointerSchema.safeParse(parseJson(value.stdout)) : null;
      if (!parsed?.success || (parsed.data.runtimeVersion && parsed.data.runtimeVersion !== parts[0])) {
        warnings = true;
        lines.push(`runtime ${parts[0]}: pointer unreadable/invalid`);
      } else pointers.push({ runtime: parts[0]!, updateId: parsed.data.currentUpdateId, createdAt: parsed.data.createdAt });
    }
    const current = pointers.find(pointer => pointer.runtime === runtime);
    const dates = pointers.map(pointer => Date.parse(pointer.createdAt ?? "")).filter(Number.isFinite);
    const newestDate = dates.length ? Math.max(...dates) : Number.NaN;
    for (const pointer of pointers) {
      const date = Date.parse(pointer.createdAt ?? "");
      const dated = Number.isFinite(date) && Number.isFinite(newestDate);
      const behind = dated && date < newestDate;
      if (!dated) warnings = true;
      lines.push(`runtime ${pointer.runtime}: ${pointer.updateId}; pointer published ${pointer.createdAt ?? "unknown"}${behind ? " [STALE: predates newest channel pointer]" : dated ? "" : " [staleness UNKNOWN: pointer timestamp unavailable/invalid]"}${pointer.runtime === runtime ? " [configured]" : ""}`);
    }
    return { status: warnings || !current ? "WARN" : "PASS", detail: lines.join("\n") };
  } catch {
    return { status: "WARN", detail: "Runtime channel pointers UNKNOWN: could not enumerate/read bucket pointers." };
  }
}
function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

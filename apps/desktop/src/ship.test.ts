import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "../..");
const defaultTauriIconSha256 =
  "3dc10493b7de48a61de58f768f8a5708d3a44a068c148cedf0502b9b9b71ba5d";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

interface AlphaBounds {
  width: number;
  height: number;
}

interface TauriConfig {
  bundle: {
    icon?: string[];
  };
}

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  if (aboveDistance <= upperLeftDistance) {
    return above;
  }
  return upperLeft;
}

function extractPngsFromIcns(icns: Buffer): Buffer[] {
  expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");

  const pngs: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= icns.length) {
    const entryLength = icns.readUInt32BE(offset + 4);
    const entryDataStart = offset + 8;
    const entryDataEnd = offset + entryLength;
    const entryData = icns.subarray(entryDataStart, entryDataEnd);
    if (entryData.subarray(0, pngSignature.length).equals(pngSignature)) {
      pngs.push(entryData);
    }
    offset = entryDataEnd;
  }

  return pngs;
}

function decodeRgbaPng(png: Buffer): DecodedPng {
  expect(png.subarray(0, pngSignature.length).equals(pngSignature)).toBe(true);

  let width = 0;
  let height = 0;
  const idatChunks: Buffer[] = [];
  let offset = pngSignature.length;
  while (offset + 12 <= png.length) {
    const chunkLength = png.readUInt32BE(offset);
    const chunkType = png.subarray(offset + 4, offset + 8).toString("ascii");
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkLength;
    const chunkData = png.subarray(chunkDataStart, chunkDataEnd);

    if (chunkType === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      const bitDepth = chunkData[8];
      const colorType = chunkData[9];
      expect(bitDepth).toBe(8);
      expect(colorType).toBe(6);
    } else if (chunkType === "IDAT") {
      idatChunks.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }

    offset = chunkDataEnd + 4;
  }

  const bytesPerPixel = 4;
  const rowLength = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const rgba = Buffer.alloc(width * height * bytesPerPixel);

  for (let y = 0; y < height; y += 1) {
    const inputOffset = y * (rowLength + 1);
    const filter = inflated[inputOffset];
    const rowStart = inputOffset + 1;
    const outputOffset = y * rowLength;

    for (let x = 0; x < rowLength; x += 1) {
      const raw = inflated[rowStart + x];
      const left = x >= bytesPerPixel ? rgba[outputOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? rgba[outputOffset + x - rowLength] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel
          ? rgba[outputOffset + x - rowLength - bytesPerPixel]
          : 0;

      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + above;
          break;
        case 3:
          value = raw + Math.floor((left + above) / 2);
          break;
        case 4:
          value = raw + paethPredictor(left, above, upperLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      rgba[outputOffset + x] = value & 0xff;
    }
  }

  return { width, height, rgba };
}

function alphaBounds(png: DecodedPng): AlphaBounds {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.rgba[(y * png.width + x) * 4 + 3];
      if (alpha === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return {
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

describe("kd release workflow", () => {
  it("keeps the public ship task generic and Kanna's release procedure repo-local", () => {
    const shipWrapper = readFileSync(
      resolve(repoRoot, ".kanna/tasks/ship/agent.md"),
      "utf8",
    );
    const shipAgent = readFileSync(
      resolve(repoRoot, ".kanna/agents/ship/AGENT.md"),
      "utf8",
    );
    const kannaShipExtension = readFileSync(
      resolve(repoRoot, ".kanna/agents/ship/EXTEND.md"),
      "utf8",
    );

    expect(shipWrapper).toContain("execution_mode: pty");
    expect(shipWrapper).toContain("agent: ship");
    expect(shipWrapper).toContain("interactive palette mode");
    expect(shipWrapper).toContain("repository-specific release procedure");
    expect(shipWrapper).not.toContain("./kd release");
    expect(shipWrapper).not.toContain("git cherry-pick -x");
    expect(shipWrapper).not.toContain("./kd release promote");
    expect(shipAgent).toContain("repository's shipping agent");
    expect(shipAgent).toContain("shipping is not configured");
    expect(shipAgent).not.toContain("./kd release");
    expect(kannaShipExtension).toContain("./kd release status");
    expect(kannaShipExtension).toContain("./kd release ship");
    expect(kannaShipExtension).toContain("--release");
  });

  it("uses the VERSION file as the source of truth for the target version", () => {
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );

    expect(releaseRuntime).toContain("function readCurrentVersion");
    expect(releaseRuntime).toContain('join(repoRoot, "VERSION")');
    expect(releaseRuntime).toContain("bumpVersion(sourceVersion, input.bump)");
  });

  it("resolves GitHub release metadata from gh and remote URLs", () => {
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );

    expect(releaseRuntime).toContain("releaseRepoSlug(remoteUrl)");
    expect(releaseRuntime).toContain("releases/generate-notes");
    expect(releaseRuntime).not.toContain(
      "https://github.com/jemdiggity/kanna-tauri/releases/tag/v$VERSION",
    );
  });

  it("resolves final Bazel outputs with cquery instead of assuming a bazel-bin path", () => {
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );

    expect(releaseRuntime).toContain('"cquery"');
    expect(releaseRuntime).toContain("--output=files");
    expect(releaseRuntime).not.toContain('DMG_SOURCE="$BAZEL_BIN/release/');
  });

  it("sources desktop_crates from the narrow desktop workspace manifest", () => {
    const moduleBazel = readFileSync(resolve(repoRoot, "MODULE.bazel"), "utf8");

    expect(moduleBazel).toContain('name = "desktop_crates"');
    expect(moduleBazel).toContain('cargo_lockfile = "//:Cargo.desktop.lock"');
    expect(moduleBazel).toContain('manifests = ["//:Cargo.desktop.toml"]');
    expect(moduleBazel).not.toContain('cargo_lockfile = "//apps/desktop/src-tauri:Cargo.lock"');
    expect(moduleBazel).not.toContain('manifests = ["//:Cargo.toml"]');
  });

  it("keeps the narrow desktop Cargo lock in sync with direct desktop dependencies", () => {
    const desktopCargo = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/Cargo.toml"),
      "utf8",
    );
    const desktopLock = readFileSync(resolve(repoRoot, "Cargo.desktop.lock"), "utf8");

    if (desktopCargo.includes("rusqlite =")) {
      expect(desktopLock).toContain('"rusqlite"');
      expect(desktopLock).toContain('name = "rusqlite"');
    }
  });

  it("does not point npm lock translation at a missing npmrc file", () => {
    const moduleBazel = readFileSync(resolve(repoRoot, "MODULE.bazel"), "utf8");
    const npmrcLabelMatches = moduleBazel.matchAll(/npmrc\s*=\s*"\/\/([^:]+):([^"]+)"/g);

    for (const match of npmrcLabelMatches) {
      const [, packagePath, fileName] = match;
      expect(
        existsSync(resolve(repoRoot, packagePath, fileName)),
        `${match[0]} must point at an existing file`,
      ).toBe(true);
    }
  });

  it("declares pnpm lifecycle hook policy for Bazel npm translation", () => {
    const workspaceConfig = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8");

    expect(workspaceConfig).toMatch(/^onlyBuiltDependencies:/m);

    const moduleBazel = readFileSync(resolve(repoRoot, "MODULE.bazel"), "utf8");
    expect(moduleBazel).toContain('data = ["//:pnpm-workspace.yaml"]');
  });
});

describe("release bundle naming", () => {
  it("emits signed app bundles as Kanna.app for both architectures", () => {
    const rootBuild = readFileSync(
      resolve(repoRoot, "BUILD.bazel"),
      "utf8",
    );

    expect(rootBuild).toContain('output_name = "release/arm64/Kanna.app"');
    expect(rootBuild).toContain('output_name = "release/x86_64/Kanna.app"');
    expect(rootBuild).not.toContain('output_name = "release/Kanna-arm64.app"');
    expect(rootBuild).not.toContain('output_name = "release/Kanna-x86_64.app"');
  });

  it("uses the same dmg asset name in dry-run and release without signed in the filename", () => {
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );

    expect(releaseRuntime).toContain("Kanna_${version}_${label}.dmg");
    expect(releaseRuntime).not.toContain("Kanna_${version}_${label}-signed.dmg");
  });

  it("does not emit signed in bazel dmg output filenames", () => {
    const rootBuild = readFileSync(
      resolve(repoRoot, "BUILD.bazel"),
      "utf8",
    );

    expect(rootBuild).toContain('output_name = "release/Kanna-arm64.dmg"');
    expect(rootBuild).toContain('output_name = "release/Kanna-x86_64.dmg"');
    expect(rootBuild).toContain('output_name = "release/signed/Kanna-arm64.dmg"');
    expect(rootBuild).toContain('output_name = "release/signed/Kanna-x86_64.dmg"');
    expect(rootBuild).not.toContain('output_name = "release/Kanna-arm64-signed.dmg"');
    expect(rootBuild).not.toContain('output_name = "release/Kanna-x86_64-signed.dmg"');
  });

  it("uses the same desktop bundle identifier in Bazel and tauri config", () => {
    const rootBuild = readFileSync(
      resolve(repoRoot, "BUILD.bazel"),
      "utf8",
    );
    const tauriConfig = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    );

    expect(tauriConfig).toContain('"identifier": "build.kanna"');
    expect(rootBuild).toContain('bundle_id = "build.kanna"');
    expect(rootBuild).not.toContain('bundle_id = "com.kanna.app"');
  });

  it("declares a separate staging desktop app identity and updater channel", () => {
    const rootBuild = readFileSync(
      resolve(repoRoot, "BUILD.bazel"),
      "utf8",
    );
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );

    expect(rootBuild).toContain('name = "kanna_bundle_inputs_staging_arm64"');
    expect(rootBuild).toContain('name = "kanna_bundle_inputs_staging_x86_64"');
    expect(rootBuild).toContain('bundle_id = "build.kanna.staging"');
    expect(rootBuild).toContain('product_name = "Kanna Staging"');
    expect(rootBuild).toContain('output_name = "release/staging/arm64/Kanna Staging.app"');
    expect(rootBuild).toContain('output_name = "release/staging/x86_64/Kanna Staging.app"');
    expect(rootBuild).toContain('output_name = "release/staging/Kanna-Staging-arm64.dmg"');
    expect(rootBuild).toContain('output_name = "release/staging/Kanna-Staging-x86_64.dmg"');
    expect(rootBuild).toContain('"Kanna Staging.app": "160,175"');
    expect(releaseRuntime).toContain("latest-staging.json");
  });

  it("uses the custom macOS app icon for Bazel app and DMG builds", () => {
    const rootBuild = readFileSync(
      resolve(repoRoot, "BUILD.bazel"),
      "utf8",
    );
    const tauriConfigRaw = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    );
    const tauriConfig = JSON.parse(tauriConfigRaw) as TauriConfig;
    const macosIcon = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/icons/icon.icns"),
    );

    expect(rootBuild).toContain(
      'srcs = ["//apps/desktop/src-tauri:icons/icon.icns"]',
    );
    expect(rootBuild).toContain('volume_icon = ":desktop_macos_icon"');
    expect(tauriConfig.bundle.icon).toEqual(["icons/icon.icns"]);
    expect(sha256(macosIcon)).not.toBe(defaultTauriIconSha256);
  });

  it("keeps a vector source for the desktop app icon artwork", () => {
    const iconSvg = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/icons/icon.svg"),
      "utf8",
    );

    expect(iconSvg).toContain("<svg");
    expect(iconSvg).toContain('viewBox="0 0 512 512"');
    expect(iconSvg).toContain('id="app-icon-background"');
    expect(iconSvg).toContain('fill="#ffffff"');
  });

  it("keeps the macOS app icon artwork inside a taskbar-safe margin", () => {
    const macosIcon = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/icons/icon.icns"),
    );
    const largestPng = extractPngsFromIcns(macosIcon)
      .map(decodeRgbaPng)
      .sort((first, second) => second.width - first.width)[0];

    expect(largestPng.width).toBe(256);
    expect(largestPng.height).toBe(256);
    expect(alphaBounds(largestPng)).toEqual({
      width: 210,
      height: 210,
    });
  });

  it("keeps runtime PNG app icons visually aligned with the macOS bundle icon", () => {
    const iconDir = resolve(repoRoot, "apps/desktop/src-tauri/icons");

    expect(alphaBounds(decodeRgbaPng(readFileSync(resolve(iconDir, "128x128@2x.png"))))).toEqual({
      width: 210,
      height: 210,
    });
    expect(alphaBounds(decodeRgbaPng(readFileSync(resolve(iconDir, "128x128.png"))))).toEqual({
      width: 105,
      height: 105,
    });
    expect(alphaBounds(decodeRgbaPng(readFileSync(resolve(iconDir, "32x32.png"))))).toEqual({
      width: 26,
      height: 26,
    });
    expect(alphaBounds(decodeRgbaPng(readFileSync(resolve(iconDir, "icon.png"))))).toEqual({
      width: 422,
      height: 422,
    });
  });
});

describe("desktop version wiring", () => {
  it("routes desktop app version through crate constants so Bazel can override it from VERSION", () => {
    const desktopLib = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/src/lib.rs"),
      "utf8",
    );
    const fsCommands = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/src/commands/fs.rs"),
      "utf8",
    );

    expect(desktopLib).toContain(
      'pub(crate) const KANNA_VERSION: &str = env!("KANNA_VERSION");',
    );
    expect(desktopLib).toContain(".short_version(Some(KANNA_VERSION))");
    expect(fsCommands).toContain("version: crate::KANNA_VERSION.to_string(),");
  });

  it("does not hardcode the Bazel desktop app version in BUILD.bazel", () => {
    const desktopBuild = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/BUILD.bazel"),
      "utf8",
    );

    expect(desktopBuild).toContain('name = "kanna_desktop_lib_rs"');
    expect(desktopBuild).toContain('"//:VERSION"');
    expect(desktopBuild).toContain(
      'version = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8").strip()',
    );
    expect(desktopBuild).not.toContain('"KANNA_VERSION": "0.0.33"');
  });
});

describe("updater release assets", () => {
  it("requires updater signing inputs before publishing a release", () => {
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );
    const updaterKeyRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/updater-key.ts"),
      "utf8",
    );

    expect(releaseRuntime).toContain("preflightUpdaterSigningKey");
    expect(updaterKeyRuntime).toContain("KANNA_UPDATER_PUBKEY");
    expect(updaterKeyRuntime).toContain("TAURI_PRIVATE_KEY_PATH");
    expect(updaterKeyRuntime).toContain("TAURI_PRIVATE_KEY_PASSWORD");
  });

  it("creates architecture-specific updater tarballs and signatures", () => {
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );

    expect(releaseRuntime).toContain("Kanna_${version}_${label}.app.tar.gz");
    expect(releaseRuntime).toContain("updaterBundleTargetForLabel");
    expect(releaseRuntime).toContain('"tauri", "signer", "sign"');
    expect(releaseRuntime).toContain("const generatedSig = `${bundlePath}.sig`");
    expect(releaseRuntime).toContain("generatedSig !== signaturePath");
    expect(releaseRuntime).toContain("renameSync(generatedSig, signaturePath)");
    expect(releaseRuntime).not.toContain(
      'pnpm --dir "$ROOT/apps/desktop" exec tauri signer sign "$bundle_path" > "$signature_path"',
    );
    expect(releaseRuntime).toContain("updaterSignatureName");
  });

  it("builds updater tarballs inside Bazel so app directory modes are normalized before release signing", () => {
    const rootBuild = readFileSync(resolve(repoRoot, "BUILD.bazel"), "utf8");
    const bazelDefs = readFileSync(resolve(repoRoot, "tools/bazel/defs.bzl"), "utf8");

    expect(rootBuild).toContain("macos_updater_bundle(");
    expect(rootBuild).toContain('name = "kanna_updater_bundle_release_arm64"');
    expect(rootBuild).toContain('name = "kanna_updater_bundle_release_x86_64"');
    expect(bazelDefs).toContain("KannaMacosUpdaterBundle");
    expect(bazelDefs).toContain('cp -RL "$app_path" "$stage_root/$app_name"');
    expect(bazelDefs).toContain('find "$stage_root/$app_name" -type d -exec chmod 755 {} +');
    expect(bazelDefs).toContain("COPYFILE_DISABLE=1 tar");
  });

  it("publishes a latest.json manifest alongside the release assets", () => {
    const releaseRuntime = readFileSync(
      resolve(repoRoot, "tools/kd/src/runtime/release.ts"),
      "utf8",
    );

    expect(releaseRuntime).toContain("writeLatestJson");
    expect(releaseRuntime).toContain("Dry-run updater manifest");
    expect(releaseRuntime).toContain("latest.json");
    expect(releaseRuntime).toContain("darwin-aarch64");
    expect(releaseRuntime).toContain("darwin-x86_64");
    expect(releaseRuntime).toContain('"release", "create"');
    expect(releaseRuntime).toContain('"release", "upload"');
  });
});

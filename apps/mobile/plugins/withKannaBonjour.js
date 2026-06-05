const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject
} = require("@expo/config-plugins");

const SERVICE_TYPE = "_kanna-mobile._tcp";

const SWIFT_SOURCE = `import Foundation
import React

@objc(KannaBonjourModule)
final class KannaBonjourModule: RCTEventEmitter, NetServiceBrowserDelegate, NetServiceDelegate {
  private let browser = NetServiceBrowser()
  private var services: [String: NetService] = [:]

  override init() {
    super.init()
    browser.delegate = self
  }

  override static func requiresMainQueueSetup() -> Bool {
    false
  }

  override func supportedEvents() -> [String]! {
    ["kannaBonjourServiceChanged"]
  }

  @objc(startBrowsing)
  func startBrowsing() {
    browser.searchForServices(ofType: "${SERVICE_TYPE}.", inDomain: "local.")
  }

  @objc(stopBrowsing)
  func stopBrowsing() {
    browser.stop()
    services.removeAll()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    services[service.name] = service
    service.delegate = self
    service.resolve(withTimeout: 5)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    services.removeValue(forKey: service.name)
    sendService(service, removed: true)
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    sendService(sender, removed: false)
  }

  private func sendService(_ service: NetService, removed: Bool) {
    var txt: [String: String] = [:]
    if let data = service.txtRecordData() {
      for (key, value) in NetService.dictionary(fromTXTRecord: data) {
        txt[key] = String(data: value, encoding: .utf8) ?? ""
      }
    }

    sendEvent(
      withName: "kannaBonjourServiceChanged",
      body: [
        "name": service.name,
        "type": service.type,
        "host": service.hostName ?? "",
        "port": service.port,
        "txt": txt,
        "removed": removed
      ]
    )
  }
}
`;

const OBJC_SOURCE = `#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(KannaBonjourModule, RCTEventEmitter)

RCT_EXTERN_METHOD(startBrowsing)
RCT_EXTERN_METHOD(stopBrowsing)

@end
`;

function patchAppDelegate(contents) {
  if (contents.includes("kannaMetroBundleURL()")) {
    return contents;
  }

  return contents.replace(
    `  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }`,
    `  override func bundleURL() -> URL? {
#if DEBUG
    return kannaMetroBundleURL()
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }

  private func kannaMetroBundleURL() -> URL? {
    let provider = RCTBundleURLProvider.sharedSettings()
    if provider.jsLocation == nil,
       let host = readBundledTextResource("ip"),
       !host.isEmpty {
      let port = readBundledTextResource("metro-port") ?? "8081"
      provider.jsLocation = "\\(host):\\(port)"
    }
    return provider.jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
  }

  private func readBundledTextResource(_ name: String) -> String? {
    guard let path = Bundle.main.path(forResource: name, ofType: "txt") else {
      return nil
    }
    return try? String(contentsOfFile: path, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }`
  );
}

function patchMetroPortScript(project) {
  const section = project.hash.project.objects.PBXShellScriptBuildPhase || {};
  for (const phase of Object.values(section)) {
    if (!phase || phase.name !== '"Bundle React Native code and images"') {
      continue;
    }
    const shellScript = phase.shellScript;
    if (typeof shellScript !== "string" || shellScript.includes("metro-port.txt")) {
      continue;
    }
    phase.shellScript = shellScript.replace(
      "export PROJECT_ROOT=\\\"$PROJECT_DIR\\\"/..\\n\\n",
      "export PROJECT_ROOT=\\\"$PROJECT_DIR\\\"/..\\n\\nif [[ \\\"$CONFIGURATION\\\" = *Debug* && ! \\\"$PLATFORM_NAME\\\" == *simulator ]]; then\\n  mkdir -p \\\"$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH\\\"\\n  echo \\\"${RCT_METRO_PORT:-8081}\\\" > \\\"$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/metro-port.txt\\\"\\nfi\\n\\n"
    );
  }
}

function writeNativeSources(projectRoot) {
  const sourceRoot = IOSConfig.Paths.getSourceRoot(projectRoot);
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "KannaBonjourModule.swift"), SWIFT_SOURCE);
  fs.writeFileSync(path.join(sourceRoot, "KannaBonjourModule.m"), OBJC_SOURCE);
}

function withKannaBonjour(config) {
  config = withInfoPlist(config, (config) => {
    const services = new Set(config.modResults.NSBonjourServices || []);
    services.add(SERVICE_TYPE);
    config.modResults.NSBonjourServices = Array.from(services);
    config.modResults.NSLocalNetworkUsageDescription =
      config.modResults.NSLocalNetworkUsageDescription ||
      "Kanna discovers trusted desktop apps on your local network.";
    return config;
  });

  config = withDangerousMod(config, [
    "ios",
    (config) => {
      writeNativeSources(config.modRequest.projectRoot);
      const appDelegatePath = IOSConfig.Paths.getAppDelegateFilePath(
        config.modRequest.projectRoot
      );
      fs.writeFileSync(
        appDelegatePath,
        patchAppDelegate(fs.readFileSync(appDelegatePath, "utf8"))
      );
      return config;
    }
  ]);

  return withXcodeProject(config, (config) => {
    const projectRoot = config.modRequest.projectRoot;
    const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${projectName}/KannaBonjourModule.swift`,
      groupName: projectName,
      project: config.modResults
    });
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${projectName}/KannaBonjourModule.m`,
      groupName: projectName,
      project: config.modResults
    });
    patchMetroPortScript(config.modResults);
    return config;
  });
}

module.exports = withKannaBonjour;

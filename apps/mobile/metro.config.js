const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

function collectPnpmLinks(nodeModulesDir) {
  const watchFolders = new Set();
  const extraNodeModules = {};
  const visitedNodeModules = new Set();

  const addContainingNodeModules = (target) => {
    let current = path.dirname(target);
    while (current && current !== path.dirname(current)) {
      if (path.basename(current) === "node_modules") {
        watchFolders.add(current);
        return current;
      }

      current = path.dirname(current);
    }

    return null;
  };

  const addTarget = (packageName, entryPath) => {
    try {
      const stat = fs.lstatSync(entryPath);
      if (!stat.isSymbolicLink()) {
        return null;
      }

      const target = fs.realpathSync(entryPath);
      if (target !== entryPath) {
        watchFolders.add(target);
        extraNodeModules[packageName] = target;
        return addContainingNodeModules(target);
      }
    } catch {
      // Best-effort Metro support for pnpm's global virtual store.
    }

    return null;
  };

  const queue = [nodeModulesDir];
  while (queue.length > 0) {
    const currentNodeModulesDir = queue.shift();
    if (visitedNodeModules.has(currentNodeModulesDir)) {
      continue;
    }

    visitedNodeModules.add(currentNodeModulesDir);

    try {
      for (const entry of fs.readdirSync(currentNodeModulesDir)) {
        const entryPath = path.join(currentNodeModulesDir, entry);
        if (entry.startsWith("@")) {
          for (const scopedEntry of fs.readdirSync(entryPath)) {
            const packageName = `${entry}/${scopedEntry}`;
            const discoveredNodeModules = addTarget(
              packageName,
              path.join(entryPath, scopedEntry)
            );
            if (discoveredNodeModules) {
              queue.push(discoveredNodeModules);
            }
          }
        } else {
          const discoveredNodeModules = addTarget(entry, entryPath);
          if (discoveredNodeModules) {
            queue.push(discoveredNodeModules);
          }
        }
      }
    } catch {
      // Keep startup resilient if pnpm has not installed dependencies yet.
    }
  }

  return {
    extraNodeModules,
    watchFolders: [...watchFolders]
  };
}

const config = getDefaultConfig(__dirname);
const pnpmLinks = collectPnpmLinks(path.join(__dirname, "node_modules"));
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  ...pnpmLinks.extraNodeModules
};
config.watchFolders = [
  ...new Set([
    ...(config.watchFolders ?? []),
    ...pnpmLinks.watchFolders
  ])
];

module.exports = config;

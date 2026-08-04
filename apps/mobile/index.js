const { registerRootComponent } = require("expo");

const {
  installMobileCrashHandler
} = require("./src/lib/diagnostics/mobileCrashDiagnostics");

installMobileCrashHandler();

const App = require("./App").default;

registerRootComponent(App);

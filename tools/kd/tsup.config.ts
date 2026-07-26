import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "bin/kd": "src/bin/kd.ts",
    "bin/kd-mcp": "src/bin/kd-mcp.ts"
  },
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  dts: false,
  noExternal: ["@modelcontextprotocol/sdk", "smol-toml", "zod"]
});

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  splitting: true,
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});

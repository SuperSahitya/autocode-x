import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "tsup";

const GRAMMARS = ["tsx", "python", "go", "rust", "java"];

export default defineConfig({
  entry: ["src/index.ts"],
  splitting: true,
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  // tree-sitter-wasms is 50MB of every language, so ship only the ones we query
  onSuccess: async () => {
    const require = createRequire(import.meta.url);
    mkdirSync("dist/grammars", { recursive: true });
    for (const g of GRAMMARS) {
      copyFileSync(require.resolve(`tree-sitter-wasms/out/tree-sitter-${g}.wasm`), `dist/grammars/tree-sitter-${g}.wasm`);
    }
  },
});

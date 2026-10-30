import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: "scripts/generation-provider-canary.ts",
    outDir: "dist-provider-canary",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "provider-canary.mjs",
      },
    },
  },
});

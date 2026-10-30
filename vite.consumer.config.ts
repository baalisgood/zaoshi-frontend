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
    ssr: "scripts/generation-consumer.ts",
    outDir: "dist-consumer",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "consumer.mjs",
      },
    },
  },
});

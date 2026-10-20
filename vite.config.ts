import process from "node:process";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid()],
  // Preserving Rust diagnostics; Tauri shares this terminal with Vite.
  clearScreen: false,
  server: {
    // Matching Tauri's devUrl; a fallback port would leave the webview disconnected.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});

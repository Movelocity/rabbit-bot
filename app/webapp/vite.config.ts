import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/ui/" : "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../web",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 6173,
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:3738",
      "/health": "http://127.0.0.1:3738",
    },
  },
}));

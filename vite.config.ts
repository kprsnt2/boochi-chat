import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { getRequestListener } from "@hono/node-server";

/** Dev only: serve /api from the same Hono app the Node/Worker builds use. */
function devApi(): Plugin {
  return {
    name: "prash-dev-api",
    apply: "serve",
    async configureServer(server) {
      const { loadEnv } = await import("vite");
      const env = loadEnv("development", process.cwd(), "");
      const mod = await server.ssrLoadModule("/server/app.ts");
      const app = mod.createApp({ getEnv: () => env });
      const listener = getRequestListener(app.fetch);
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/")) return listener(req, res);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, strictPort: true },
});

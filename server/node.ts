/**
 * Node entry (Google Cloud Run, Docker, any VM).
 * Serves the built SPA from ./dist and the API from the same origin.
 * Request logging is NOT enabled — there is no logger middleware.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { SECURITY_HEADERS } from "./security.ts";

const api = createApp({ getEnv: () => process.env as Record<string, string | undefined> });

const root = new Hono();
root.route("/", api);
root.all("/api/*", (c) => c.json({ ok: false, error: "Not found." }, 404));

let indexHtml = "";
try {
  indexHtml = readFileSync("./dist/index.html", "utf8");
} catch {
  indexHtml = "<!doctype html><p>Build the client first: npm run build</p>";
}

root.use(
  "/assets/*",
  serveStatic({
    root: "./dist",
    onFound: (_path, c) => {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    },
  }),
);
root.use("*", serveStatic({ root: "./dist" }));
// SPA fallback.
root.get("*", (c) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  c.header("Cache-Control", "no-cache");
  return c.html(indexHtml);
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: root.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" });

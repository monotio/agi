import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev-only fixture server: autodiscovers installed games under ../games/.
 * A subfolder with AGI resource directories is served at
 * /fixtures/<slug>/<file>. GET /fixtures/ returns the installed slugs.
 * NEVER shipped: build output contains no fixture data.
 */
function fixtureServer(): Plugin {
  const gamesRoot = join(__dirname, "..", "games");
  const installedGames = (): string[] => {
    if (!existsSync(gamesRoot)) return [];
    return readdirSync(gamesRoot)
      .filter((slug) => /^[a-z0-9-]+$/.test(slug))
      .filter((slug) => {
        const path = join(gamesRoot, slug);
        return (
          statSync(path).isDirectory() &&
          readdirSync(path).some((name) => /^(?:LOG|[A-Z0-9_]+)DIR$/i.test(name))
        );
      })
      .sort();
  };
  return {
    name: "agi-fixture-server",
    configureServer(server) {
      server.middlewares.use("/fixtures", (req, res) => {
        const rel = (req.url ?? "").replace(/^\//, "").replace(/\/$/, "").split("?")[0]!;
        if (rel === "") {
          // Installed-game picker manifest.
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(installedGames()));
          return;
        }
        if (!/^[a-z0-9-]+(\/[A-Za-z0-9.]+)?$/.test(rel)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        const path = join(gamesRoot, rel);
        if (!existsSync(path)) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        if (statSync(path).isDirectory()) {
          // Directory manifest: avoids noisy 404 probing from the client.
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(readdirSync(path)));
          return;
        }
        res.setHeader("content-type", "application/octet-stream");
        res.end(readFileSync(path));
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), fixtureServer()],
  // SharedArrayBuffer (the LLM blocking bridge) requires cross-origin isolation.
  // Using credentialless allows cross-origin API calls (OpenAI / Anthropic) without CORP blocking.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: {
      "/api/openai": {
        target: "https://api.openai.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/openai/, ""),
      },
      "/api/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ""),
      },
    },
  },
  worker: {
    format: "es",
  },
});

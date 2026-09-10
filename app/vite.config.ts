import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";
import { scanFixtures } from "../test/fixtures.ts";

export interface InstalledFixtureDescriptor {
  readonly folder: string;
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly gameId: string;
  readonly title: string;
  readonly author?: string | undefined;
  readonly wordsSha256?: string | undefined;
  readonly objectSha256?: string | undefined;
  readonly walkthroughLabel?: string | undefined;
}

/**
 * Dev-only fixture server: autodiscovers installed games under ../games/.
 * A subfolder with AGI resource directories is served at
 * /fixtures/<folder>/<file> or /fixtures/<hash>/<file>.
 * GET /fixtures/ returns the installed games.
 * NEVER shipped: build output contains no fixture data.
 */
function fixtureServer(): Plugin {
  const gamesRoot = join(__dirname, "..", "games");
  const installedGames = (): InstalledFixtureDescriptor[] => {
    return scanFixtures().all.map((fixture) => {
      const known = fixture.known;
      return {
        folder: fixture.folder,
        hash: fixture.hash,
        alias: known?.alias,
        gameId: known?.alias ?? fixture.folder,
        title: known?.title ?? fixture.title,
        ...(fixture.author ? { author: fixture.author } : {}),
        ...(fixture.wordsSha256 ? { wordsSha256: fixture.wordsSha256 } : {}),
        ...(fixture.objectSha256 ? { objectSha256: fixture.objectSha256 } : {}),
        ...(known?.walkthroughLabel ? { walkthroughLabel: known.walkthroughLabel } : {}),
      };
    });
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
        if (!/^[a-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(rel)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        const [segment0, ...restSegments] = rel.split("/");
        const gameMatch = installedGames().find(
          (g) =>
            g.hash?.toLowerCase() === segment0!.toLowerCase() ||
            g.wordsSha256?.toLowerCase() === segment0!.toLowerCase() ||
            g.alias?.toLowerCase() === segment0!.toLowerCase() ||
            g.folder.toLowerCase() === segment0!.toLowerCase(),
        );
        const resolvedFolder = gameMatch ? gameMatch.folder : segment0!;
        const subPath = restSegments.join("/");
        const path = subPath
          ? join(gamesRoot, resolvedFolder, subPath)
          : join(gamesRoot, resolvedFolder);
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
  // require-corp works in Safari too; provider fetches opt in through CORS.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      // WebKit can reject cached modules shared by consecutive workers under COEP.
      "Cache-Control": "no-store",
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

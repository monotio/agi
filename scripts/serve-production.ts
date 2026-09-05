// Local verification adapter for the static host's response headers.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../app/", import.meta.url));
const root = resolve(app, "dist");
const config = JSON.parse(await readFile(resolve(app, "staticwebapp.config.json"), "utf8"));
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(config.globalHeaders))
    res.setHeader(name, String(value));
  const target = resolve(root, decodeURIComponent(path.slice(1)) || "index.html");
  if (!target.startsWith(root + sep)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = await readFile(target);
    res.setHeader("Content-Type", types[extname(target)] ?? "application/octet-stream");
    const route = config.routes.find((entry: { route: string }) =>
      entry.route.endsWith("*") ? path.startsWith(entry.route.slice(0, -1)) : path === entry.route,
    );
    for (const [name, value] of Object.entries(route?.headers ?? {}))
      res.setHeader(name, String(value));
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(5299, "127.0.0.1");

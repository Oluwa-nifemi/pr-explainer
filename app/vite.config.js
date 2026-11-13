import { defineConfig } from "vite";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Serves ../pipeline/out/*.json at /pipeline/<name>.json and a listing at /pipeline/index.json.
// The pipeline writes real stories there; the app loads them with ?story=<name>.
const PIPELINE_DIR = fileURLToPath(new URL("../pipeline/out", import.meta.url));


function pipelineStories() {
  const handler = (req, res, next) => {
    const url = (req.url || "").split("?")[0];
    if (!url.startsWith("/pipeline/")) return next();
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url === "/pipeline/index.json") {
      if (!existsSync(PIPELINE_DIR)) return send(200, []);
      const list = readdirSync(PIPELINE_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            const s = JSON.parse(readFileSync(join(PIPELINE_DIR, f), "utf8"));
            return { name: f.replace(/\.json$/, ""), url: s.pr?.url, title: s.pr?.title, repo: s.pr?.repo, number: s.pr?.number, author: s.pr?.author, status: s.generation?.status };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return send(200, list);
    }
    const m = /^\/pipeline\/([\w.@-]+)\.json$/.exec(url);
    const file = m && join(PIPELINE_DIR, m[1] + ".json");
    if (!file || !existsSync(file)) return send(404, { error: "not found" });
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(readFileSync(file));
  };
  return {
    name: "pipeline-stories",
    configureServer(s) {
      s.middlewares.use(handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use(handler);
    },
  };
}

// The export build writes one HTML file: the app, the styles and the fonts all inlined.
function singleFile() {
  const tagFor = (file) => new RegExp('<(?:script|link)[^>]*' + file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*>(?:</script>)?');
  return {
    name: "single-file",
    enforce: "post",
    generateBundle(_, bundle) {
      const page = Object.values(bundle).find((f) => f.fileName.endsWith(".html"));
      let html = String(page.source);
      for (const file of Object.values(bundle)) {
        if (file.fileName === page.fileName) continue;
        if (file.type === "chunk") {
          const code = file.code.replace(/<\/script/gi, "<\\/script");
          html = html.replace(tagFor(file.fileName), () => `<script type="module">${code}</script>`);
        } else if (file.fileName.endsWith(".css")) {
          html = html.replace(tagFor(file.fileName), () => `<style>${String(file.source)}</style>`);
        }
        delete bundle[file.fileName];
      }
      page.source = html;
    },
  };
}

export default defineConfig(({ mode }) =>
  mode === "export"
    ? {
        plugins: [singleFile()],
        build: {
          outDir: "dist-export",
          assetsInlineLimit: 10 * 1024 * 1024,
          modulePreload: false,
          rollupOptions: {
            input: fileURLToPath(new URL("./export.html", import.meta.url)),
            output: { inlineDynamicImports: true },
          },
        },
      }
    : {
        plugins: [pipelineStories()],
        server: { host: "127.0.0.1", port: 5180, strictPort: true },
        preview: { host: "127.0.0.1", port: 5180, strictPort: true },
        build: { chunkSizeWarningLimit: 900 },
      },
);

/**
 * server.ts
 *
 * Minimal dev server that serves the standalone pet animation demo page.
 * Run: pnpm start (or node dist/server.js), then open http://127.0.0.1:7860
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoPage } from "./browser-render.js";
const port = Number(process.env.PORT ?? 7860);
const distDir = dirname(fileURLToPath(import.meta.url));
const assetsRelative = join(distDir, "..", "assets", "assets");
const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/" || url.startsWith("/index")) {
        const html = createDemoPage({ scale: 1.25, waitingAnimationDurationMs: 1010, spritesheetUrl: "/default-pet-spritesheet.webp" });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
    }
    if (url === "/default-pet-spritesheet.webp") {
        try {
            const bytes = readFileSync(join(assetsRelative, "default-pet-spritesheet.webp"));
            response.writeHead(200, { "content-type": "image/webp" });
            response.end(bytes);
            return;
        }
        catch {
            response.writeHead(404);
            response.end("spritesheet not found");
            return;
        }
    }
    response.writeHead(404);
    response.end("not found");
});
server.listen(port, "127.0.0.1", () => {
    console.log(`Pet animation demo running: http://127.0.0.1:${port}`);
});

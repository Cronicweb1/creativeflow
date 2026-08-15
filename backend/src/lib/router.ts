import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

/**
 * Minimal dependency-free HTTP router + static file server.
 * Kept deliberately small: pattern params (`/api/production/:id`),
 * JSON bodies, JSON responses, and SPA-safe static serving.
 */

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
}

export type Handler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
};

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, code: string): void {
  sendJson(res, status, { error: code });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export class Router {
  private routes: Route[] = [];
  private staticRoot: string;

  constructor(staticRoot: string) {
    this.staticRoot = staticRoot;
  }

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({
      method,
      segments: pattern.split("/").filter(Boolean),
      handler,
    });
  }

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathSegments = url.pathname.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = matchSegments(route.segments, pathSegments);
      if (!params) continue;
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      if (body === null) return sendError(res, 400, "invalid_json");
      try {
        await route.handler({ req, res, params, body });
      } catch (err) {
        const code = err instanceof Error ? err.message : "internal_error";
        const status =
          code === "session_not_found" || code === "brief_not_found" || code === "job_not_found"
            ? 404
            : code === "conversation_closed"
              ? 409
              : 500;
        sendError(res, status, status === 500 ? "internal_error" : code);
      }
      return;
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      return this.serveStatic(url.pathname, res);
    }
    sendError(res, 404, "not_found");
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(this.staticRoot, safe);
    if (!filePath.startsWith(this.staticRoot)) return sendError(res, 403, "forbidden");

    try {
      const info = await stat(filePath).catch(() => null);
      if (!info || info.isDirectory()) {
        // SPA fallback — the frontend owns all non-API paths.
        filePath = join(this.staticRoot, "index.html");
      }
      const content = await readFile(filePath);
      const type = MIME[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
      });
      res.end(content);
    } catch {
      sendError(res, 404, "not_found");
    }
  }
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (pattern[i] !== actual[i]) return null;
  }
  return params;
}

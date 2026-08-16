/**
 * Composio session layer (@composio/core SDK).
 *
 * The current Composio platform exposes tools through *sessions*
 * (`composio.sessions.create(...)`), which return a per-session hosted MCP
 * endpoint (`session.mcp.url` + `session.mcp.headers`). This replaces the
 * old generic `https://connect.composio.dev/mcp` + `x-consumer-api-key`
 * transport, which rejected our tool calls with "Authorization required /
 * not a valid AuthKit JWT".
 *
 * COMPOSIO_API_KEY (a Composio *project* API key from the dashboard, used by
 * the SDK against api.composio.dev) stays server-side only.
 */

export interface ComposioMcpEndpoint {
  url: string;
  headers: Record<string, string>;
}

export interface ComposioSessionHandle {
  /** Composio's own session id (persist to reuse across restarts). */
  composioSessionId: string;
  mcp: ComposioMcpEndpoint;
}

export interface ComposioSessionFactory {
  /** Create a new Composio session for the given stable user identity. */
  createSession(userId: string): Promise<ComposioSessionHandle>;
  /** Re-attach to an existing Composio session by its id. */
  useSession(composioSessionId: string): Promise<ComposioSessionHandle>;
}

/** Exact session configuration used for Gemini/Veo video generation. */
export const GEMINI_SESSION_CONFIG = {
  mcp: true,
  toolkits: ["gemini"],
  tools: {
    gemini: {
      enable: ["GEMINI_GENERATE_VIDEOS", "GEMINI_WAIT_FOR_VIDEO"],
    },
  },
  // Filled with SessionPreset.DIRECT_TOOLS from the installed SDK at
  // runtime (value "direct_tools") — see sdkSessionConfig() below.
  sessionPreset: "direct_tools",
} as const;

/** Stable Composio user identity for a CreativeFlow session. */
export function composioUserId(creativeflowSessionId: string): string {
  return `creativeflow:${creativeflowSessionId}`;
}

interface SessionsLike {
  create(userId: string, config: Record<string, unknown>): Promise<unknown>;
  use(id: string, options: Record<string, unknown>): Promise<unknown>;
}

function toHandle(session: unknown): ComposioSessionHandle {
  const s = session as {
    sessionId?: unknown;
    mcp?: { url?: unknown; headers?: unknown };
  };
  const url = s?.mcp?.url;
  if (typeof s?.sessionId !== "string" || !s.sessionId) {
    throw new Error("composio_session_missing_id");
  }
  if (typeof url !== "string" || !url) {
    throw new Error("composio_session_missing_mcp_url");
  }
  const headers =
    s.mcp && s.mcp.headers && typeof s.mcp.headers === "object"
      ? ({ ...(s.mcp.headers as Record<string, string>) } as Record<string, string>)
      : {};
  return { composioSessionId: s.sessionId, mcp: { url, headers } };
}

/**
 * Real SDK-backed factory. The @composio/core import is lazy so the mock
 * provider and non-video code paths never load the SDK.
 */
export class SdkComposioSessionFactory implements ComposioSessionFactory {
  private sessionsPromise: Promise<{ sessions: SessionsLike; preset: string }> | null = null;
  private injected: SessionsLike | null;
  private apiKey: string | undefined;

  constructor(opts?: { sessions?: SessionsLike; apiKey?: string }) {
    this.injected = opts?.sessions ?? null;
    this.apiKey = opts?.apiKey;
  }

  private async sdk(): Promise<{ sessions: SessionsLike; preset: string }> {
    if (this.injected) return { sessions: this.injected, preset: GEMINI_SESSION_CONFIG.sessionPreset };
    if (!this.sessionsPromise) {
      this.sessionsPromise = (async () => {
        const mod = await import("@composio/core");
        const Composio = (mod as Record<string, unknown>).Composio as new (opts: {
          apiKey?: string;
        }) => { sessions: SessionsLike };
        const presetEnum = (mod as Record<string, unknown>).SessionPreset as
          | Record<string, string>
          | undefined;
        const preset = presetEnum?.DIRECT_TOOLS ?? GEMINI_SESSION_CONFIG.sessionPreset;
        const composio = new Composio({
          apiKey: this.apiKey ?? process.env.COMPOSIO_API_KEY,
        });
        return { sessions: composio.sessions, preset };
      })().catch((err: unknown) => {
        this.sessionsPromise = null; // allow retry after transient failures
        throw err;
      });
    }
    return this.sessionsPromise;
  }

  async createSession(userId: string): Promise<ComposioSessionHandle> {
    const { sessions, preset } = await this.sdk();
    const session = await sessions.create(userId, {
      ...GEMINI_SESSION_CONFIG,
      toolkits: [...GEMINI_SESSION_CONFIG.toolkits],
      tools: {
        gemini: { enable: [...GEMINI_SESSION_CONFIG.tools.gemini.enable] },
      },
      sessionPreset: preset,
    });
    return toHandle(session);
  }

  async useSession(composioSessionId: string): Promise<ComposioSessionHandle> {
    const { sessions } = await this.sdk();
    const session = await sessions.use(composioSessionId, { mcp: true });
    return toHandle(session);
  }
}

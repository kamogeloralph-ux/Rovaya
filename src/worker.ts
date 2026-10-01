import type { ExecutionContext, ExportedHandler } from "@cloudflare/workers-types";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../server/routers";
import { createWorkerContext } from "../server/_core/worker-context";
import { handleStorageProxy } from "../server/_core/worker-storage-proxy";
import { handleApi } from "../server/api/router";
import { runRetention } from "../server/api/retention";
import type { Env } from "../server/_core/worker-env";

export type { Env };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Rovaya REST API: D1 + R2, fronted by the Cloudflare edge cache. Supabase is only
    // contacted for sign-in (token issue/refresh) - never for data.
    const apiResponse = await handleApi(request, env, ctx);
    if (apiResponse) return apiResponse;

    // Handle tRPC API requests
    if (url.pathname.startsWith("/api/trpc")) {
      // Captured by createContext, then read back in responseMeta so
      // procedures (e.g. auth.logout) can set response headers like
      // Set-Cookie, which the Fetch API has no other way to attach.
      let workerCtx: Awaited<ReturnType<typeof createWorkerContext>> | undefined;

      return fetchRequestHandler({
        endpoint: "/api/trpc",
        req: request,
        router: appRouter,
        createContext: async () => {
          workerCtx = await createWorkerContext(request, env);
          return workerCtx;
        },
        responseMeta: () => {
          // An empty Headers object applies no headers, so there's no need
          // to check emptiness first (that required iterating the Headers,
          // which needs a newer compile target than this project uses).
          if (!workerCtx) {
            return {};
          }
          return { headers: workerCtx.responseHeaders };
        },
        onError:
          env.ENVIRONMENT === "development"
            ? ({ path, error }) => {
                console.error(`✘ tRPC failed on ${path}:`, error);
              }
            : undefined,
      });
    }

    // Handle OAuth callback
    if (url.pathname === "/api/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    // Handle storage proxy for R2
    if (url.pathname.startsWith("/manus-storage/")) {
      return handleStorageProxy(request, env);
    }

    // Default 404
    return new Response("Not Found", { status: 404 });
  },
  // Nightly cleanup (see [triggers] in wrangler.toml): expired photos + orphaned R2 uploads.
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRetention(env).then((result) => console.log("[retention]", JSON.stringify(result))));
  },
// `satisfies ExportedHandler<Env>` would fail here: ExportedHandler's own
// signature expects @cloudflare/workers-types' Request/Response, but this
// file deliberately uses lib.dom's (same objects at the real Workers
// runtime — see the comment in worker-storage-proxy.ts for why we use
// scoped imports instead of the global ambient override).
} as unknown as ExportedHandler<Env>;

/**
 * Handle OAuth callback from OAuth provider
 */
async function handleOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response(
      JSON.stringify({ error: "code and state are required" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  try {
    // Import OAuth handler from your existing oauth.ts adapted for Workers
    const { handleOAuthCallback: handleCallback } = await import(
      "../server/_core/worker-oauth"
    );
    return await handleCallback(request, env, code, state);
  } catch (error) {
    console.error("[OAuth] Callback failed:", error);
    return new Response(
      JSON.stringify({ error: "OAuth callback failed" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}

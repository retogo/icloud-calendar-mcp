import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleAuthorize } from "./authorize.ts";
import { CalDavClient } from "./caldav-client.ts";
import { createMcpServer } from "./mcp-server.ts";
import { CalendarTools } from "./tools.ts";

const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";
const MCP_ROUTE = "/mcp";
const AUTHORIZE_PATH = "/authorize";
const SCOPE = "calendar";

const apiHandler = {
  fetch(request, env, ctx) {
    const client = new CalDavClient({
      serverUrl: ICLOUD_CALDAV_URL,
      username: env.ICLOUD_USERNAME,
      password: env.ICLOUD_APP_PASSWORD,
    });
    const tools = new CalendarTools(client, {
      now: () => new Date(),
      newUid: () => crypto.randomUUID(),
    });
    return createMcpHandler(() => createMcpServer(tools), { route: MCP_ROUTE })(
      request,
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;

const defaultHandler = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === AUTHORIZE_PATH) {
      return handleAuthorize(request, {
        helpers: env.OAUTH_PROVIDER,
        ownerPassword: env.AUTH_PASSWORD,
        limiter: env.AUTHORIZE_LIMITER,
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const providers = new Map<string, OAuthProvider<Env>>();

/** The resource depends on the deployed URL, so build it from each request origin */
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_ROUTE,
      apiHandler,
      defaultHandler,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: {
        resource: `${origin}${MCP_ROUTE}`,
        authorization_servers: [origin],
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

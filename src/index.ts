import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { type ApiEnv, SolastaApi } from './api.js'
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js'

export interface Env extends ApiEnv {
  DEFAULT_DEALER?: string
  REQUEST_LIMITER?: RateLimit
  QUOTE_LIMITER?: RateLimit
}

const DEALER_PATH = /^\/d\/([a-z0-9-]{2,40})\/mcp\/?$/
/** Largest request body accepted (a KML of a large home is well under this). */
const MAX_BODY_BYTES = 1_000_000

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const json = (body: unknown, status = 200) =>
  withCors(Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } }))

const clientKey = (request: Request) => request.headers.get('CF-Connecting-IP') ?? 'unknown'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }))

    if (url.pathname === '/' && request.method === 'GET') {
      return json({
        name: SERVER_NAME, version: SERVER_VERSION,
        description: 'Permanent roofline lighting estimates and quote requests from Solasta Lighting and its dealers, for AI assistants.',
        mcp: { all_dealers: `${url.origin}/mcp`, one_dealer: `${url.origin}/d/{dealer}/mcp` },
      })
    }
    if (url.pathname === '/health') return json({ ok: true })

    const dealerMatch = DEALER_PATH.exec(url.pathname)
    if (url.pathname !== '/mcp' && url.pathname !== '/mcp/' && !dealerMatch) return json({ error: 'Not found' }, 404)

    const key = clientKey(request)
    if (env.REQUEST_LIMITER && !(await env.REQUEST_LIMITER.limit({ key })).success)
      return json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests. Please slow down.' }, id: null }, 429)

    const length = Number(request.headers.get('Content-Length') ?? '0')
    if (length > MAX_BODY_BYTES) return json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request too large.' }, id: null }, 413)

    return withCors(await handleMcp(request, env, dealerMatch?.[1], key))
  },
} satisfies ExportedHandler<Env>

/** Stateless MCP: a new server and transport per request, answering in JSON. */
export async function handleMcp(request: Request, env: Env, dealer: string | undefined, key: string, fetcher: typeof fetch = fetch): Promise<Response> {
  const api = new SolastaApi(env, fetcher)
  const server = buildServer({
    api,
    dealer,
    defaultDealer: env.DEFAULT_DEALER || 'solasta',
    allowQuoteRequest: async () => !env.QUOTE_LIMITER || (await env.QUOTE_LIMITER.limit({ key: `quote:${key}` })).success,
    fetcher,
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    // The JSON response is complete once handleRequest returns.
    void transport.close()
    void server.close()
  }
}

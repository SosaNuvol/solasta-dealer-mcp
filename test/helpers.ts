import { clearTokenCache } from '../src/api.js'
import { handleMcp, type Env } from '../src/index.js'

export const env: Env = {
  SOLASTA_API_URL: 'https://api.example-solasta.test',
  IDENTITY_TOKEN_URL: 'https://identity.example-solasta.test/connect/token',
  MCP_CLIENT_ID: 'dealer-mcp',
  MCP_CLIENT_SECRET: 'secret',
  DEFAULT_DEALER: 'solasta',
}

export type Route = (url: URL, init: RequestInit | undefined) => Response | undefined

export interface FakeFetch {
  fetch: typeof fetch
  calls: { url: URL; method: string; body?: unknown }[]
}

/** A fetch that answers the Identity Server, then the given routes, and fails anything else. */
export function fakeFetch(...routes: Route[]): FakeFetch {
  clearTokenCache()
  const calls: FakeFetch['calls'] = []
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    let body: unknown = init?.body
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* form data */ } }
    calls.push({ url, method, body })
    if (url.pathname === '/connect/token') return Response.json({ access_token: 'token-1', expires_in: 3600 })
    for (const route of routes) {
      const response = route(url, init)
      if (response) return response
    }
    return new Response('not mocked: ' + url.href, { status: 599 })
  }
  return { fetch: fn as typeof fetch, calls }
}

export const payload = (value: unknown, status = 200) => Response.json({ payload: value, message: '', code: status }, { status })

let nextId = 1

/** Sends one JSON-RPC request to the stateless MCP endpoint and returns its result (or error). */
export async function rpc(method: string, params: unknown, fetcher: typeof fetch, dealer?: string): Promise<any> {
  const request = new Request('https://mcp.mysolasta.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  const response = await handleMcp(request, env, dealer, '203.0.113.9', fetcher)
  const data = (await response.json()) as { result?: unknown; error?: unknown }
  return data.error ? { error: data.error } : data.result
}

export const callTool = (name: string, args: Record<string, unknown>, fetcher: typeof fetch, dealer?: string) =>
  rpc('tools/call', { name, arguments: args }, fetcher, dealer)

export const toolText = (result: any): string => result?.content?.[0]?.text ?? JSON.stringify(result)

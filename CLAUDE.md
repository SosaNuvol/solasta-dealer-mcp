# solasta-dealer-mcp

Public MCP server (Cloudflare Worker, TypeScript) at `mcp.mysolasta.com` for AI assistants: price ranges, roofline KML help and quote requests for Solasta Lighting dealers. README.md has the tools, configuration and deploy steps.

- Work tracking: a GitHub issue first, then a PR that says `Closes #<issue>`. Default branch `main`.
- No business rules here. Pricing, KML reading, dealer lookup and lead creation live in the Solasta API (`quadradia/solasta-lighting-est-api`, `Controllers/Public/PublicEstimatesController.cs`, `PublicEstimateFacade`). Change the API, then the client types in `src/api.ts`.
- `src/server.ts` registers the tools; `src/index.ts` routes `/mcp` and `/d/{dealer}/mcp` and applies rate limits; `src/footprint.ts` turns an address into perimeter feet; `src/kmlGuide.ts` must match the API's KML naming rules (`RooflinePins`, `RooflineAnalyzer`).
- Every price shown is an estimate range; keep the wording that the dealer confirms the price.
- Never put secrets in `wrangler.jsonc`; `MCP_CLIENT_SECRET` is a Worker secret (`.dev.vars` locally, git-ignored).
- `npm test` and `npm run typecheck` before a PR. Tests use a fake fetch (`test/helpers.ts`), never the network.
- Pin dependency versions exactly. `.npmrc` sets `legacy-peer-deps` because vitest 4's optional peers break npm's resolver.

# solasta-dealer-mcp

A public [MCP](https://modelcontextprotocol.io) server that lets homeowners and businesses use an AI assistant (Claude, ChatGPT, Gemini and others) to get a price range for permanent roofline lighting, map their roofline as a KML, and ask a Solasta dealer for a quote.

It runs on Cloudflare Workers at `mcp.mysolasta.com` and holds no business rules: prices, KML reading and lead creation all happen in the Solasta API (`api/public/...`), with the same code staff use.

| Endpoint | For |
| --- | --- |
| `https://mcp.mysolasta.com/mcp` | Any address: tools find the dealer from the ZIP code. |
| `https://mcp.mysolasta.com/d/{dealer}/mcp` | One dealer (`/d/solasta/mcp`); tools take no dealer argument. A dealer's website links to its own. |

Transport: Streamable HTTP, stateless, JSON responses. No sign-in for AI clients.

## Tools

| Tool | Does | API route |
| --- | --- | --- |
| `find_dealer` | Dealers that serve a ZIP code | `GET api/public/dealers?zip=` |
| `get_dealer_info` | Contact details, service area, how estimates work | `GET api/public/{dealer}/profile` |
| `list_products` | Rails (per foot) with colors, add-ons, fixed costs, public promotions | `GET api/public/{dealer}/catalog` |
| `estimate_from_address` | Rough range: address → US Census geocoder → OpenStreetMap building outline → perimeter feet | `POST api/public/{dealer}/estimates` (`source: Footprint`) |
| `kml_instructions` | Google Earth steps and pin naming rules (also resource `solasta://guides/roofline-kml`) | none |
| `check_kml` | Reads a KML like the installer's tools; feet by side and problems to fix | `POST api/public/{dealer}/kml-checks` |
| `estimate_from_kml` | Tighter range from the person's KML | `POST api/public/{dealer}/estimates` (`source: Kml`) |
| `request_quote` | Sends the person's details (and KML) to the dealer as a lead | `POST api/public/{dealer}/quote-requests` |

Prompt: `plan_my_lights`.

Every price is a range (the dealer's uncertainty: ±25% from a footprint, ±10% from a KML by default, rounded to $50) and says it is at retail prices, that seasonal promotions, discounts and installation details change the final price, and that the dealer confirms the price after checking the roofline. The API's closing note also points to the dealer's affiliate program when the dealer has one. When the dealer has a quote form (`PublicEstimates:QuoteFormUrls` in the API), each estimate ends with a link to it that carries the estimate id and the address the person gave (`street`, `city`, `state`, `zip`), so the form opens filled in and the person can ask for a quote there instead of through `request_quote`. An address no dealer serves gets "not in your area yet"; its quote request is kept for `DEFAULT_DEALER`, marked out of area.

## Abuse limits

- `REQUEST_LIMITER`: 60 MCP requests a minute per IP. `QUOTE_LIMITER`: 3 quote requests a minute per IP (Cloudflare rate limiting bindings).
- Request bodies over 1 MB and KML text over 500,000 characters are refused.
- `request_quote` refuses throwaway email domains and fake phone numbers (`src/contact.ts`). There is no captcha because an AI assistant can't solve one; every lead is tagged with source "AI Assistant" so staff can tell them apart. A per-dealer email confirmation step can be added if spam shows up.

## Setup

```bash
npm install
npm test            # vitest, no network
npm run typecheck
npx wrangler dev    # local; set MCP_CLIENT_SECRET in .dev.vars to reach a real API
```

Configuration (`wrangler.jsonc`):

| Name | Kind | Value |
| --- | --- | --- |
| `SOLASTA_API_URL` | var | `https://api.mysolasta.com` |
| `IDENTITY_TOKEN_URL` | var | NOAH Identity Server token endpoint |
| `MCP_CLIENT_ID` | var | `dealer-mcp` |
| `MCP_CLIENT_SECRET` | secret | `npx wrangler secret put MCP_CLIENT_SECRET` |
| `DEFAULT_DEALER` | var | `solasta` |

The Identity Server needs a `dealer-mcp` client (client credentials, scope `public.estimate`, no `sub`/`tenant_id` claims). The API signs each `{dealer}` request in as that dealer's service user from `ACC.DealerPublicProfiles`.

## Deploy

`npx wrangler deploy` publishes to the `mcp.mysolasta.com` custom domain (the `mysolasta.com` zone must be in the same Cloudflare account). Check it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) against `https://mcp.mysolasta.com/mcp`.

## Troubleshooting

Run `npx wrangler tail` (or open the Worker's Logs in the Cloudflare dashboard) and retry the tool. Each failure logs one line:

| Log line | Meaning |
| --- | --- |
| `Identity Server unreachable` / `refused the dealer-mcp client` / `answered without a token` | The `dealer-mcp` client or its secret is wrong or missing on the Identity Server, or it is down |
| `Solasta API unreachable` / `Solasta API call failed` | The API is down or answered with an error (the status is logged) |
| `Address lookup ...` | The US Census geocoder is down |
| `Building outline lookup ...` | A map service refused or timed out; the next Overpass server in `OVERPASS_URLS` is tried, then the OpenStreetMap API |
| `Tool failed` | Anything else, with the error's name and message |
| `Illegal invocation` | `fetch` was called as a method of another object; the Workers runtime only allows a plain call |

## Try it in Claude

Settings → Connectors → Add custom connector → `https://mcp.mysolasta.com/mcp`.

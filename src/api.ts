// Client for the Solasta API's public estimate routes (api/public/...). The API does all pricing, KML reading and lead
// creation; this Worker only passes requests on. It signs in with the dealer-mcp client's credentials (scope
// public.estimate) and never sends that token to the AI client.

import { describeError } from './errors.js'

export interface ApiEnv {
  SOLASTA_API_URL?: string
  IDENTITY_TOKEN_URL?: string
  MCP_CLIENT_ID?: string
  MCP_CLIENT_SECRET?: string
}

export interface DealerSummary {
  slug: string
  displayName: string
  description?: string | null
  websiteUrl?: string | null
  phone?: string | null
  email?: string | null
}

export interface DealerLookup {
  postalCode: string
  covered: boolean
  dealers: DealerSummary[]
}

export interface DealerProfile extends DealerSummary {
  estimateValidityDays: number
  footprintUncertainty: number
  kmlUncertainty: number
  serviceAreas: string[]
}

export interface CatalogVariant {
  stockItemId: number
  sku: string
  name: string
  priceAdder: number
}

export interface CatalogItem {
  sku: string
  name: string
  category: string
  unit: string
  price: number
  variants: CatalogVariant[]
}

export interface Catalog {
  rails: CatalogItem[]
  fixedItems: CatalogItem[]
  addOns: CatalogItem[]
  promotions: { code: string; name: string; amountPerFoot: number; endDate?: string | null }[]
}

export interface KmlCheck {
  documentName?: string | null
  pinCount: number
  segmentCount: number
  railFeet: number
  locations: { location: string; feet: number; roundedFeet: number }[]
  warnings: string[]
  isUsable: boolean
}

export type EstimateSource = 'Footprint' | 'Kml' | 'Typed'

export interface EstimateRequest {
  source: EstimateSource
  feet?: number
  kml?: string
  productSku?: string
  variantStockItemId?: number
  addOns?: { sku: string; quantity: number }[]
  city?: string
  state?: string
  postalCode?: string
  clientSessionId?: string
}

export interface Estimate {
  estimateId: string
  source: EstimateSource
  feet: number
  uncertainty: number
  lowFeet: number
  highFeet: number
  productSku: string
  productName: string
  variantName?: string | null
  promotion?: { code: string; name: string; amountPerFoot: number } | null
  taxRate: number
  lowTotal: number
  highTotal: number
  monthlyFrom?: { termMonths: number; apr: number; amount: number; label?: string | null } | null
  validUntil: string
  warnings: string[]
  disclaimer: string
}

export interface QuoteRequest {
  firstName: string
  lastName: string
  email: string
  phone?: string
  businessName?: string
  address1?: string
  city?: string
  state?: string
  postalCode?: string
  projectType?: 'Residential' | 'Business'
  language?: 'en' | 'es'
  smsConsent: boolean
  smsConsentText?: string
  estimateId?: string
  kml?: string
  notes?: string
  referralCode?: string
  outOfArea?: boolean
}

export interface QuoteRequestResult {
  reference: string
  isNewLead: boolean
  measurementAttached: boolean
  message: string
}

/** A refusal from the API that the AI client can act on (bad input, unknown dealer). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly fieldErrors: Record<string, string[]> = {}) {
    super(message)
  }
}

interface Envelope<T> {
  payload?: T
  message?: string
  validationErrors?: Record<string, string[]> | { field?: string; message?: string }[] | null
}

let cachedToken: { key: string; value: string; expiresAt: number } | undefined

/** For tests. */
export function clearTokenCache(): void { cachedToken = undefined }

export class SolastaApi {
  private readonly fetcher: typeof fetch

  constructor(private readonly env: ApiEnv, fetcher: typeof fetch = fetch) {
    // Called as a plain function: the Workers runtime throws "Illegal invocation" when its fetch is called as a
    // method of another object (this.fetcher(...)).
    this.fetcher = ((input, init) => fetcher(input, init)) as typeof fetch
  }

  get isConfigured(): boolean {
    const { SOLASTA_API_URL, IDENTITY_TOKEN_URL, MCP_CLIENT_ID, MCP_CLIENT_SECRET } = this.env
    return !!(SOLASTA_API_URL && IDENTITY_TOKEN_URL && MCP_CLIENT_ID && MCP_CLIENT_SECRET)
  }

  findDealers(postalCode: string): Promise<DealerLookup> {
    return this.call<DealerLookup>('GET', `/api/public/dealers?zip=${encodeURIComponent(postalCode)}`)
  }

  profile(dealer: string): Promise<DealerProfile> {
    return this.call<DealerProfile>('GET', `/api/public/${slug(dealer)}/profile`)
  }

  catalog(dealer: string): Promise<Catalog> {
    return this.call<Catalog>('GET', `/api/public/${slug(dealer)}/catalog`)
  }

  checkKml(dealer: string, kml: string): Promise<KmlCheck> {
    return this.call<KmlCheck>('POST', `/api/public/${slug(dealer)}/kml-checks`, { kml })
  }

  estimate(dealer: string, request: EstimateRequest): Promise<Estimate> {
    return this.call<Estimate>('POST', `/api/public/${slug(dealer)}/estimates`, request)
  }

  requestQuote(dealer: string, request: QuoteRequest): Promise<QuoteRequestResult> {
    return this.call<QuoteRequestResult>('POST', `/api/public/${slug(dealer)}/quote-requests`, request)
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.isConfigured) throw new ApiError('The estimate service is not configured yet.', 503)
    const url = new URL(path, this.env.SOLASTA_API_URL)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new ApiError('The estimate service is not configured yet.', 503)

    const fetchApi = (token: string) => this.fetcher(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    })
    const send = async (token: string) => {
      try { return await fetchApi(token) } catch (error) {
        console.error('Solasta API unreachable', { path: url.pathname, ...describeError(error) })
        throw new ApiError('The estimate service is not available right now. Please try again in a few minutes.', 502)
      }
    }

    let response = await send(await this.token(false))
    if (response.status === 401) response = await send(await this.token(true))

    let envelope: Envelope<T> | undefined
    try { envelope = (await response.json()) as Envelope<T> } catch { envelope = undefined }

    if (response.ok && envelope?.payload !== undefined && envelope.payload !== null) return envelope.payload
    if (response.status === 400) {
      const fieldErrors = normalizeErrors(envelope?.validationErrors)
      const first = Object.values(fieldErrors)[0]?.[0]
      throw new ApiError(first ?? envelope?.message ?? 'The request was not valid.', 400, fieldErrors)
    }
    if (response.status === 404) throw new ApiError(envelope?.message || 'Not found.', 404)
    console.error('Solasta API call failed', { path: url.pathname, status: response.status })
    throw new ApiError('The estimate service is not available right now. Please try again in a few minutes.', 502)
  }

  private async token(refresh: boolean): Promise<string> {
    const { IDENTITY_TOKEN_URL, MCP_CLIENT_ID, MCP_CLIENT_SECRET } = this.env
    const key = `${IDENTITY_TOKEN_URL}|${MCP_CLIENT_ID}`
    if (!refresh && cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now()) return cachedToken.value
    let response: Response
    try {
      response = await this.fetcher(IDENTITY_TOKEN_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials', client_id: MCP_CLIENT_ID!, client_secret: MCP_CLIENT_SECRET!, scope: 'public.estimate',
        }),
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      })
    } catch (error) {
      console.error('Identity Server unreachable', describeError(error))
      throw new ApiError('The estimate service is not available right now. Please try again in a few minutes.', 502)
    }
    if (!response.ok) {
      console.error('Identity Server refused the dealer-mcp client', { status: response.status })
      throw new ApiError('The estimate service is not available right now. Please try again in a few minutes.', 502)
    }
    let data: { access_token?: string; expires_in?: number } | undefined
    try { data = (await response.json()) as typeof data } catch { data = undefined }
    if (!data?.access_token) {
      console.error('Identity Server answered without a token', { status: response.status })
      throw new ApiError('The estimate service is not available right now. Please try again in a few minutes.', 502)
    }
    // Renew a minute early.
    cachedToken = { key, value: data.access_token, expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 300) - 60) * 1000 }
    return data.access_token
  }
}

const SLUG = /^[a-z0-9-]{2,40}$/

/** A dealer slug safe to put in a URL path. */
export function slug(dealer: string): string {
  const value = dealer.trim().toLowerCase()
  if (!SLUG.test(value)) throw new ApiError(`Unknown dealer "${dealer}".`, 404)
  return value
}

function normalizeErrors(errors: Envelope<unknown>['validationErrors']): Record<string, string[]> {
  if (!errors) return {}
  if (Array.isArray(errors)) {
    const result: Record<string, string[]> = {}
    for (const e of errors) if (e?.message) (result[e.field ?? 'request'] ??= []).push(e.message)
    return result
  }
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => Array.isArray(v)))
}

// Rough roofline feet from an address, with no KML: the US Census geocoder finds the address, and OpenStreetMap's
// building outlines (Overpass API) give the building's perimeter. A footprint can't tell eaves from walls, a garage
// from the house, or which sides the person wants lit, so estimates from it carry the dealer's footprint uncertainty
// (+/-25% by default) and always say "rough".

import { describeError } from './errors.js'

export interface GeocodedAddress {
  matchedAddress: string
  /** The street line of the matched address ("123 Main St"), when the match has one. */
  street?: string
  latitude: number
  longitude: number
  city?: string
  state?: string
  postalCode?: string
}

export interface Footprint {
  address: GeocodedAddress
  /** Perimeter of the building outline, in feet. */
  perimeterFeet: number
  /** Feet for the sides asked for (all sides, or the front only). */
  feet: number
  /** Where the outline came from, for the answer's wording. */
  source: 'OpenStreetMap'
  /** True when the address point fell inside the outline; false when the nearest outline was used. */
  containsAddress: boolean
}

export type Coverage = 'all' | 'front'

/**
 * Share of the perimeter counted for "front only". Most homes are lit on the street-facing roofline and its returns;
 * with no way to tell the front from the outline, a fixed share is used and the wide footprint range covers the rest.
 */
export const FRONT_SHARE = 0.3

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
/** Public Overpass servers, tried in order: the main one turns busy or unknown clients away at times. */
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
/**
 * OpenStreetMap's own editing API, used when every Overpass server fails (they are often down or busy). It returns
 * everything in a small box, so it is only asked for the ~100 m around one address.
 */
export const OSM_MAP_URL = 'https://api.openstreetmap.org/api/0.6/map.json'
/** Buildings within this distance of the address point are considered (like Overpass's around:40). */
const SEARCH_RADIUS_M = 40
/** Both public services ask clients to say who they are; anonymous Worker traffic is refused more often. */
export const USER_AGENT = 'solasta-dealer-mcp/1.0 (+https://mcp.mysolasta.com)'
const FEET_PER_METER = 3.280839895
const EARTH_RADIUS_M = 6371008.8

/** Buildings smaller or larger than this are not a home or a small business (sheds, malls). */
const MIN_PERIMETER_FEET = 60
const MAX_PERIMETER_FEET = 2000

export class FootprintError extends Error {}

export async function geocode(address: string, fetcher: typeof fetch = fetch): Promise<GeocodedAddress> {
  const url = new URL(CENSUS_URL)
  url.searchParams.set('address', address)
  url.searchParams.set('benchmark', 'Public_AR_Current')
  url.searchParams.set('format', 'json')
  let response: Response
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } })
  } catch (error) {
    console.error('Address lookup unreachable', describeError(error))
    throw new FootprintError('The address lookup is not available right now.')
  }
  if (!response.ok) {
    console.error('Address lookup failed', { status: response.status })
    throw new FootprintError('The address lookup is not available right now.')
  }
  const data = (await response.json()) as {
    result?: { addressMatches?: { matchedAddress?: string; coordinates?: { x?: number; y?: number }; addressComponents?: { city?: string; state?: string; zip?: string } }[] }
  }
  const match = data.result?.addressMatches?.[0]
  const lon = match?.coordinates?.x
  const lat = match?.coordinates?.y
  if (!match || typeof lat !== 'number' || typeof lon !== 'number')
    throw new FootprintError('That address was not found. Check the street, city and state, or give the ZIP code.')
  return {
    matchedAddress: match.matchedAddress ?? address,
    street: match.matchedAddress && match.matchedAddress.includes(',') ? titleCase(match.matchedAddress.split(',')[0]?.trim()) : undefined,
    latitude: lat,
    longitude: lon,
    city: titleCase(match.addressComponents?.city),
    state: match.addressComponents?.state?.toUpperCase(),
    postalCode: match.addressComponents?.zip,
  }
}

type Point = { lat: number; lon: number }

export async function buildingOutline(at: Point, fetcher: typeof fetch = fetch): Promise<{ outline: Point[]; containsAddress: boolean }> {
  const outlines = await findOutlines(at, fetcher)
  if (outlines.length === 0) throw new FootprintError('No building outline was found at that address.')
  const inside = outlines.find(o => contains(o, at))
  if (inside) return { outline: inside, containsAddress: true }
  const nearest = outlines
    .map(o => ({ o, d: Math.min(...o.map(p => distanceMeters(p, at))) }))
    .sort((a, b) => a.d - b.d)[0]!
  return { outline: nearest.o, containsAddress: false }
}

type OverpassResult = { elements?: { type?: string; geometry?: Point[] }[] }

/** Building outlines near a point: the first Overpass server that answers, else the OpenStreetMap API. */
async function findOutlines(at: Point, fetcher: typeof fetch): Promise<Point[][]> {
  const query = `[out:json][timeout:10];way(around:${SEARCH_RADIUS_M},${at.lat.toFixed(6)},${at.lon.toFixed(6)})["building"];out geom;`
  for (const endpoint of OVERPASS_URLS) {
    const data = await lookup<OverpassResult>(endpoint, fetcher, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(8000),
    })
    if (data && Array.isArray(data.elements)) return validOutlines((data.elements ?? []).map(e => e.geometry ?? []))
  }
  const osm = await osmMapOutlines(at, fetcher)
  if (osm) return osm
  throw new FootprintError('The building outline lookup is not available right now.')
}

type OsmMapResult = { elements?: { type?: string; id?: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }[] }

/** Building ways from the OpenStreetMap API's map call for a small box around the point; undefined when it fails. */
export async function osmMapOutlines(at: Point, fetcher: typeof fetch): Promise<Point[][] | undefined> {
  const dLat = 60 / 111_132
  const dLon = 60 / (111_320 * Math.cos(at.lat * Math.PI / 180))
  const url = new URL(OSM_MAP_URL)
  url.searchParams.set('bbox', [at.lon - dLon, at.lat - dLat, at.lon + dLon, at.lat + dLat].map(v => v.toFixed(6)).join(','))
  const data = await lookup<OsmMapResult>(url.toString(), fetcher, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  })
  if (!data || !Array.isArray(data.elements)) return undefined
  const nodes = new Map<number, Point>()
  for (const e of data.elements)
    if (e.type === 'node' && typeof e.id === 'number' && typeof e.lat === 'number' && typeof e.lon === 'number')
      nodes.set(e.id, { lat: e.lat, lon: e.lon })
  const ways = data.elements
    .filter(e => e.type === 'way' && e.tags?.building && Array.isArray(e.nodes))
    .map(e => e.nodes!.map(id => nodes.get(id)))
    .filter((g): g is Point[] => g.every(p => p !== undefined))
  return validOutlines(ways).filter(o => contains(o, at) || Math.min(...o.map(p => distanceMeters(p, at))) <= SEARCH_RADIUS_M)
}

function validOutlines(geometries: Point[][]): Point[][] {
  return geometries.filter(g => g.length >= 4 && g.every(p => typeof p?.lat === 'number' && typeof p?.lon === 'number'))
}

/** GETs or POSTs one map service and reads its JSON; logs and returns undefined on any failure. */
async function lookup<T>(endpoint: string, fetcher: typeof fetch, init: RequestInit): Promise<T | undefined> {
  const host = new URL(endpoint).hostname
  try {
    const response = await fetcher(endpoint, init)
    if (!response.ok) {
      console.error('Building outline lookup failed', { host, status: response.status })
      return undefined
    }
    return (await response.json()) as T
  } catch (error) {
    console.error('Building outline lookup unreachable', { host, ...describeError(error) })
    return undefined
  }
}

export async function footprintFeet(address: string, coverage: Coverage, fetcher: typeof fetch = fetch): Promise<Footprint> {
  const geocoded = await geocode(address, fetcher)
  const { outline, containsAddress } = await buildingOutline({ lat: geocoded.latitude, lon: geocoded.longitude }, fetcher)
  const perimeterFeet = round1(perimeterMeters(outline) * FEET_PER_METER)
  if (perimeterFeet < MIN_PERIMETER_FEET || perimeterFeet > MAX_PERIMETER_FEET)
    throw new FootprintError('The building outline at that address does not look like a single home or small business.')
  const feet = round1(coverage === 'front' ? perimeterFeet * FRONT_SHARE : perimeterFeet)
  return { address: geocoded, perimeterFeet, feet, source: 'OpenStreetMap', containsAddress }
}

/** Perimeter of a closed outline (first point repeated last, or not). */
export function perimeterMeters(outline: Point[]): number {
  let total = 0
  for (let i = 1; i < outline.length; i++) total += distanceMeters(outline[i - 1]!, outline[i]!)
  const first = outline[0]!, last = outline[outline.length - 1]!
  if (first.lat !== last.lat || first.lon !== last.lon) total += distanceMeters(last, first)
  return total
}

export function distanceMeters(a: Point, b: Point): number {
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLon = (b.lon - a.lon) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Ray casting; good enough at house scale. */
export function contains(outline: Point[], p: Point): boolean {
  let inside = false
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i]!, b = outline[j]!
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside
  }
  return inside
}

const round1 = (n: number) => Math.round(n * 10) / 10

function titleCase(value?: string): string | undefined {
  if (!value) return undefined
  return value.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

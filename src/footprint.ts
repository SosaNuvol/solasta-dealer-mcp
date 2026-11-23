// Rough roofline feet from an address, with no KML: the US Census geocoder finds the address, and OpenStreetMap's
// building outlines (Overpass API) give the building's perimeter. A footprint can't tell eaves from walls, a garage
// from the house, or which sides the person wants lit, so estimates from it carry the dealer's footprint uncertainty
// (+/-25% by default) and always say "rough".

export interface GeocodedAddress {
  matchedAddress: string
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
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
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
  const response = await fetcher(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } })
  if (!response.ok) throw new FootprintError('The address lookup is not available right now.')
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
    latitude: lat,
    longitude: lon,
    city: titleCase(match.addressComponents?.city),
    state: match.addressComponents?.state?.toUpperCase(),
    postalCode: match.addressComponents?.zip,
  }
}

type Point = { lat: number; lon: number }

export async function buildingOutline(at: Point, fetcher: typeof fetch = fetch): Promise<{ outline: Point[]; containsAddress: boolean }> {
  const query = `[out:json][timeout:10];way(around:40,${at.lat.toFixed(6)},${at.lon.toFixed(6)})["building"];out geom;`
  const response = await fetcher(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new FootprintError('The building outline lookup is not available right now.')
  const data = (await response.json()) as { elements?: { type?: string; geometry?: Point[] }[] }
  const outlines = (data.elements ?? [])
    .map(e => e.geometry ?? [])
    .filter(g => g.length >= 4 && g.every(p => typeof p.lat === 'number' && typeof p.lon === 'number'))
  if (outlines.length === 0) throw new FootprintError('No building outline was found at that address.')
  const inside = outlines.find(o => contains(o, at))
  if (inside) return { outline: inside, containsAddress: true }
  const nearest = outlines
    .map(o => ({ o, d: Math.min(...o.map(p => distanceMeters(p, at))) }))
    .sort((a, b) => a.d - b.d)[0]!
  return { outline: nearest.o, containsAddress: false }
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

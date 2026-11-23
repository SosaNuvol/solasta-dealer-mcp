import { describe, expect, it } from 'vitest'
import { contains, distanceMeters, footprintFeet, FootprintError, osmMapOutlines, OVERPASS_URLS, perimeterMeters, USER_AGENT } from '../src/footprint.js'
import { fakeFetch } from './helpers.js'

// A 20 m x 10 m rectangle near Lehi, UT.
const lat0 = 40.39, lon0 = -111.85
const mPerDegLat = 111_132
const mPerDegLon = 111_320 * Math.cos(lat0 * Math.PI / 180)
const rect = [
  { lat: lat0, lon: lon0 },
  { lat: lat0, lon: lon0 + 20 / mPerDegLon },
  { lat: lat0 + 10 / mPerDegLat, lon: lon0 + 20 / mPerDegLon },
  { lat: lat0 + 10 / mPerDegLat, lon: lon0 },
  { lat: lat0, lon: lon0 },
]
const center = { lat: lat0 + 5 / mPerDegLat, lon: lon0 + 10 / mPerDegLon }

const census = (url: URL) => url.hostname === 'geocoding.geo.census.gov'
  ? Response.json({ result: { addressMatches: [{ matchedAddress: '123 MAIN ST, LEHI, UT, 84043', coordinates: { x: center.lon, y: center.lat }, addressComponents: { city: 'LEHI', state: 'UT', zip: '84043' } }] } })
  : undefined
const overpass = (geometry = rect) => (url: URL) => url.hostname === 'overpass-api.de'
  ? Response.json({ elements: [{ type: 'way', geometry }] })
  : undefined

describe('footprint geometry', () => {
  it('measures a rectangle', () => expect(perimeterMeters(rect)).toBeCloseTo(60, 0))
  it('closes an open outline', () => expect(perimeterMeters(rect.slice(0, 4))).toBeCloseTo(60, 0))
  it('finds a point inside', () => expect(contains(rect, center)).toBe(true))
  it('finds a point outside', () => expect(contains(rect, { lat: lat0 - 0.001, lon: lon0 })).toBe(false))
  it('measures distance', () => expect(distanceMeters(rect[0]!, rect[1]!)).toBeCloseTo(20, 0))
})

describe('footprintFeet', () => {
  it('turns the outline into feet', async () => {
    const f = await footprintFeet('123 Main St, Lehi, UT', 'all', fakeFetch(census, overpass()).fetch)
    expect(f.address).toMatchObject({ street: '123 Main St', city: 'Lehi', state: 'UT', postalCode: '84043' })
    expect(f.perimeterFeet).toBeCloseTo(196.9, 0)
    expect(f.feet).toBe(f.perimeterFeet)
    expect(f.containsAddress).toBe(true)
    expect(f.address).toMatchObject({ city: 'Lehi', state: 'UT', postalCode: '84043' })
  })

  it('counts a share of the perimeter for the front only', async () => {
    const f = await footprintFeet('123 Main St, Lehi, UT', 'front', fakeFetch(census, overpass()).fetch)
    expect(f.feet).toBeCloseTo(f.perimeterFeet * 0.3, 0)
  })

  it('says when the address is not found', async () => {
    const none = (url: URL) => url.hostname === 'geocoding.geo.census.gov' ? Response.json({ result: { addressMatches: [] } }) : undefined
    await expect(footprintFeet('nowhere', 'all', fakeFetch(none).fetch)).rejects.toBeInstanceOf(FootprintError)
  })

  it('refuses an outline that is not a home', async () => {
    const tiny = rect.map(p => ({ lat: lat0 + (p.lat - lat0) / 10, lon: lon0 + (p.lon - lon0) / 10 }))
    const point = { lat: lat0 + 0.5 / mPerDegLat, lon: lon0 + 1 / mPerDegLon }
    const near = (url: URL) => url.hostname === 'geocoding.geo.census.gov'
      ? Response.json({ result: { addressMatches: [{ coordinates: { x: point.lon, y: point.lat }, addressComponents: {} }] } })
      : undefined
    await expect(footprintFeet('shed', 'all', fakeFetch(near, overpass(tiny)).fetch)).rejects.toThrow(/does not look like/)
  })

  it('says who it is to the address and outline services', async () => {
    const fake = fakeFetch(census, overpass())
    const seen: Record<string, string | null> = {}
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen[new URL(input.toString()).hostname] = new Headers(init?.headers).get('User-Agent')
      return fake.fetch(input, init)
    }) as typeof fetch
    await footprintFeet('123 Main St, Lehi, UT', 'all', wrapped)
    expect(seen['geocoding.geo.census.gov']).toBe(USER_AGENT)
    expect(seen['overpass-api.de']).toBe(USER_AGENT)
  })

  it('tries the next Overpass server when one refuses', async () => {
    const second = new URL(OVERPASS_URLS[1]!).hostname
    const refuse = (url: URL) => url.hostname === 'overpass-api.de' ? new Response('down', { status: 521 }) : undefined
    const answer = (url: URL) => url.hostname === second ? Response.json({ elements: [{ type: 'way', geometry: rect }] }) : undefined
    const f = await footprintFeet('123 Main St, Lehi, UT', 'all', fakeFetch(census, refuse, answer).fetch)
    expect(f.perimeterFeet).toBeCloseTo(196.9, 0)
  })

  it('falls back to the OpenStreetMap API when every Overpass server fails', async () => {
    const overpassHosts = OVERPASS_URLS.map(u => new URL(u).hostname)
    const ids = rect.slice(0, 4).map((_, i) => i + 1)
    const osm = (url: URL) => {
      if (overpassHosts.includes(url.hostname)) return new Response('timeout', { status: 504 })
      if (url.hostname !== 'api.openstreetmap.org') return undefined
      expect(url.searchParams.get('bbox')).toMatch(/^-111\.85\d+,40\.38\d+,-111\.84\d+,40\.39\d+$/)
      return Response.json({ elements: [
        ...rect.slice(0, 4).map((p, i) => ({ type: 'node', id: ids[i], lat: p.lat, lon: p.lon })),
        { type: 'node', id: 99, lat: lat0 + 0.01, lon: lon0 },
        { type: 'way', id: 1, nodes: [...ids, ids[0]], tags: { building: 'house' } },
        { type: 'way', id: 2, nodes: [ids[0], 99, ids[1]], tags: { highway: 'residential' } },
      ] })
    }
    const f = await footprintFeet('123 Main St, Lehi, UT', 'all', fakeFetch(census, osm).fetch)
    expect(f.perimeterFeet).toBeCloseTo(196.9, 0)
    expect(f.containsAddress).toBe(true)
  })

  it('ignores OpenStreetMap buildings farther than 40 m', async () => {
    const far = rect.map(p => ({ lat: p.lat + 0.002, lon: p.lon }))
    expect(await osmMapOutlines(center, fakeFetch((url: URL) => url.hostname === 'api.openstreetmap.org'
      ? Response.json({ elements: [
        ...far.slice(0, 4).map((p, i) => ({ type: 'node', id: i + 1, lat: p.lat, lon: p.lon })),
        { type: 'way', id: 1, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes' } },
      ] })
      : undefined).fetch)).toEqual([])
  })

  it('says the outline lookup is down when every map service fails', async () => {
    const refuse = (url: URL) => url.hostname !== 'geocoding.geo.census.gov' ? new Response('busy', { status: 504 }) : undefined
    await expect(footprintFeet('123 Main St, Lehi, UT', 'all', fakeFetch(census, refuse).fetch))
      .rejects.toThrow(/building outline lookup is not available/)
  })

  it('turns an unreachable address lookup into a plain message', async () => {
    const down = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    await expect(footprintFeet('123 Main St, Lehi, UT', 'all', down)).rejects.toThrow(/address lookup is not available/)
  })
})

import { describe, expect, it } from 'vitest'
import { contains, distanceMeters, footprintFeet, FootprintError, perimeterMeters } from '../src/footprint.js'
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
})

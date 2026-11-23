import { describe, expect, it } from 'vitest'
import type { Estimate } from '../src/api.js'
import { callTool, fakeFetch, payload, rpc, toolText } from './helpers.js'

const solasta = { slug: 'solasta', displayName: 'Solasta Lighting', websiteUrl: 'https://mysolasta.com', phone: '801-555-2368' }

const dealers = (url: URL) => {
  if (url.pathname !== '/api/public/dealers') return undefined
  const zip = url.searchParams.get('zip')
  return zip?.startsWith('84')
    ? payload({ postalCode: zip, covered: true, dealers: [solasta] })
    : payload({ postalCode: zip, covered: false, dealers: [] })
}

const estimate: Estimate = {
  estimateId: 'MAPE:1:abc', source: 'Kml', feet: 180, uncertainty: 0.1, lowFeet: 162, highFeet: 198,
  productSku: 'P001', productName: 'Permanent rail', variantName: 'Black', promotion: null, taxRate: 0.0725,
  lowTotal: 4150, highTotal: 5100, monthlyFrom: { termMonths: 60, apr: 0.0799, amount: 84, label: 'Enhancify 60' },
  validUntil: '2026-12-21T00:00:00Z', warnings: [], disclaimer: 'This is an estimate, not a quote.',
}

const estimates = (url: URL) => url.pathname === '/api/public/solasta/estimates' ? payload(estimate) : undefined

describe('MCP endpoint', () => {
  it('lists the tools', async () => {
    const result = await rpc('tools/list', {}, fakeFetch().fetch)
    const names = result.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(['check_kml', 'estimate_from_address', 'estimate_from_kml', 'find_dealer', 'get_dealer_info',
      'kml_instructions', 'list_products', 'request_quote'])
  })

  it('takes no dealer argument on a dealer endpoint', async () => {
    const result = await rpc('tools/list', {}, fakeFetch().fetch, 'solasta')
    const estimateTool = result.tools.find((t: { name: string }) => t.name === 'estimate_from_kml')
    expect(Object.keys(estimateTool.inputSchema.properties)).not.toContain('dealer')
  })

  it('finds the dealer for a ZIP', async () => {
    const f = fakeFetch(dealers)
    const text = toolText(await callTool('find_dealer', { postalCode: '84043' }, f.fetch))
    expect(text).toContain('Solasta Lighting (dealer: "solasta")')
    expect(f.calls.find(c => c.url.pathname === '/api/public/dealers')).toBeDefined()
  })

  it('says when no dealer serves a ZIP', async () => {
    const text = toolText(await callTool('find_dealer', { postalCode: '10001' }, fakeFetch(dealers).fetch))
    expect(text).toContain('No Solasta dealer serves ZIP 10001 yet')
  })

  it('sends the KML estimate to the dealer for the ZIP and shows the range', async () => {
    const f = fakeFetch(dealers, estimates)
    const kml = '<kml>' + 'x'.repeat(100) + '</kml>'
    const result = await callTool('estimate_from_kml', { kml, postalCode: '84043', city: 'Lehi', state: 'ut' }, f.fetch)
    const text = toolText(result)
    expect(result.isError).toBeFalsy()
    expect(text).toContain('Estimated price: $4,150 to $5,100')
    expect(text).toContain('in Black')
    expect(text).toContain('Financing from about $84/month')
    const sent = f.calls.find(c => c.url.pathname === '/api/public/solasta/estimates')!
    expect(sent.body).toMatchObject({ source: 'Kml', kml, postalCode: '84043', state: 'UT' })
  })

  it('passes on the API\'s validation message', async () => {
    const refuse = (url: URL) => url.pathname === '/api/public/solasta/estimates'
      ? Response.json({ payload: null, message: 'Validation failed', validationErrors: { productSku: ['No public rail P999.'] } }, { status: 400 })
      : undefined
    const result = await callTool('estimate_from_kml', { kml: 'k'.repeat(60), postalCode: '84043', productSku: 'P999' }, fakeFetch(dealers, refuse).fetch)
    expect(result.isError).toBe(true)
    expect(toolText(result)).toBe('No public rail P999.')
  })

  it('refuses a fake email before calling the API', async () => {
    const f = fakeFetch(dealers)
    const result = await callTool('request_quote', {
      firstName: 'Jane', lastName: 'Doe', email: 'test@example.com', address1: '123 Main St', city: 'Lehi', state: 'UT', postalCode: '84043',
    }, f.fetch)
    expect(result.isError).toBe(true)
    expect(f.calls.some(c => c.url.pathname.includes('quote-requests'))).toBe(false)
  })

  it('sends a quote request with the SMS consent wording', async () => {
    const quotes = (url: URL) => url.pathname === '/api/public/solasta/quote-requests'
      ? payload({ reference: 'L-1042', isNewLead: true, measurementAttached: false, message: 'Thanks, Jane! Solasta Lighting will contact you within one business day.' })
      : undefined
    const f = fakeFetch(dealers, quotes)
    const result = await callTool('request_quote', {
      firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@gmail.com', phone: '(801) 762-9988', address1: '123 Main St',
      city: 'Lehi', state: 'UT', postalCode: '84043', smsConsent: true, estimateId: 'MAPE:1:abc',
    }, f.fetch)
    expect(toolText(result)).toContain('Reference: L-1042')
    const sent = f.calls.find(c => c.url.pathname === '/api/public/solasta/quote-requests')!
    expect(sent.body).toMatchObject({ smsConsent: true, outOfArea: false, estimateId: 'MAPE:1:abc' })
    expect((sent.body as { smsConsentText: string }).smsConsentText).toContain('Reply STOP')
  })

  it('keeps an out-of-area request for the default dealer, marked out of area', async () => {
    const quotes = (url: URL) => url.pathname === '/api/public/solasta/quote-requests'
      ? payload({ reference: 'L-1043', isNewLead: true, measurementAttached: false, message: 'Thanks!' })
      : undefined
    const f = fakeFetch(dealers, quotes)
    const result = await callTool('request_quote', {
      firstName: 'Sam', lastName: 'Lee', email: 'sam.lee@outlook.com', address1: '1 Broadway', city: 'New York', state: 'NY', postalCode: '10001',
    }, f.fetch)
    expect(toolText(result)).toContain('outside the areas our dealers list')
    expect(f.calls.find(c => c.url.pathname === '/api/public/solasta/quote-requests')!.body).toMatchObject({ outOfArea: true })
  })

  it('asks for a phone number when the person wants texts', async () => {
    const result = await callTool('request_quote', {
      firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@gmail.com', address1: '123 Main St', city: 'Lehi', state: 'UT',
      postalCode: '84043', smsConsent: true,
    }, fakeFetch(dealers).fetch)
    expect(toolText(result)).toContain('phone number is needed')
  })

  it('serves the KML guide as a tool and a resource', async () => {
    expect(toolText(await callTool('kml_instructions', { device: 'phone' }, fakeFetch().fetch))).toContain('Google Earth app')
    const resource = await rpc('resources/read', { uri: 'solasta://guides/roofline-kml' }, fakeFetch().fetch)
    expect(resource.contents[0].text).toContain('Front 005 + Right 001')
  })

  it('reports an unconfigured API without crashing', async () => {
    const { handleMcp } = await import('../src/index.js')
    const request = new Request('https://mcp.mysolasta.com/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_dealer', arguments: { postalCode: '84043' } } }),
    })
    const response = await handleMcp(request, {}, undefined, 'x', fakeFetch().fetch)
    const data = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } }
    expect(data.result.isError).toBe(true)
    expect(data.result.content[0]!.text).toContain('not configured')
  })
})

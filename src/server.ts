import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { ApiError, type DealerSummary, type Estimate, type EstimateRequest, type SolastaApi } from './api.js'
import { emailProblem, phoneProblem, US_STATE, US_ZIP } from './contact.js'
import { type Coverage, footprintFeet, FootprintError, FRONT_SHARE } from './footprint.js'
import { KML_GUIDE_URI, kmlGuide } from './kmlGuide.js'

export const SERVER_NAME = 'solasta-dealer-mcp'
export const SERVER_VERSION = '0.1.0'

/** Largest KML text accepted from an AI client (a home has a few dozen pins; this leaves lots of room). */
export const MAX_KML_CHARS = 500_000

export interface ServerOptions {
  api: SolastaApi
  /** Dealer slug from the URL (/d/{dealer}/mcp). Without it, tools find the dealer from the ZIP code. */
  dealer?: string
  /** Dealer that keeps quote requests from addresses no dealer serves. */
  defaultDealer: string
  /** Answers false when this caller sent too many quote requests. */
  allowQuoteRequest: () => Promise<boolean>
  fetcher?: typeof fetch
}

const INSTRUCTIONS = `Solasta Lighting and its dealers design and install permanent, app-controlled LED lights on the rooflines of homes and businesses.
Use these tools to help a person get a price range and ask the dealer for a quote:
1. Find the dealer for their ZIP code (find_dealer), unless this server is already for one dealer.
2. Give a quick rough range from their address (estimate_from_address), and offer a tighter one from a roofline KML (kml_instructions, check_kml, estimate_from_kml).
3. When they want a real quote, collect their name, email, phone and address and call request_quote.
Every price here is an estimate, not a quote. Always show the range and say the dealer confirms the price after checking the roofline.
Never invent prices, products or colors: use list_products and the estimate tools.`

const SMS_CONSENT_TEXT = (dealer: string) =>
  `I agree to receive text messages from ${dealer} about my lighting quote. Message and data rates may apply. Reply STOP to opt out.`

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] })
const failure = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }], isError: true })

const dealerArg = z.string().trim().min(2).max(40).optional()
  .describe('Dealer slug from find_dealer. Leave out to use the dealer for the postal code.')
const zipArg = z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'A 5-digit US ZIP code')
const kmlArg = z.string().min(50).max(MAX_KML_CHARS).describe('The full text of the KML file (Google Earth export).')
const skuArg = z.string().trim().min(1).max(50).optional().describe('Rail product SKU from list_products. Leave out for the dealer\'s standard rail.')
const variantArg = z.number().int().positive().optional().describe('Color (variant) stockItemId from list_products, if the person picked one.')

export function buildServer(options: ServerOptions): McpServer {
  const { api, dealer: fixedDealer, defaultDealer } = options
  const fetcher = options.fetcher ?? fetch
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Solasta Lighting estimates' },
    { instructions: INSTRUCTIONS },
  )

  /** The dealer for a tool call: the URL's, the one asked for, or the first that serves the ZIP. */
  async function resolveDealer(asked: string | undefined, postalCode: string | undefined): Promise<{ dealer?: DealerSummary | { slug: string; displayName: string }; covered: boolean }> {
    if (fixedDealer) {
      if (!postalCode) return { dealer: { slug: fixedDealer, displayName: fixedDealer }, covered: true }
      const lookup = await api.findDealers(postalCode.slice(0, 5))
      const own = lookup.dealers.find(d => d.slug === fixedDealer)
      return { dealer: own ?? { slug: fixedDealer, displayName: fixedDealer }, covered: !!own }
    }
    if (asked) return { dealer: { slug: asked.toLowerCase(), displayName: asked }, covered: true }
    if (!postalCode) return { covered: false }
    const lookup = await api.findDealers(postalCode.slice(0, 5))
    return { dealer: lookup.dealers[0], covered: lookup.covered && lookup.dealers.length > 0 }
  }

  const guard = async (work: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try { return await work() } catch (error) {
      if (error instanceof ApiError || error instanceof FootprintError) return failure(error.message)
      console.error('Tool failed', { error: error instanceof Error ? error.name : 'unknown' })
      return failure('Something went wrong on our side. Please try again in a few minutes.')
    }
  }

  const notServed = (postalCode: string) =>
    text(`No Solasta dealer serves ZIP ${postalCode} yet. The person can still leave their details with request_quote, and Solasta Lighting will reach out if it can help or when a dealer opens nearby.`)

  // ---- find_dealer -------------------------------------------------------------------------------------------
  server.registerTool('find_dealer', {
    title: 'Find the dealer for a ZIP code',
    description: 'Lists the Solasta dealers that install in a US ZIP code, with their website and phone.',
    inputSchema: { postalCode: zipArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ postalCode }) => guard(async () => {
    const lookup = await api.findDealers(postalCode.slice(0, 5))
    if (!lookup.covered || lookup.dealers.length === 0) return notServed(postalCode)
    const lines = lookup.dealers.map(d =>
      `- ${d.displayName} (dealer: "${d.slug}")${d.websiteUrl ? `, ${d.websiteUrl}` : ''}${d.phone ? `, ${d.phone}` : ''}${d.description ? `\n  ${d.description}` : ''}`)
    return text(`Dealers that serve ZIP ${lookup.postalCode}:\n${lines.join('\n')}`)
  }))

  // ---- get_dealer_info ---------------------------------------------------------------------------------------
  server.registerTool('get_dealer_info', {
    title: 'About the dealer',
    description: 'The dealer\'s contact details, where it installs, and how its estimates work.',
    inputSchema: fixedDealer ? {} : { dealer: z.string().trim().min(2).max(40).describe('Dealer slug from find_dealer.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args: { dealer?: string }) => guard(async () => {
    const slug = fixedDealer ?? args.dealer!
    const p = await api.profile(slug)
    const areas = p.serviceAreas.length > 0 ? p.serviceAreas.map(a => (a.length === 3 ? `${a}xx` : a)).join(', ') : 'not listed'
    return text([
      `${p.displayName}${p.description ? `: ${p.description}` : ''}`,
      p.websiteUrl ? `Website: ${p.websiteUrl}` : '',
      p.phone ? `Phone: ${p.phone}` : '',
      p.email ? `Email: ${p.email}` : '',
      `Installs in ZIP codes: ${areas}`,
      `Estimates: from an address alone they can be off by about ${Math.round(p.footprintUncertainty * 100)}%; from a roofline KML, about ${Math.round(p.kmlUncertainty * 100)}%. An estimate is good for ${p.estimateValidityDays} days. The dealer confirms the price after checking the roofline.`,
    ].filter(Boolean).join('\n'))
  }))

  // ---- list_products ------------------------------------------------------------------------------------------
  server.registerTool('list_products', {
    title: 'Products and colors',
    description: 'The dealer\'s lighting products with list prices: rails priced per foot (with their colors), fixed costs and add-ons, and current public promotions.',
    inputSchema: fixedDealer ? {} : { dealer: dealerArg, postalCode: zipArg.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args: { dealer?: string; postalCode?: string }) => guard(async () => {
    const { dealer, covered } = await resolveDealer(args.dealer, args.postalCode)
    if (!dealer) return args.postalCode && !covered ? notServed(args.postalCode) : failure('Give the ZIP code or the dealer so I know whose prices to show.')
    const c = await api.catalog(dealer.slug)
    const item = (i: { sku: string; name: string; unit: string; price: number; variants: { stockItemId: number; name: string; priceAdder: number }[] }) => {
      const colors = i.variants.length === 0 ? '' : `\n  Colors: ${i.variants.map(v => `${v.name} (id ${v.stockItemId}${v.priceAdder ? `, +${money(v.priceAdder)}` : ''})`).join(', ')}`
      return `- ${i.name} [${i.sku}]: ${money(i.price)} per ${i.unit === 'ft' ? 'foot' : 'item'}${colors}`
    }
    const sections = [
      c.rails.length ? `Rails (priced per foot of roofline):\n${c.rails.map(item).join('\n')}` : '',
      c.addOns.length ? `Add-ons:\n${c.addOns.map(item).join('\n')}` : '',
      c.fixedItems.length ? `Fixed costs that apply to some homes (gables, dormers, extra height):\n${c.fixedItems.map(item).join('\n')}` : '',
      c.promotions.length ? `Current promotions:\n${c.promotions.map(p => `- ${p.name}: ${money(p.amountPerFoot)} off per foot${p.endDate ? ` until ${p.endDate.slice(0, 10)}` : ''}`).join('\n')}` : '',
    ].filter(Boolean)
    return text(`${dealer.displayName} list prices (before tax):\n\n${sections.join('\n\n')}`)
  }))

  // ---- estimate_from_address ---------------------------------------------------------------------------------
  server.registerTool('estimate_from_address', {
    title: 'Rough estimate from an address',
    description: `A quick, rough price range from the address alone: the building's outline from map data gives its perimeter. Use coverage "front" when the person only wants the front of the house (counted as ${Math.round(FRONT_SHARE * 100)}% of the perimeter). The range is wide; offer estimate_from_kml for a tighter one.`,
    inputSchema: {
      address: z.string().trim().min(8).max(200).describe('Street address with city and state, or ZIP: "123 Main St, Lehi, UT 84043".'),
      coverage: z.enum(['all', 'front']).default('all').describe('"all" sides of the roofline, or the "front" only.'),
      productSku: skuArg,
      variantStockItemId: variantArg,
      ...(fixedDealer ? {} : { dealer: dealerArg }),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, (args: { address: string; coverage: Coverage; productSku?: string; variantStockItemId?: number; dealer?: string }) => guard(async () => {
    const footprint = await footprintFeet(args.address, args.coverage, fetcher)
    const { address } = footprint
    const { dealer, covered } = await resolveDealer(args.dealer, address.postalCode)
    if (!dealer) return notServed(address.postalCode ?? 'for that address')
    const estimate = await api.estimate(dealer.slug, {
      source: 'Footprint', feet: footprint.feet, productSku: args.productSku, variantStockItemId: args.variantStockItemId,
      city: address.city, state: address.state, postalCode: address.postalCode,
    })
    const notes = [
      `Address found: ${address.matchedAddress}.`,
      `Building outline from ${footprint.source}${footprint.containsAddress ? '' : ' (the nearest building to the address point; check it is the right one)'}: about ${Math.round(footprint.perimeterFeet)} ft around${args.coverage === 'front' ? `, about ${Math.round(footprint.feet)} ft counted for the front` : ''}.`,
      covered ? '' : `${dealer.displayName} does not list ZIP ${address.postalCode} in its service area, so check with them before relying on this.`,
    ]
    return text(describeEstimate(dealer.displayName, estimate, notes.filter(Boolean)))
  }))

  // ---- kml_instructions --------------------------------------------------------------------------------------
  server.registerTool('kml_instructions', {
    title: 'How to map a roofline',
    description: 'Step-by-step instructions for dropping roofline pins in Google Earth and exporting them as a KML file, named so the dealer can measure them.',
    inputSchema: { device: z.enum(['desktop', 'phone']).optional().describe('What the person will use, if known.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ device }) => Promise.resolve(text(kmlGuide(device))))

  server.registerResource('roofline-kml-guide', KML_GUIDE_URI, {
    title: 'How to map a roofline in Google Earth', mimeType: 'text/markdown',
    description: 'Pin naming rules and Google Earth steps for a roofline KML.',
  }, uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: kmlGuide(undefined) }] }))

  // ---- check_kml ----------------------------------------------------------------------------------------------
  server.registerTool('check_kml', {
    title: 'Check a roofline KML',
    description: 'Reads a roofline KML the way the installer\'s tools do: the pins, the lit runs and their feet by side, and plain-language problems to fix. Nothing is saved.',
    inputSchema: { kml: kmlArg, ...(fixedDealer ? {} : { dealer: dealerArg }) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args: { kml: string; dealer?: string }) => guard(async () => {
    const check = await api.checkKml(fixedDealer ?? args.dealer ?? defaultDealer, args.kml)
    const locations = check.locations.map(l => `- ${l.location}: ${l.feet.toFixed(1)} ft`).join('\n')
    const warnings = check.warnings.length ? `\nThings to fix or check:\n${check.warnings.slice(0, 15).map(w => `- ${w}`).join('\n')}${check.warnings.length > 15 ? `\n- ...and ${check.warnings.length - 15} more` : ''}` : '\nNo problems found.'
    return text([
      `${check.documentName ? `"${check.documentName}": ` : ''}${check.pinCount} pins, ${check.segmentCount} segments.`,
      check.railFeet > 0 ? `Lit roofline by side (before the installer's 10% allowance):\n${locations}\nTotal: ${check.railFeet.toFixed(1)} ft` : 'No lit stretch was found yet: mark where each run starts (LEC) and ends (REC).',
      warnings,
      check.isUsable ? 'This file can be used for an estimate (estimate_from_kml).' : 'Fix the problems above before asking for an estimate from this file.',
    ].join('\n'))
  }))

  // ---- estimate_from_kml --------------------------------------------------------------------------------------
  server.registerTool('estimate_from_kml', {
    title: 'Estimate from a roofline KML',
    description: 'A tighter price range from the person\'s roofline KML (check it with check_kml first). Needs the ZIP code for the right dealer and sales tax.',
    inputSchema: {
      kml: kmlArg,
      postalCode: zipArg,
      city: z.string().trim().min(2).max(100).optional(),
      state: z.string().trim().toUpperCase().regex(US_STATE, 'Two-letter state').optional(),
      productSku: skuArg,
      variantStockItemId: variantArg,
      addOns: z.array(z.object({ sku: z.string().trim().min(1).max(50), quantity: z.number().int().min(1).max(20) })).max(10).optional()
        .describe('Add-ons from list_products the person wants, with quantities.'),
      ...(fixedDealer ? {} : { dealer: dealerArg }),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args: { kml: string; postalCode: string; city?: string; state?: string; productSku?: string; variantStockItemId?: number; addOns?: { sku: string; quantity: number }[]; dealer?: string }) => guard(async () => {
    const { dealer, covered } = await resolveDealer(args.dealer, args.postalCode)
    if (!dealer) return notServed(args.postalCode)
    const request: EstimateRequest = {
      source: 'Kml', kml: args.kml, productSku: args.productSku, variantStockItemId: args.variantStockItemId, addOns: args.addOns,
      city: args.city, state: args.state, postalCode: args.postalCode,
    }
    const estimate = await api.estimate(dealer.slug, request)
    const notes = covered ? [] : [`${dealer.displayName} does not list ZIP ${args.postalCode} in its service area, so check with them before relying on this.`]
    return text(describeEstimate(dealer.displayName, estimate, notes))
  }))

  // ---- request_quote ------------------------------------------------------------------------------------------
  server.registerTool('request_quote', {
    title: 'Ask the dealer for a quote',
    description: 'Sends the person\'s details to the dealer, who will contact them to confirm the roofline and give a firm quote. Only call it after the person has asked for a quote and confirmed their details. Set smsConsent to true only if the person explicitly agreed to receive text messages.',
    inputSchema: {
      firstName: z.string().trim().min(1).max(50),
      lastName: z.string().trim().min(1).max(50),
      email: z.string().trim().max(254),
      phone: z.string().trim().max(30).optional(),
      address1: z.string().trim().min(3).max(200).describe('Street address of the building to light.'),
      city: z.string().trim().min(2).max(100),
      state: z.string().trim().toUpperCase().regex(US_STATE, 'Two-letter state'),
      postalCode: zipArg,
      projectType: z.enum(['Residential', 'Business']).default('Residential'),
      businessName: z.string().trim().max(100).optional(),
      language: z.enum(['en', 'es']).default('en'),
      smsConsent: z.boolean().default(false).describe('True only if the person said yes to text messages about their quote.'),
      estimateId: z.string().trim().max(100).optional().describe('estimateId from an estimate tool, so the dealer sees what the person was shown.'),
      kml: kmlArg.optional().describe('The roofline KML, if the person made one. The dealer gets it as a draft measurement.'),
      notes: z.string().trim().max(1000).optional().describe('Anything else the person wants the dealer to know (timeline, colors, questions).'),
      referralCode: z.string().trim().max(50).optional().describe('A referral code, if the person has one.'),
      ...(fixedDealer ? {} : { dealer: dealerArg }),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args: {
    firstName: string; lastName: string; email: string; phone?: string; address1: string; city: string; state: string; postalCode: string
    projectType: 'Residential' | 'Business'; businessName?: string; language: 'en' | 'es'; smsConsent: boolean; estimateId?: string
    kml?: string; notes?: string; referralCode?: string; dealer?: string
  }) => guard(async () => {
    const emailIssue = emailProblem(args.email)
    if (emailIssue) return failure(emailIssue)
    if (args.phone && phoneProblem(args.phone)) return failure(phoneProblem(args.phone)!)
    if (args.smsConsent && !args.phone) return failure('A phone number is needed for text messages.')
    if (!US_ZIP.test(args.postalCode)) return failure('Please give a 5-digit ZIP code.')
    if (!(await options.allowQuoteRequest())) return failure('Too many quote requests from here. Please wait a minute and try again.')

    const { dealer, covered } = await resolveDealer(args.dealer, args.postalCode)
    const target = dealer && covered ? dealer : { slug: fixedDealer ?? defaultDealer, displayName: dealer?.displayName ?? 'Solasta Lighting' }
    const outOfArea = !dealer || !covered
    const result = await api.requestQuote(target.slug, {
      firstName: args.firstName, lastName: args.lastName, email: args.email.trim(), phone: args.phone,
      businessName: args.businessName, address1: args.address1, city: args.city, state: args.state, postalCode: args.postalCode,
      projectType: args.projectType, language: args.language,
      smsConsent: args.smsConsent, smsConsentText: args.smsConsent ? SMS_CONSENT_TEXT(target.displayName) : undefined,
      estimateId: args.estimateId, kml: args.kml, notes: args.notes, referralCode: args.referralCode, outOfArea,
    })
    return text([
      result.message,
      `Reference: ${result.reference}.`,
      result.measurementAttached ? 'The roofline KML was attached, so the dealer can review it before calling.' : '',
      outOfArea ? 'This address is outside the areas our dealers list today, so Solasta Lighting will reach out if it can help.' : '',
    ].filter(Boolean).join('\n'))
  }))

  // ---- prompt ------------------------------------------------------------------------------------------------
  server.registerPrompt('plan_my_lights', {
    title: 'Plan my lights',
    description: 'Walks through getting a permanent lighting estimate and asking for a quote.',
    argsSchema: { address: z.string().optional().describe('The address of the home or business, if known.') },
  }, ({ address }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `I'm interested in permanent roofline lighting${address ? ` for ${address}` : ''}. Help me get a price range and, if I like it, ask for a quote. `
          + 'Start with a rough estimate from my address, show me the products and colors, then offer to help me map my roofline for a tighter estimate.',
      },
    }],
  }))

  return server
}

export function describeEstimate(dealerName: string, e: Estimate, notes: string[] = []): string {
  const feet = Math.abs(e.highFeet - e.lowFeet) < 1 ? `${Math.round(e.feet)} ft` : `${Math.round(e.lowFeet)} to ${Math.round(e.highFeet)} ft`
  return [
    `Estimated price: ${money(e.lowTotal)} to ${money(e.highTotal)}, including ${(e.taxRate * 100).toFixed(2)}% sales tax.`,
    `${dealerName}, ${e.productName}${e.variantName ? ` in ${e.variantName}` : ''}, about ${feet} of roofline (${e.source === 'Footprint' ? 'rough, from the building outline' : e.source === 'Kml' ? 'from the roofline KML' : 'from the feet given'}, +/-${Math.round(e.uncertainty * 100)}%).`,
    e.promotion ? `Includes the ${e.promotion.name} promotion (${money(e.promotion.amountPerFoot)} off per foot).` : '',
    e.monthlyFrom ? `Financing from about ${money(e.monthlyFrom.amount)}/month over ${e.monthlyFrom.termMonths} months${e.monthlyFrom.label ? ` (${e.monthlyFrom.label})` : ''}, subject to approval.` : '',
    ...notes,
    ...e.warnings.map(w => `Note: ${w}`),
    `Estimate ${e.estimateId}, good until ${e.validUntil.slice(0, 10)}. ${e.disclaimer}`,
  ].filter(Boolean).join('\n')
}

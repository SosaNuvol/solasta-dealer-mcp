// Checks on contact details before a quote request becomes a lead. There is no captcha (an AI assistant can't solve
// one), so obviously fake emails and phone numbers are refused here, and the API's own checks run after.

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

/** Domains that only exist to take throwaway or example addresses. */
const FAKE_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'test.com', 'test.test', 'mailinator.com', 'guerrillamail.com',
  'sharklasers.com', 'yopmail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'trashmail.com',
  'fakeinbox.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
])

const FAKE_LOCAL = /^(test|asdf|qwerty|fake|none|noemail|no-reply|noreply|abc|xxx+|aaa+)\d*$/i

export function emailProblem(email: string): string | undefined {
  const value = email.trim()
  if (!EMAIL.test(value) || value.length > 254) return 'That email address does not look valid.'
  const [local, domain] = value.toLowerCase().split('@') as [string, string]
  if (FAKE_DOMAINS.has(domain) || domain.endsWith('.example') || domain.endsWith('.test') || domain.endsWith('.invalid'))
    return 'Please use a real email address; the dealer replies by email.'
  if (FAKE_LOCAL.test(local)) return 'Please use a real email address; the dealer replies by email.'
  return undefined
}

/** US and Canadian numbers only (NANP), as the dealer calls and texts from a US number. */
export function phoneProblem(phone: string): string | undefined {
  let digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (digits.length !== 10) return 'Please give a 10-digit US phone number.'
  const area = digits.slice(0, 3), exchange = digits.slice(3, 6), line = digits.slice(6)
  if (/^[01]/.test(area) || /^[01]/.test(exchange)) return 'That phone number does not look valid.'
  if (exchange === '555' && line.startsWith('01')) return 'Please give a real phone number, not a sample one.'
  if (/^(\d)\1{9}$/.test(digits) || digits === '1234567890' || digits === '0123456789') return 'That phone number does not look valid.'
  return undefined
}

export const US_STATE = /^[A-Z]{2}$/
export const US_ZIP = /^\d{5}(-\d{4})?$/

import { describe, expect, it } from 'vitest'
import { emailProblem, phoneProblem } from '../src/contact.js'

describe('emailProblem', () => {
  it('accepts a normal address', () => expect(emailProblem('jane.doe+lights@gmail.com')).toBeUndefined())
  it.each(['not-an-email', 'a@b', 'jane@example.com', 'x@mailinator.com', 'test@gmail.com', 'asdf123@yahoo.com', 'me@site.test'])(
    'refuses %s', email => expect(emailProblem(email)).toBeDefined())
})

describe('phoneProblem', () => {
  it.each(['(801) 555-2368', '+1 801 762 9988', '8017629988'])('accepts %s', phone => expect(phoneProblem(phone)).toBeUndefined())
  it.each(['12345', '0001112222', '1234567890', '8015550123', '5555555555', '801-055-1234'])(
    'refuses %s', phone => expect(phoneProblem(phone)).toBeDefined())
})

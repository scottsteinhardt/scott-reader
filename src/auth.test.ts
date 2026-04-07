import { describe, it, expect, vi } from 'vitest'
import { createPasswordHash, verifyPassword, generateToken, extractToken } from './core/auth'

describe('auth', () => {
  describe('password hashing', () => {
    it('creates and verifies hashes', async () => {
      const password = 'my-secret-password'
      const stored = await createPasswordHash(password)
      
      expect(stored).toContain(':')
      const [salt, hash] = stored.split(':')
      expect(salt.length).toBeGreaterThan(10)
      expect(hash.length).toBeGreaterThan(10)
      
      expect(await verifyPassword(password, stored)).toBe(true)
      expect(await verifyPassword('wrong-password', stored)).toBe(false)
    })

    it('returns false for malformed stored hashes', async () => {
      expect(await verifyPassword('password', 'no-colon')).toBe(false)
      expect(await verifyPassword('password', ':only-hash')).toBe(false)
    })
  })

  describe('generateToken', () => {
    it('generates a URL-safe base64 token', () => {
      const token = generateToken()
      expect(token).toMatch(/^[a-zA-Z0-9_-]+$/)
      expect(token.length).toBeGreaterThan(30)
    })

    it('generates unique tokens', () => {
      const t1 = generateToken()
      const t2 = generateToken()
      expect(t1).not.toBe(t2)
    })
  })

  describe('extractToken', () => {
    it('extracts bearer token from header', () => {
      expect(extractToken('Bearer my-token')).toBe('my-token')
      expect(extractToken('bearer case-insensitive')).toBe('case-insensitive')
    })

    it('handles missing or malformed headers', () => {
      expect(extractToken(null)).toBe(null)
      expect(extractToken(undefined)).toBe(null)
      expect(extractToken('Basic abc')).toBe(null)
      expect(extractToken('NoBearer')).toBe(null)
    })
  })
})

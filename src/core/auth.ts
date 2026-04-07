import type { Context, Next } from 'hono'
import type { Env } from './types/env'
import type { User } from './types/entities'

type Variables = { user: User }

const TOKEN_TTL = 60 * 60 * 24 * 30 // 30 days

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return btoa(String.fromCharCode(...new Uint8Array(bits)))
}

/**
 * Creates a salted password hash using PBKDF2.
 * 
 * @param password - The plain-text password to hash
 * @returns A string in the format "salt:hash"
 */
export async function createPasswordHash(password: string): Promise<string> {
  const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  const hash = await hashPassword(password, salt)
  return `${salt}:${hash}`
}

/**
 * Verifies a plain-text password against a stored salt:hash string.
 * 
 * @param password - The plain-text password attempt
 * @param stored - The stored "salt:hash" string
 * @returns Promise resolving to true if valid, false otherwise
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const attempt = await hashPassword(password, salt)
  return attempt === hash
}

export function generateToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c] ?? c))
}

/**
 * Creates a new session token for a user and stores it in the database.
 * 
 * @param db - The D1 database instance
 * @param userId - The user ID to create a session for
 * @returns The newly generated session token
 */
export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = generateToken()
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL
  await db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt).run()
  // Clean up expired tokens occasionally
  await db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run()
  return token
}

/**
 * Retrieves a user from the database based on a session token.
 * 
 * @param db - The D1 database instance
 * @param token - The session token to check
 * @returns The user object if the token is valid and not expired, otherwise null
 */
export async function getUserFromToken(db: D1Database, token: string): Promise<User | null> {
  const row = await db.prepare(`
    SELECT u.id, u.username, u.public_view_enabled, u.is_admin, u.theme, u.accent_color, u.article_view
    FROM auth_tokens t JOIN users u ON t.user_id = u.id
    WHERE t.token = ? AND t.expires_at > ?
  `).bind(token, Math.floor(Date.now() / 1000)).first<User>()
  return row ?? null
}

/**
 * Extracts a Bearer token from an Authorization header.
 * 
 * @param authHeader - The raw Authorization header value
 * @returns The extracted token, or null if missing or malformed
 */
export function extractToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null
  const match = authHeader.match(/Bearer (.+)/i)
  return match ? match[1].trim() : null
}

/**
 * Hono middleware for enforcing authentication on routes.
 * Sets the 'user' variable in the context upon successful authentication.
 */
export function authMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const token = extractToken(c.req.header('Authorization'))
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  return getUserFromToken(c.env.DB, token).then(user => {
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user', user)
    return next()
  })
}

/**
 * Hono middleware for Fever API authentication.
 * Validates 'api_key' from form data or query params.
 */
export async function feverAuthMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  let apiKey = c.req.query('api_key')
  
  if (!apiKey && c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody()
      apiKey = String(body.api_key ?? '')
    } catch { /* ignore */ }
  }

  if (!apiKey) {
    return c.json({ api_version: 3, auth: 0, last_refreshed_on_time: Math.floor(Date.now() / 1000) })
  }

  const user = await c.env.DB.prepare('SELECT id, username, is_admin FROM users WHERE fever_api_key = ?')
    .bind(apiKey).first<User>()

  if (!user) {
    return c.json({ api_version: 3, auth: 0, last_refreshed_on_time: Math.floor(Date.now() / 1000) })
  }

  c.set('user', user)
  await next()
}

import { Hono } from 'hono'
import type { Env } from '../core/types/env'
import type { User } from '../core/types/entities'
import { authMiddleware, createPasswordHash, verifyPassword, createSession, getUserFromToken, extractToken } from '../core/auth'
import { md5 } from '../core/utils'

type Variables = { user: User }
const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// POST /api/users/login
app.post('/login', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>()
  if (!username || !password) return c.json({ error: 'Missing credentials' }, 400)

  const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE username = ?')
    .bind(username).first<{ id: number; password_hash: string }>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await createSession(c.env.DB, user.id)
  const profile = await c.env.DB.prepare(
    'SELECT id, username, public_view_enabled, is_admin, theme, accent_color, article_view FROM users WHERE id = ?'
  ).bind(user.id).first<User>()

  // Backfill fever_api_key for existing accounts that predate the Fever API
  const existing = await c.env.DB.prepare('SELECT fever_api_key FROM users WHERE id = ?')
    .bind(user.id).first<{ fever_api_key: string | null }>()
  if (!existing?.fever_api_key) {
    const feverKey = md5(`${profile!.username}:${password}`)
    await c.env.DB.prepare('UPDATE users SET fever_api_key = ? WHERE id = ?').bind(feverKey, user.id).run()
  }

  return c.json({ token, user: profile })
})

// POST /api/users/register — first user gets created, subsequent require auth (admin-only)
app.post('/register', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>()
  if (!username || !password) return c.json({ error: 'Missing fields' }, 400)
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return c.json({ error: 'Username may only contain letters, numbers, _ and -' }, 400)

  const count = await c.env.DB.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>()
  const isFirstUser = (count?.n ?? 0) === 0

  if (!isFirstUser) {
    // Only admins can create subsequent accounts
    const token = extractToken(c.req.header('Authorization'))
    if (!token) return c.json({ error: 'Unauthorized' }, 401)
    const authedUser = await getUserFromToken(c.env.DB, token)
    if (!authedUser) return c.json({ error: 'Unauthorized' }, 401)
    if (!authedUser.is_admin) return c.json({ error: 'Only admins can create accounts' }, 403)
  }

  const hash = await createPasswordHash(password)
  const feverKey = md5(`${username}:${password}`)
  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO users (username, password_hash, fever_api_key, is_admin) VALUES (?, ?, ?, ?)'
    ).bind(username, hash, feverKey, isFirstUser ? 1 : 0).run()

    const token = await createSession(c.env.DB, result.meta.last_row_id)
    const user = await c.env.DB.prepare(
      'SELECT id, username, public_view_enabled, is_admin, theme, accent_color, article_view FROM users WHERE id = ?'
    ).bind(result.meta.last_row_id).first<User>()

    return c.json({ token, user })
  } catch {
    return c.json({ error: 'Username already taken' }, 409)
  }
})

// All routes below require auth
app.use('*', authMiddleware)

// GET /api/users/me
app.get('/me', async (c) => {
  const user = c.get('user')
  return c.json(user)
})

// PATCH /api/users/me — update profile settings
app.patch('/me', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    theme?: string
    accent_color?: string
    article_view?: string
    public_view_enabled?: boolean
  }>()

  const allowed = ['system', 'light', 'dark']
  const views = ['comfortable', 'compact', 'magazine']

  const updates: string[] = []
  const params: unknown[] = []

  if (body.theme && allowed.includes(body.theme)) { updates.push('theme = ?'); params.push(body.theme) }
  if (body.accent_color && /^#[0-9a-f]{6}$/i.test(body.accent_color)) { updates.push('accent_color = ?'); params.push(body.accent_color) }
  if (body.article_view && views.includes(body.article_view)) { updates.push('article_view = ?'); params.push(body.article_view) }
  if (body.public_view_enabled !== undefined) { updates.push('public_view_enabled = ?'); params.push(body.public_view_enabled ? 1 : 0) }

  if (updates.length) {
    params.push(user.id)
    await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run()
  }

  const updated = await c.env.DB.prepare(
    'SELECT id, username, public_view_enabled, is_admin, theme, accent_color, article_view FROM users WHERE id = ?'
  ).bind(user.id).first<User>()

  return c.json(updated)
})

// POST /api/users/me/change-password
app.post('/me/change-password', async (c) => {
  const user = c.get('user')
  const { current_password, new_password } = await c.req.json<{ current_password: string; new_password: string }>()
  if (!current_password || !new_password) return c.json({ error: 'Missing fields' }, 400)
  if (new_password.length < 8) return c.json({ error: 'Password too short' }, 400)

  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id).first<{ password_hash: string }>()
  if (!row || !(await verifyPassword(current_password, row.password_hash))) {
    return c.json({ error: 'Current password incorrect' }, 401)
  }

  const hash = await createPasswordHash(new_password)
  const feverKey = md5(`${user.username}:${new_password}`)
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, fever_api_key = ? WHERE id = ?')
    .bind(hash, feverKey, user.id).run()
  // Invalidate all sessions
  await c.env.DB.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(user.id).run()
  const token = await createSession(c.env.DB, user.id)
  return c.json({ ok: true, token })
})

// DELETE /api/users/:id — admin only, cannot delete self
app.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!user.is_admin) return c.json({ error: 'Forbidden' }, 403)
  const targetId = parseInt(c.req.param('id'))
  if (targetId === user.id) return c.json({ error: 'Cannot delete your own account' }, 400)
  await c.env.DB.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(targetId).run()
  await c.env.DB.prepare('DELETE FROM user_feeds WHERE user_id = ?').bind(targetId).run()
  await c.env.DB.prepare('DELETE FROM user_articles WHERE user_id = ?').bind(targetId).run()
  await c.env.DB.prepare('DELETE FROM user_filters WHERE user_id = ?').bind(targetId).run()
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run()
  return c.json({ ok: true })
})

// POST /api/users/logout
app.post('/logout', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
  if (token) await c.env.DB.prepare('DELETE FROM auth_tokens WHERE token = ?').bind(token).run()
  return c.json({ ok: true })
})

// GET /api/users/list — list all users (admin only)
app.get('/list', async (c) => {
  const user = c.get('user')
  if (!user.is_admin) return c.json({ error: 'Forbidden' }, 403)
  const rows = await c.env.DB.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at').all()
  return c.json(rows.results)
})

// ─── Filters ─────────────────────────────────────────────────────────────────

app.get('/filters', async (c) => {
  const user = c.get('user')
  const rows = await c.env.DB.prepare('SELECT * FROM user_filters WHERE user_id = ? ORDER BY created_at')
    .bind(user.id).all()
  return c.json(rows.results)
})

app.post('/filters', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    name: string; match_field: string; keyword: string
    feed_id?: number; folder?: string; action: string
  }>()

  const validFields = ['title', 'content', 'author', 'any']
  const validActions = ['mark_read', 'star']

  if (!body.name || !body.keyword || !body.action) return c.json({ error: 'Missing fields' }, 400)
  if (!validFields.includes(body.match_field ?? 'title')) return c.json({ error: 'Invalid match_field' }, 400)
  if (!validActions.includes(body.action)) return c.json({ error: 'Invalid action' }, 400)

  const result = await c.env.DB.prepare(`
    INSERT INTO user_filters (user_id, name, match_field, keyword, feed_id, folder, action)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(user.id, body.name, body.match_field ?? 'title', body.keyword,
    body.feed_id ?? null, body.folder ?? null, body.action).run()

  return c.json({ ok: true, id: result.meta.last_row_id })
})

app.delete('/filters/:id', async (c) => {
  const user = c.get('user')
  const filterId = parseInt(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM user_filters WHERE id = ? AND user_id = ?')
    .bind(filterId, user.id).run()
  return c.json({ ok: true })
})

export { app as userRoutes }

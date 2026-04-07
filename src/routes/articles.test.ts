import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { articleRoutes } from './articles'
import type { User } from '../core/types/entities'

vi.mock('../auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 1, username: 'testuser', is_admin: 0 } as User)
    await next()
  }
}))

vi.mock('../lib/db', () => ({
  markArticlesRead: vi.fn().mockResolvedValue(undefined),
  markArticlesReadByCriteria: vi.fn().mockResolvedValue(5)
}))

describe('Article Routes', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono().route('/api/articles', articleRoutes)
  })

  it('POST /api/articles/mark-read-batch calls markArticlesRead', async () => {
    const mockDb = { prepare: vi.fn().mockReturnThis() }
    const res = await app.request('/api/articles/mark-read-batch', {
      method: 'POST',
      body: JSON.stringify({ ids: [1, 2, 3] }),
      headers: { 'Content-Type': 'application/json' }
    }, { DB: mockDb } as any)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
  })

  it('POST /api/articles/mark-all-read calls markArticlesReadByCriteria', async () => {
    const mockDb = { prepare: vi.fn().mockReturnThis() }
    const res = await app.request('/api/articles/mark-all-read', {
      method: 'POST',
      body: JSON.stringify({ feed_id: 1 }),
      headers: { 'Content-Type': 'application/json' }
    }, { DB: mockDb } as any)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.marked).toBe(5)
  })
})

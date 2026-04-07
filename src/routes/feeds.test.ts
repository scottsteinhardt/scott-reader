import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { feedRoutes } from './feeds'
import type { User } from '../core/types/entities'

vi.mock('../auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 1, username: 'testuser', is_admin: 0 } as User)
    await next()
  }
}))

vi.mock('../lib/discovery', () => ({
  discoverFeedUrl: vi.fn().mockResolvedValue('https://example.com/feed.xml')
}))

describe('Feed Routes', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono().route('/api/feeds', feedRoutes)
  })

  it('GET /api/feeds returns user feeds', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [{ id: 1, title: 'Example Feed', url: 'https://example.com/feed.xml' }] })
      })
    }
    
    const res = await app.request('/api/feeds', {}, { DB: mockDb } as any)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveLength(1)
    expect(data[0].title).toBe('Example Feed')
  })

  it('POST /api/feeds subscribes to a feed', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ id: 10 }),
        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 10 } })
      })
    }

    const res = await app.request('/api/feeds', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com' }),
      headers: { 'Content-Type': 'application/json' }
    }, { 
      DB: mockDb,
    }, {
      waitUntil: vi.fn()
    } as any)

    if (res.status !== 200) {
      console.error(await res.json())
    }
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.feedId).toBe(10)
  })
})

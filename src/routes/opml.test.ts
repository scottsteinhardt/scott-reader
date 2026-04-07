import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { opmlRoutes } from './opml'
import type { User } from '../core/types/entities'

vi.mock('../auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 1, username: 'testuser', is_admin: 0 } as User)
    await next()
  }
}))

describe('OPML Routes', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono().route('/api/opml', opmlRoutes)
  })

  it('GET /api/opml returns XML', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [
          { url: 'https://example.com/rss', title: 'Example', folder: 'Tech' }
        ]})
      })
    }
    
    const res = await app.request('/api/opml', {}, { DB: mockDb } as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/xml')
    const body = await res.text()
    expect(body).toContain('<opml version="2.0">')
    expect(body).toContain('xmlUrl="https://example.com/rss"')
  })

  it('POST /api/opml imports feeds', async () => {
    const opmlContent = `
      <opml version="2.0">
        <body>
          <outline type="rss" text="Example" title="Example" xmlUrl="https://example.com/rss"/>
        </body>
      </opml>
    `
    const mockDb = {
      batch: vi.fn().mockResolvedValue([]),
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue({ id: 1 }),
        all: vi.fn().mockResolvedValue({ results: [{ id: 1, url: 'https://example.com/rss' }] })
      })
    }

    const formData = new FormData()
    formData.append('file', new File([opmlContent], 'subs.opml', { type: 'text/xml' }))

    const res = await app.request('/api/opml', {
      method: 'POST',
      body: formData,
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
    expect(data.imported).toBeGreaterThanOrEqual(0)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { feverRoutes } from './fever'

describe('Fever API Routes', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono().route('/fever', feverRoutes)
  })

  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    })
  }

  it('returns 404 if "api" search param is missing', async () => {
    const res = await app.request('/fever')
    expect(res.status).toBe(404)
  })

  it('returns unauthenticated response for invalid api_key', async () => {
    mockDb.prepare().first.mockResolvedValue(null)
    
    const res = await app.request('/fever?api', {
      method: 'POST',
      body: new URLSearchParams({ api_key: 'invalid' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, { DB: mockDb } as any)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.auth).toBe(0)
    expect(data.api_version).toBe(3)
  })

  it('returns authenticated response and requested data', async () => {
    // 1. Auth check succeeds
    mockDb.prepare.mockReturnValueOnce({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ id: 1 })
    })
    
    // 2. getFeeds query succeeds
    mockDb.prepare.mockReturnValueOnce({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [
        { id: 10, title: 'Feed 1', url: 'https://ex.com/1', site_url: 'https://ex.com', last_updated_on_time: 123 }
      ]})
    })

    // 3. getGroups query (empty)
    mockDb.prepare.mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null)
    })

    const res = await app.request('/fever?api&feeds', {
      method: 'POST',
      body: new URLSearchParams({ api_key: 'valid' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, { DB: mockDb } as any)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.auth).toBe(1)
    expect(data.feeds).toHaveLength(1)
    expect(data.feeds[0].title).toBe('Feed 1')
  })

  it('handles "mark" actions', async () => {
    // 1. Auth check
    mockDb.prepare().first.mockResolvedValueOnce({ id: 1 })
    
    // 2. Mark action run
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    mockDb.prepare().run = mockRun

    const res = await app.request('/fever?api', {
      method: 'POST',
      body: new URLSearchParams({ 
        api_key: 'valid',
        mark: 'item',
        as: 'read',
        id: '100'
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, { DB: mockDb } as any)

    expect(res.status).toBe(200)
    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_articles'))
  })
})

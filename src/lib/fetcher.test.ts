import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchOneFeed } from './fetcher'
import type { D1Database } from '@cloudflare/workers-types'

describe('fetcher', () => {
  const mockDb = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] })
  } as unknown as D1Database

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('fetchWithRewrites', () => {
    it('rewrites reddit URLs to old.reddit.com', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => '<rss><channel><title>Reddit</title></channel></rss>'
      } as Response)

      await fetchOneFeed(mockDb, 1, 'https://www.reddit.com/r/javascript/.rss')
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://old.reddit.com/r/javascript/.rss',
        expect.any(Object)
      )
    })

    it('falls back to Invidious for YouTube 404s', async () => {
      const mockFetch = vi.mocked(fetch)
      
      // 1. First call (direct YouTube) fails with 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        body: { cancel: vi.fn() }
      } as any)
      
      // 2. Second call (Invidious instance) succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => '<rss><channel><title>YouTube</title></channel></rss>'
      } as any)

      await fetchOneFeed(mockDb, 1, 'https://www.youtube.com/feeds/videos.xml?channel_id=UC123')
      
      // Should have tried at least one Invidious instance
      const invidiousCall = mockFetch.mock.calls.find(call => 
        String(call[0]).includes('inv.nadeko.net') || 
        String(call[0]).includes('invidious.privacyredirect.com')
      )
      expect(invidiousCall).toBeDefined()
    })
  })

  describe('handleRateLimit', () => {
    it('schedules backoff for HTTP 429', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '3600' }),
        body: { cancel: vi.fn() }
      } as any)

      const result = await fetchOneFeed(mockDb, 1, 'https://example.com/feed.xml')
      
      expect(result.ok).toBe(false)
      expect(result.error).toContain('HTTP 429')
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE feeds SET last_error'))
    })
  })
})

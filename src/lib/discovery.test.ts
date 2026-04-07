import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { discoverFeedUrl } from './discovery'

describe('discovery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns URL if it already looks like a feed', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/rss+xml' })
    } as Response)

    const result = await discoverFeedUrl('https://example.com/rss.xml')
    expect(result).toBe('https://example.com/rss.xml')
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/rss.xml', expect.objectContaining({ method: 'HEAD' }))
  })

  it('finds feed URL from <link> tag in HTML', async () => {
    const mockFetch = vi.mocked(fetch)
    
    // 1st call: looksLikeFeed (HEAD) -> false
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' })
    } as Response)
    
    // 2nd call: fetch HTML content (GET)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>'
    } as Response)

    const result = await discoverFeedUrl('https://example.com')
    expect(result).toBe('https://example.com/feed.xml')
  })

  it('falls back to common paths if no link tag found', async () => {
    const mockFetch = vi.mocked(fetch)
    
    // 1. Initial HEAD check -> false
    mockFetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) } as Response)
    // 2. Fetch HTML content -> empty
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '<html><body>No links</body></html>' } as Response)
    
    // 3. Common path candidates HEAD checks...
    // Let's say the 2nd candidate (/feed.xml) works
    mockFetch.mockResolvedValueOnce({ ok: false }) // /feed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/atom+xml' })
    } as Response) // /feed.xml

    const result = await discoverFeedUrl('https://example.com')
    expect(result).toBe('https://example.com/feed.xml')
  })

  it('throws error if no feed is found', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue({ ok: false }) // Everything fails

    await expect(discoverFeedUrl('https://example.com')).rejects.toThrow('Could not fetch https://example.com')
  })
})

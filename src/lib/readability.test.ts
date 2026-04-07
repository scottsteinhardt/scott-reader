import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchFullContent } from './readability'

// Mock HTMLRewriter
class MockHTMLRewriter {
  handlers: any[] = []
  on(selector: string, handler: any) {
    this.handlers.push({ selector, handler })
    return this
  }
  transform(res: Response) {
    return {
      text: async () => {
        // Trigger handlers based on a simple mock logic
        for (const h of this.handlers) {
          if (h.handler.element) h.handler.element({ onEndTag: (cb: any) => cb() })
          if (h.handler.text) h.handler.text({ text: 'mocked content ' })
        }
        return ''
      }
    }
  }
}

describe('readability', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('HTMLRewriter', MockHTMLRewriter)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws if response is not ok', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      body: { cancel: vi.fn() }
    } as any)

    await expect(fetchFullContent('https://example.com/art')).rejects.toThrow('HTTP 404')
  })

  it('throws if content is not HTML', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: { cancel: vi.fn() }
    } as any)

    await expect(fetchFullContent('https://example.com/art')).rejects.toThrow('Expected HTML')
  })

  it('extracts content using HTMLRewriter', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue({
      ok: true,
      clone: () => ({ body: { cancel: vi.fn() } }),
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html>...</html>'
    } as any)

    const result = await fetchFullContent('https://example.com/art')
    expect(result.content).toBeDefined()
    expect(result.wordCount).toBeGreaterThan(0)
  })
})

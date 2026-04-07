import { countWords } from '../core/utils'

/**
 * Lightweight full-content extractor using HTMLRewriter.
 * Fetches article URL and strips down to main content.
 * 
 * @param articleUrl - URL of the article to fetch
 * @returns Object with content and word count
 * @throws {Error} On network failure, invalid content type, or extraction failure
 */
export async function fetchFullContent(articleUrl: string): Promise<{ content: string; wordCount: number }> {
  const res = await fetch(articleUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  })
  
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`Failed to fetch article: HTTP ${res.status}`)
  }

  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('html')) {
    await res.body?.cancel()
    throw new Error(`Expected HTML content, got ${ct.split(';')[0].trim()}`)
  }

    const chunks: string[] = []
    let inMain = false
    let depth = 0
    let skipDepth = 0
    let skipping = false

    const rewriter = new HTMLRewriter()
      .on('article, main, [role="main"]', {
        element() { inMain = true; depth = 0 },
      })
      .on('nav, header, footer, aside, script, style, iframe, noscript, form', {
        element(el) {
          if (inMain) { skipping = true; skipDepth = depth }
        },
      })
      .on('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption', {
        text(text) {
          if (inMain && !skipping) chunks.push(text.text)
        },
      })
      .on('*', {
        element(el) { 
          if (inMain) {
            depth++
            el.onEndTag(() => {
              depth--
            })
          }
        },
        text(text) {
          if (skipping && depth <= skipDepth) skipping = false
        },
      })

    // If page has no article/main, collect all paragraph text
    const bodyChunks: string[] = []
    const fallback = new HTMLRewriter()
      .on('p, h1, h2, h3, h4, li', {
        text(text) { bodyChunks.push(text.text) },
      })
      .on('script, style, nav, header, footer, aside', {
        text() {},
      })

    const cloned = res.clone()
    await rewriter.transform(res).text()
    const content = chunks.join(' ').replace(/\s+/g, ' ').trim()

    if (content.length < 200) {
      await fallback.transform(cloned).text()
      const fallbackContent = bodyChunks.join(' ').replace(/\s+/g, ' ').trim()
      if (fallbackContent.length > content.length) {
        return { content: fallbackContent, wordCount: countWords(fallbackContent) }
      }
    } else {
      await cloned.body?.cancel()
    }

    if (!content) throw new Error('No content extracted from page')
    return { content, wordCount: countWords(content) }
}

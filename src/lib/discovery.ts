const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function isYouTubeUrl(url: string): boolean {
  return /youtube\.com/i.test(url)
}

/**
 * Attempt to find an RSS/Atom feed URL from any given URL.
 * Checks the URL directly, looks for link tags in HTML, and tries common paths.
 *
 * @param url - The website or feed URL to check
 * @returns The discovered feed URL
 * @throws {Error} If no feed can be found or the network request fails
 */
export async function discoverFeedUrl(url: string): Promise<string> {
  // If it already looks like a feed, return it
  if (await looksLikeFeed(url)) return url

  // Fetch the page and look for <link rel="alternate"> feed links
  let html: string
  const ua = isYouTubeUrl(url) ? CHROME_UA : 'RSS Reader/1.0 (feed discovery)'
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`)
    html = await res.text()
  } catch (e) {
    throw new Error(`Could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Extract <link> tags with RSS/Atom type
  const linkRegex = /<link[^>]+rel=["']alternate["'][^>]*>/gi
  const matches = [...html.matchAll(linkRegex)]
  for (const match of matches) {
    const tag = match[0]
    if (!/application\/(rss|atom)\+xml/i.test(tag)) continue
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i)
    if (hrefMatch) {
      return new URL(hrefMatch[1], url).href
    }
  }

  // Try common feed paths
  const base = new URL(url).origin
  const candidates = [
    `${base}/feed`,
    `${base}/feed.xml`,
    `${base}/rss`,
    `${base}/rss.xml`,
    `${base}/atom.xml`,
    `${base}/index.xml`,
    `${url.replace(/\/$/, '')}/feed`,
  ]

  for (const candidate of candidates) {
    if (await looksLikeFeed(candidate)) return candidate
  }

  throw new Error(`No feed found at ${url}`)
}

async function looksLikeFeed(url: string): Promise<boolean> {
  const ua = isYouTubeUrl(url) ? CHROME_UA : 'RSS Reader/1.0 (feed discovery)'
  try {
    // Try HEAD first for speed
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(8000),
    })
    if (head.ok) {
      const ct = head.headers.get('content-type') ?? ''
      if (/xml|rss|atom/i.test(ct)) return true
    }

    // Fall back to GET — some servers don't support HEAD or return wrong content-type
    const res = await fetch(url, {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return false
    const ct = res.headers.get('content-type') ?? ''
    if (/xml|rss|atom/i.test(ct)) return true
    // Check body for feed markers even if content-type is wrong
    const text = await res.text()
    return /^\s*<\?xml|<rss\s|<feed\s|<rdf:RDF\s/i.test(text.slice(0, 1000))
  } catch {
    return false
  }
}

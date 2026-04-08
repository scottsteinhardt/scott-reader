import { parseFeed } from './parser'
import { fetchFullContent } from './readability'
import { applyFilters } from './filters'
import { countWords } from '../core/utils'

const FETCH_TIMEOUT = 15000
const FULL_CONTENT_THRESHOLD = 200 // fetch full content if article content is shorter than this
const BATCH_SIZE = 3

interface FetchResult {
  feedId: number
  url: string
  ok: boolean
  newItems: number
  error?: string
}

const RETENTION_DAYS = 90

/**
 * Fetches a batch of feeds that are due for refresh.
 * Purges old unstarred articles periodically.
 * 
 * @param db - The D1 database instance
 * @returns Array of fetch results for the processed batch
 */
export async function scheduledFetch(db: D1Database): Promise<FetchResult[]> {
  return batchFetch(db, { skipFullContent: true })
}

// Fetches exactly one overdue feed — safe for free tier CPU limits.
// Returns { fetched: 1 } if a feed was processed, { fetched: 0 } if nothing was due.
export async function fetchOneDue(db: D1Database): Promise<{ fetched: number; newItems: number }> {
  const now = Math.floor(Date.now() / 1000)
  // Reset any feeds stuck in-progress (9999999999) for over 5 minutes — handles Worker crashes
  await db.prepare(
    `UPDATE feeds SET next_fetch_at = 0 WHERE next_fetch_at = 9999999999 AND last_fetched_at < ?`
  ).bind(now - 300).run()
  // Atomically claim one feed by pushing next_fetch_at into the future before fetching.
  // This prevents concurrent callers from picking the same feed.
  const claimed = await db.prepare(`
    UPDATE feeds SET next_fetch_at = 9999999999
    WHERE id = (SELECT id FROM feeds WHERE next_fetch_at <= ? ORDER BY next_fetch_at ASC LIMIT 1)
    RETURNING id, url
  `).bind(now).first<{ id: number; url: string }>()
  if (!claimed) return { fetched: 0, newItems: 0 }
  const result = await fetchOneFeed(db, claimed.id, claimed.url, { skipFullContent: false })
  return { fetched: 1, newItems: result.newItems }
}

async function batchFetch(db: D1Database, { skipFullContent = false } = {}): Promise<FetchResult[]> {
  const now = Math.floor(Date.now() / 1000)

  // Purge old articles once per hour (top of the hour) — skip on all other ticks
  // Running this every minute is wasteful; the NOT IN subquery scans the full user_articles table
  const minuteOfHour = Math.floor(now / 60) % 60
  if (minuteOfHour === 0) {
    const cutoff = now - RETENTION_DAYS * 86400
    await db.prepare(`
      DELETE FROM articles WHERE fetched_at < ?
      AND NOT EXISTS (SELECT 1 FROM user_articles WHERE article_id = articles.id AND is_starred = 1)
    `).bind(cutoff).run()
  }

  // Order by next_fetch_at ASC so most overdue feeds always get priority
  const feeds = await db.prepare(
    'SELECT id, url, refresh_interval FROM feeds WHERE next_fetch_at <= ? ORDER BY next_fetch_at ASC LIMIT ?'
  ).bind(now, BATCH_SIZE).all<{ id: number; url: string; refresh_interval: number }>()

  const results: FetchResult[] = []
  for (const feed of feeds.results) {
    try {
      results.push(await fetchOneFeed(db, feed.id, feed.url, { skipFullContent }))
    } catch (e) {
      results.push({ feedId: feed.id, url: feed.url, ok: false, newItems: 0, error: String(e) })
    }
  }
  return results
}

/**
 * Fetches and processes a single feed URL.
 * 
 * @param db - The D1 database instance
 * @param feedId - ID of the feed record in the DB
 * @param feedUrl - URL of the feed to fetch
 * @returns Result object with feedId, url, ok flag, and error if any
 */
export async function fetchOneFeed(db: D1Database, feedId: number, feedUrl: string, { skipFullContent = false } = {}): Promise<FetchResult> {
  const now = Math.floor(Date.now() / 1000)
  try {
    const { response, finalUrl } = await fetchWithRewrites(feedUrl)

    if (response.status === 429) {
      return handleRateLimit(db, feedId, feedUrl, response, now)
    }

    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status}`)
    }

    validateContentType(response)

    const xml = await response.text()
    const parsed = parseFeed(xml, finalUrl)

    await updateFeedMetadata(db, feedId, parsed, now)
    fetchFavicon(db, feedId, parsed.siteUrl || finalUrl).catch(() => {})

    const newItems = await processArticles(db, feedId, parsed.items, { skipFullContent })

    return { feedId, url: feedUrl, ok: true, newItems }
  } catch (err) {
    // Piped fallback: last resort for YouTube channels when direct + Invidious both fail
    const ytChannelId = extractYouTubeChannelId(feedUrl)
    if (ytChannelId) {
      try {
        const parsed = await fetchFromPiped(ytChannelId)
        if (parsed) {
          await updateFeedMetadata(db, feedId, parsed, now)
          fetchFavicon(db, feedId, parsed.siteUrl || feedUrl).catch(() => {})
          const newItems = await processArticles(db, feedId, parsed.items, { skipFullContent })
          return { feedId, url: feedUrl, ok: true, newItems }
        }
      } catch { /* ignore */ }
    }

    const error = err instanceof Error ? err.message : String(err)
    await db.prepare(`
      UPDATE feeds SET last_error = ?, error_count = error_count + 1,
        last_fetched_at = ?, next_fetch_at = ? + refresh_interval
      WHERE id = ?
    `).bind(error, now, now, feedId).run()
    return { feedId, url: feedUrl, ok: false, newItems: 0, error }
  }
}

/**
 * Handles platform-specific URL rewrites and fetching with fallbacks.
 */
async function fetchWithRewrites(feedUrl: string): Promise<{ response: Response; finalUrl: string }> {
  let fetchUrl = feedUrl
  // Reddit rewrite
  if (/^https?:\/\/(www\.)?reddit\.com/i.test(feedUrl)) {
    fetchUrl = feedUrl.replace(/^(https?:\/\/)(www\.)?reddit\.com/i, '$1old.reddit.com')
  }

  const ytChannelId = extractYouTubeChannelId(feedUrl)
  const isYouTube = !!ytChannelId || feedUrl.includes('youtube.com')

  const headers = {
    'User-Agent': isYouTube
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (compatible; FreshRSS/1.21.0; +https://freshrss.org)',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  }

  let res = await fetch(fetchUrl, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    redirect: 'follow',
  })

  // YouTube fallback to Invidious — trigger on any non-OK status or HTML content-type
  const ytReturnedHtml = ytChannelId && /text\/html/i.test(res.headers.get('content-type') ?? '') && !/xml|atom/i.test(res.headers.get('content-type') ?? '')
  if (ytChannelId && (!res.ok || ytReturnedHtml)) {
    await res.body?.cancel()
    const invidiousInstances = ['https://inv.nadeko.net', 'https://invidious.tiekoetter.com', 'https://invidious.lunar.icu', 'https://yewtu.be']
    for (const instance of invidiousInstances) {
      try {
        const invRes = await fetch(`${instance}/feed/channel/${ytChannelId}`, {
          headers: { 'User-Agent': headers['User-Agent'] },
          signal: AbortSignal.timeout(8000),
          redirect: 'follow',
        })
        const invCt = invRes.headers.get('content-type') ?? ''
        if (invRes.ok && /xml|atom|rss/i.test(invCt)) return { response: invRes, finalUrl: `${instance}/feed/channel/${ytChannelId}` }
        await invRes.body?.cancel()
      } catch { /* ignore */ }
    }
    throw new Error('YouTube feed unavailable (all Invidious instances failed)')
  }

  return { response: res, finalUrl: fetchUrl }
}

async function handleRateLimit(db: D1Database, feedId: number, feedUrl: string, res: Response, now: number): Promise<FetchResult> {
  await res.body?.cancel()
  const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10)
  const backoff = retryAfter > 0 ? retryAfter : 3600
  await db.prepare(
    'UPDATE feeds SET last_error = ?, last_fetched_at = ?, next_fetch_at = ? WHERE id = ?'
  ).bind(`HTTP 429 (retry after ${backoff}s)`, now, now + backoff, feedId).run()
  return { feedId, url: feedUrl, ok: false, newItems: 0, error: `HTTP 429 (retry after ${backoff}s)` }
}

function validateContentType(res: Response) {
  const ct = res.headers.get('content-type') ?? ''
  if (/text\/html/i.test(ct) && !/xml|rss|atom|json/i.test(ct)) {
    throw new Error(`Expected feed, got ${ct.split(';')[0].trim()}`)
  }
}

async function updateFeedMetadata(db: D1Database, feedId: number, parsed: any, now: number) {
  await db.prepare(`
    UPDATE feeds SET title = COALESCE(title, ?), description = COALESCE(description, ?),
      site_url = COALESCE(site_url, ?), last_fetched_at = ?, last_error = NULL,
      error_count = 0, next_fetch_at = ? + refresh_interval
    WHERE id = ?
  `).bind(parsed.title || null, parsed.description || null, parsed.siteUrl || null,
    now, now, feedId).run()
}

async function processArticles(db: D1Database, feedId: number, items: any[], { skipFullContent = false } = {}): Promise<number> {
  const subscribers = await db.prepare(
    'SELECT user_id, folder FROM user_feeds WHERE feed_id = ?'
  ).bind(feedId).all<{ user_id: number; folder: string | null }>()

  let newItems = 0
  const limitedItems = items.slice(0, 30)

  for (const item of limitedItems) {
    const existing = await db.prepare(
      'SELECT id, content FROM articles WHERE feed_id = ? AND guid = ?'
    ).bind(feedId, item.guid).first<{ id: number; content: string | null }>()

    let articleId: number

    if (existing) {
      articleId = existing.id
      if (item.content && (!existing.content || existing.content.length < item.content.length)) {
        await db.prepare('UPDATE articles SET content = ?, word_count = ? WHERE id = ?')
          .bind(item.content, countWords(item.content), existing.id).run()
      }
    } else {
      let content = item.content
      let fullContent: string | null = null
      let wordCount = countWords(content)

      if (!skipFullContent && item.url && content.length < FULL_CONTENT_THRESHOLD) {
        const extracted = await fetchFullContent(item.url).catch(() => null)
        if (extracted) {
          fullContent = extracted.content
          wordCount = extracted.wordCount
        }
      }

      const result = await db.prepare(`
        INSERT INTO articles (feed_id, guid, title, url, content, full_content, author, published_at, word_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feed_id, guid) DO NOTHING
      `).bind(feedId, item.guid, item.title || null, item.url || null,
        content || null, fullContent, item.author || null,
        item.publishedAt ? Math.floor(item.publishedAt.getTime() / 1000) : null,
        wordCount).run()

      if (result.meta.changes === 0) {
        const existing2 = await db.prepare('SELECT id FROM articles WHERE feed_id = ? AND guid = ?')
          .bind(feedId, item.guid).first<{ id: number }>()
        articleId = existing2?.id ?? 0
      } else {
        articleId = result.meta.last_row_id
        newItems++
      }
    }

    if (articleId) {
      for (const sub of subscribers.results) {
        await applyFilters(db, sub.user_id, articleId, item, feedId, sub.folder)
      }
    }
  }
  return newItems
}

async function fetchFavicon(db: D1Database, feedId: number, siteUrl: string): Promise<void> {
  const existing = await db.prepare('SELECT favicon_url FROM feeds WHERE id = ?').bind(feedId).first<{ favicon_url: string | null }>()
  if (existing?.favicon_url) return

  const origin = new URL(siteUrl).origin
  const faviconUrl = `${origin}/favicon.ico`

  // Check if favicon exists
  const res = await fetch(faviconUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
  if (res.ok) {
    await db.prepare('UPDATE feeds SET favicon_url = ? WHERE id = ?').bind(faviconUrl, feedId).run()
  }
}

// Fetch YouTube channel data from Piped (last-resort fallback when YouTube + Invidious both fail).
// Piped fetches channels on demand from YouTube via their own scraping infrastructure.
async function fetchFromPiped(ytChannelId: string): Promise<{ title: string; description: string; siteUrl: string; items: any[] } | null> {
  const pipedInstances = ['https://api.piped.private.coffee']
  for (const instance of pipedInstances) {
    try {
      const res = await fetch(`${instance}/channel/${ytChannelId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FreshRSS/1.21.0; +https://freshrss.org)' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) continue
      const ct = res.headers.get('content-type') ?? ''
      if (!/json/i.test(ct)) { await res.body?.cancel(); continue }
      const data = await res.json() as { name?: string; description?: string; relatedStreams?: any[] }
      if (!data.name || !Array.isArray(data.relatedStreams)) continue
      return {
        title: data.name,
        description: data.description || '',
        siteUrl: `https://www.youtube.com/channel/${ytChannelId}`,
        items: data.relatedStreams
          .filter((v: any) => typeof v.url === 'string' && v.url.includes('/watch?v='))
          .map((v: any) => ({
            guid: `https://www.youtube.com${v.url}`,
            title: v.title || '',
            url: `https://www.youtube.com${v.url}`,
            content: v.shortDescription || '',
            author: v.uploaderName || '',
            publishedAt: v.uploaded ? new Date(v.uploaded) : null,
          })),
      }
    } catch { /* ignore */ }
  }
  return null
}

// Extract YouTube channel ID from feed URLs like:
//   https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxx
//   https://www.youtube.com/feeds/videos.xml?playlist_id=PLxxxxxx (no channel ID, skip)
function extractYouTubeChannelId(url: string): string | null {
  const match = url.match(/[?&]channel_id=(UC[^&]+)/)
  return match ? match[1] : null
}

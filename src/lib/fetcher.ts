import { parseFeed } from './parser'
import { fetchFullContent } from './readability'
import { applyFilters } from './filters'
import { countWords } from '../core/utils'

const FETCH_TIMEOUT = 15000
const FULL_CONTENT_THRESHOLD = 200 // fetch full content if article content is shorter than this
const BATCH_SIZE = 10 // watch logs for CPU exceeded; drop back to 5 if it recurs

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

  const results = await Promise.allSettled(
    feeds.results.map(feed => fetchOneFeed(db, feed.id, feed.url))
  )

  return results.map((r, i) => {
    const feed = feeds.results[i]!
    if (r.status === 'fulfilled') return r.value
    return { feedId: feed.id, url: feed.url, ok: false, newItems: 0, error: String(r.reason) }
  })
}

/**
 * Fetches and processes a single feed URL.
 * 
 * @param db - The D1 database instance
 * @param feedId - ID of the feed record in the DB
 * @param feedUrl - URL of the feed to fetch
 * @returns Result object with feedId, url, ok flag, and error if any
 */
export async function fetchOneFeed(db: D1Database, feedId: number, feedUrl: string): Promise<FetchResult> {
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

    const newItems = await processArticles(db, feedId, parsed.items)

    return { feedId, url: feedUrl, ok: true, newItems }
  } catch (err) {
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

  // YouTube fallback to Invidious
  if ((res.status === 404 || res.status === 403) && ytChannelId) {
    await res.body?.cancel()
    const invidiousInstances = ['https://invidious.nerdvpn.de', 'https://invidious.protokolla.fi', 'https://invidious.materialio.us', 'https://inv.in.projectsegfau.lt']
    for (const instance of invidiousInstances) {
      try {
        const invRes = await fetch(`${instance}/feed/channel/${ytChannelId}`, {
          headers: { 'User-Agent': headers['User-Agent'] },
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
          redirect: 'follow',
        })
        if (invRes.ok) return { response: invRes, finalUrl: `${instance}/feed/channel/${ytChannelId}` }
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

async function processArticles(db: D1Database, feedId: number, items: any[]): Promise<number> {
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

      if (item.url && content.length < FULL_CONTENT_THRESHOLD) {
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

// Extract YouTube channel ID from feed URLs like:
//   https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxx
//   https://www.youtube.com/feeds/videos.xml?playlist_id=PLxxxxxx (no channel ID, skip)
function extractYouTubeChannelId(url: string): string | null {
  const match = url.match(/[?&]channel_id=(UC[^&]+)/)
  return match ? match[1] : null
}

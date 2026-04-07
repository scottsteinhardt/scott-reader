import { Hono } from 'hono'
import type { Env } from '../core/types/env'
import type { User } from '../core/types/entities'
import { authMiddleware } from '../core/auth'
import { fetchOneFeed } from '../lib/fetcher'

type Variables = { user: User }
const app = new Hono<{ Bindings: Env; Variables: Variables }>()
app.use('*', authMiddleware)

// GET /api/opml — export subscriptions as OPML
app.get('/', async (c) => {
  const user = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT f.url, f.title, f.site_url, f.description, uf.folder, uf.custom_title
    FROM user_feeds uf
    JOIN feeds f ON uf.feed_id = f.id
    WHERE uf.user_id = ?
    ORDER BY uf.folder NULLS LAST, COALESCE(uf.custom_title, f.title)
  `).bind(user.id).all<{
    url: string; title: string | null; site_url: string | null
    description: string | null; folder: string | null; custom_title: string | null
  }>()

  // Group by folder
  const groups = new Map<string | null, typeof rows.results>()
  for (const row of rows.results) {
    const key = row.folder ?? null
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const escapeXml = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const feedOutline = (row: (typeof rows.results)[0]) => {
    const title = escapeXml(row.custom_title ?? row.title ?? row.url)
    const htmlUrl = row.site_url ? ` htmlUrl="${escapeXml(row.site_url)}"` : ''
    const desc = row.description ? ` description="${escapeXml(row.description)}"` : ''
    return `    <outline type="rss" text="${title}" title="${title}" xmlUrl="${escapeXml(row.url)}"${htmlUrl}${desc}/>`
  }

  const bodyLines: string[] = []

  // Feeds without folder first
  const ungrouped = groups.get(null) ?? []
  for (const row of ungrouped) bodyLines.push(feedOutline(row))

  // Grouped feeds
  for (const [folder, feeds] of groups) {
    if (!folder) continue
    bodyLines.push(`  <outline text="${escapeXml(folder)}" title="${escapeXml(folder)}">`)
    for (const row of feeds) bodyLines.push(feedOutline(row))
    bodyLines.push('  </outline>')
  }

  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(user.username)}'s subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${bodyLines.join('\n')}
  </body>
</opml>`

  return new Response(opml, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${user.username}-subscriptions.opml"`,
    },
  })
})

// POST /api/opml — import OPML file
app.post('/', async (c) => {
  const user = c.get('user')
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file uploaded' }, 400)

  const xml = await file.text()

  // Parse OPML — attribute-order-independent extraction
  interface OPMLEntry { url: string; title: string; folder: string | null }
  const entries: OPMLEntry[] = []

  // Extract a named attribute from an outline tag regardless of attribute order
  function getAttr(tag: string, name: string): string {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'))
    return m ? unescapeXml(m[1]) : ''
  }

  const processedUrls = new Set<string>()

  // Match folder outlines (outlines without xmlUrl that wrap child outlines)
  const folderRegex = /<outline(?![^>]*xmlUrl)[^>]*text="[^"]*"[^>]*>([\s\S]*?)<\/outline>/gi
  let folderMatch
  while ((folderMatch = folderRegex.exec(xml)) !== null) {
    const folderTag = folderMatch[0]
    const folder = unescapeXml(getAttr(folderTag, 'text') || getAttr(folderTag, 'title'))
    const inner = folderMatch[1]
    const feedRegex = /<outline([^>]*xmlUrl[^>]*)\/>/gi
    let feedMatch
    while ((feedMatch = feedRegex.exec(inner)) !== null) {
      const tag = feedMatch[1]
      const url = getAttr(tag, 'xmlUrl')
      const title = getAttr(tag, 'title') || getAttr(tag, 'text')
      if (url) { entries.push({ url, title, folder }); processedUrls.add(url) }
    }
  }

  // Match all remaining top-level feed outlines
  const allFeedRegex = /<outline([^>]*xmlUrl[^>]*)\/>/gi
  let feedMatch
  while ((feedMatch = allFeedRegex.exec(xml)) !== null) {
    const tag = feedMatch[1]
    const url = getAttr(tag, 'xmlUrl')
    const title = getAttr(tag, 'title') || getAttr(tag, 'text')
    if (url && !processedUrls.has(url)) entries.push({ url, title, folder: null })
  }

  if (!entries.length) return c.json({ error: 'No feeds found in OPML' }, 400)

  // Validate URLs, skip bad ones
  const valid: OPMLEntry[] = []
  const errors: string[] = []
  for (const entry of entries) {
    try { new URL(entry.url); valid.push(entry) }
    catch { errors.push(`Invalid URL: ${entry.url}`) }
  }

  if (!valid.length) return c.json({ error: 'No valid feed URLs found in OPML' }, 400)

  try {
    const CHUNK = 50

    // Batch insert all feeds
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK)
      await c.env.DB.batch(
        chunk.map(e => c.env.DB.prepare('INSERT OR IGNORE INTO feeds (url, title, refresh_interval) VALUES (?, ?, 900)').bind(e.url, e.title || null))
      )
    }

    // SELECT IDs back in chunks to avoid variable limits
    const urlToId = new Map<string, number>()
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK)
      const ph = chunk.map(() => '?').join(',')
      const rows = await c.env.DB.prepare(`SELECT id, url FROM feeds WHERE url IN (${ph})`)
        .bind(...chunk.map(e => e.url)).all<{ id: number; url: string }>()
      for (const r of rows.results) urlToId.set(r.url, r.id)
    }

    // Batch insert user_feeds subscriptions
    const toSubscribe = valid.filter(e => urlToId.has(e.url))
    for (let i = 0; i < toSubscribe.length; i += CHUNK) {
      const chunk = toSubscribe.slice(i, i + CHUNK)
      await c.env.DB.batch(
        chunk.map(e => c.env.DB.prepare('INSERT OR IGNORE INTO user_feeds (user_id, feed_id, folder) VALUES (?, ?, ?)')
          .bind(user.id, urlToId.get(e.url)!, e.folder ?? null))
      )
    }

    // Kick off a small first batch so something appears immediately
    const firstBatch = toSubscribe.slice(0, 8)
    c.executionCtx.waitUntil(
      Promise.all(firstBatch.map(e => fetchOneFeed(c.env.DB, urlToId.get(e.url)!, e.url)))
    )

    return c.json({ ok: true, imported: toSubscribe.length, failed: errors.length, errors: errors.slice(0, 10) })
  } catch (err) {
    return c.json({ error: `Import failed: ${String(err)}` }, 500)
  }
})

function unescapeXml(s: string): string {
  return s.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

export { app as opmlRoutes }

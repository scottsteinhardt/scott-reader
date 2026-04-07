import { Hono } from 'hono'
import type { Env } from '../core/types/env'
import type { User } from '../core/types/entities'
import { authMiddleware } from '../core/auth'
import { discoverFeedUrl } from '../lib/discovery'
import { fetchOneFeed } from '../lib/fetcher'

type Variables = { user: User }
const app = new Hono<{ Bindings: Env; Variables: Variables }>()
app.use('*', authMiddleware)

// GET /api/feeds — list subscribed feeds with unread counts
app.get('/', async (c) => {
  const user = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT f.id, f.url, f.title, f.description, f.site_url, f.favicon_url,
           f.last_fetched_at, f.last_error, f.error_count, f.refresh_interval,
           uf.folder, uf.custom_title,
           COUNT(a.id) FILTER (WHERE COALESCE(ua.is_read, 0) = 0) as unread_count
    FROM user_feeds uf
    JOIN feeds f ON uf.feed_id = f.id
    LEFT JOIN articles a ON a.feed_id = f.id
    LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = uf.user_id
    WHERE uf.user_id = ?
    GROUP BY f.id, uf.folder, uf.custom_title
    ORDER BY uf.folder NULLS LAST, COALESCE(uf.custom_title, f.title)
  `).bind(user.id).all()
  return c.json(rows.results)
})

// POST /api/feeds — subscribe to a feed
app.post('/', async (c) => {
  const user = c.get('user')
  const { url, folder } = await c.req.json<{ url: string; folder?: string }>()
  if (!url) return c.json({ error: 'Missing url' }, 400)

  try {
    const feedUrl = await discoverFeedUrl(url)

    await c.env.DB.prepare('INSERT OR IGNORE INTO feeds (url, refresh_interval) VALUES (?, 1800)').bind(feedUrl).run()
    const feed = await c.env.DB.prepare('SELECT id FROM feeds WHERE url = ?').bind(feedUrl).first<{ id: number }>()

    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO user_feeds (user_id, feed_id, folder) VALUES (?, ?, ?)'
    ).bind(user.id, feed!.id, folder ?? null).run()

    c.executionCtx.waitUntil(fetchOneFeed(c.env.DB, feed!.id, feedUrl))

    return c.json({ ok: true, feedId: feed!.id, url: feedUrl })
  } catch (err) {
    return c.json({ error: String(err) }, 400)
  }
})

// PATCH /api/feeds/:id — update folder, title, refresh interval
app.patch('/:id', async (c) => {
  const user = c.get('user')
  const feedId = parseInt(c.req.param('id'))
  const body = await c.req.json<{ folder?: string | null; custom_title?: string | null; refresh_interval?: number }>()

  const updates: string[] = []
  const params: unknown[] = []

  if ('folder' in body) { updates.push('uf.folder = ?'); params.push(body.folder ?? null) }
  if ('custom_title' in body) { updates.push('uf.custom_title = ?'); params.push(body.custom_title ?? null) }

  if (updates.length) {
    params.push(user.id, feedId)
    await c.env.DB.prepare(
      `UPDATE user_feeds uf SET ${updates.join(', ')} WHERE uf.user_id = ? AND uf.feed_id = ?`
    ).bind(...params).run()
  }

  if (body.refresh_interval) {
    await c.env.DB.prepare('UPDATE feeds SET refresh_interval = ? WHERE id = ?')
      .bind(body.refresh_interval, feedId).run()
  }

  return c.json({ ok: true })
})

// DELETE /api/feeds/:id — unsubscribe
app.delete('/:id', async (c) => {
  const user = c.get('user')
  const feedId = parseInt(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM user_feeds WHERE user_id = ? AND feed_id = ?')
    .bind(user.id, feedId).run()
  return c.json({ ok: true })
})

// POST /api/feeds/:id/refresh — manual refresh of one feed, waits for completion
app.post('/:id/refresh', async (c) => {
  const user = c.get('user')
  const feedId = parseInt(c.req.param('id'))
  const feed = await c.env.DB.prepare(
    'SELECT f.id, f.url FROM feeds f JOIN user_feeds uf ON uf.feed_id = f.id WHERE f.id = ? AND uf.user_id = ?'
  ).bind(feedId, user.id).first<{ id: number; url: string }>()
  if (!feed) return c.json({ error: 'Not found' }, 404)

  // Reset error state so backoffs are overridden and the feed gets a clean retry
  await c.env.DB.prepare(
    'UPDATE feeds SET next_fetch_at = 0, error_count = 0, last_error = NULL WHERE id = ?'
  ).bind(feedId).run()
  const result = await fetchOneFeed(c.env.DB, feed.id, feed.url)
  return c.json({ ok: true, newItems: result.newItems, error: result.error ?? null })
})

// POST /api/feeds/refresh-all — mark all feeds as due, return total count
app.post('/refresh-all', async (c) => {
  const user = c.get('user')
  // Also reset error state so errored/backed-off feeds are included in the refresh
  await c.env.DB.prepare(`
    UPDATE feeds SET next_fetch_at = 0, error_count = 0, last_error = NULL
    WHERE id IN (SELECT feed_id FROM user_feeds WHERE user_id = ?)
  `).bind(user.id).run()
  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM user_feeds WHERE user_id = ?'
  ).bind(user.id).first<{ n: number }>()
  return c.json({ ok: true, count: total?.n ?? 0 })
})


// POST /api/feeds/batch — bulk move to folder or unsubscribe
app.post('/batch', async (c) => {
  const user = c.get('user')
  const { ids, action, folder } = await c.req.json<{ ids: number[]; action: 'move' | 'unsubscribe'; folder?: string | null }>()
  if (!ids?.length) return c.json({ error: 'No feeds selected' }, 400)
  if (!['move', 'unsubscribe'].includes(action)) return c.json({ error: 'Invalid action' }, 400)

  const CHUNK = 50
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const ph = chunk.map(() => '?').join(',')
    if (action === 'unsubscribe') {
      await c.env.DB.prepare(
        `DELETE FROM user_feeds WHERE user_id = ? AND feed_id IN (${ph})`
      ).bind(user.id, ...chunk).run()
    } else {
      await c.env.DB.prepare(
        `UPDATE user_feeds SET folder = ? WHERE user_id = ? AND feed_id IN (${ph})`
      ).bind(folder ?? null, user.id, ...chunk).run()
    }
  }
  return c.json({ ok: true })
})

// GET /api/feeds/folders — list all folders
app.get('/folders', async (c) => {
  const user = c.get('user')
  const rows = await c.env.DB.prepare(
    'SELECT DISTINCT folder FROM user_feeds WHERE user_id = ? AND folder IS NOT NULL ORDER BY folder'
  ).bind(user.id).all<{ folder: string }>()
  return c.json(rows.results.map(r => r.folder))
})

export { app as feedRoutes }

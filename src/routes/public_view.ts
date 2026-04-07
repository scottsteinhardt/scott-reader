import { Hono } from 'hono'
import type { Env } from '../core/types/env'
import type { User } from '../core/types/entities'


const app = new Hono<{ Bindings: Env }>()

// GET /api/public/ticker — recent articles for the landing page ticker (no auth)
app.get('/ticker', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT a.title, a.url, a.published_at, f.title as feed_title, f.favicon_url
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    WHERE a.title IS NOT NULL AND a.url IS NOT NULL AND a.published_at IS NOT NULL
    ORDER BY a.published_at DESC
    LIMIT 80
  `).all()
  return c.json(rows.results)
})

// GET /api/public/:username — public read-only view data
app.get('/:username', async (c) => {
  const username = c.req.param('username')

  const user = await c.env.DB.prepare(
    'SELECT id, username, public_view_enabled FROM users WHERE username = ?'
  ).bind(username).first<{ id: number; username: string; public_view_enabled: number }>()

  if (!user || !user.public_view_enabled) {
    return c.json({ error: 'Not found' }, 404)
  }

  const feeds = await c.env.DB.prepare(`
    SELECT f.url, f.title, f.favicon_url, f.site_url, uf.folder, uf.custom_title
    FROM user_feeds uf JOIN feeds f ON uf.feed_id = f.id
    WHERE uf.user_id = ?
    ORDER BY uf.folder NULLS LAST, COALESCE(uf.custom_title, f.title)
  `).bind(user.id).all()

  const recentlyRead = await c.env.DB.prepare(`
    SELECT a.id, a.title, a.url, a.author, a.published_at, a.word_count,
           f.title as feed_title, f.url as feed_url, f.favicon_url
    FROM user_articles ua
    JOIN articles a ON ua.article_id = a.id
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ua.user_id
    WHERE ua.user_id = ? AND ua.is_read = 1
    ORDER BY ua.updated_at DESC
    LIMIT 50
  `).bind(user.id).all()

  const starred = await c.env.DB.prepare(`
    SELECT a.id, a.title, a.url, a.author, a.published_at, a.word_count,
           f.title as feed_title, f.url as feed_url, f.favicon_url
    FROM user_articles ua
    JOIN articles a ON ua.article_id = a.id
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ua.user_id
    WHERE ua.user_id = ? AND ua.is_starred = 1
    ORDER BY ua.updated_at DESC
    LIMIT 50
  `).bind(user.id).all()

  return c.json({
    username: user.username,
    feeds: feeds.results,
    recentlyRead: recentlyRead.results,
    starred: starred.results,
  })
})

export { app as publicRoutes }

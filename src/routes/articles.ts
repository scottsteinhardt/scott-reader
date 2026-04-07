import { Hono } from 'hono'
import type { Env } from '../core/types/env'
import type { User } from '../core/types/entities'
import { authMiddleware } from '../core/auth'
import { fetchFullContent } from '../lib/readability'
import { markArticlesRead, markArticlesReadByCriteria, getArticles } from '../core/db'

type Variables = { user: User }
const app = new Hono<{ Bindings: Env; Variables: Variables }>()
app.use('*', authMiddleware)

// GET /api/articles
// Query params: feed_id, folder, starred, unread_only, sort, limit, before_id, search
app.get('/', async (c) => {
  const user = c.get('user')
  const feedId = c.req.query('feed_id') ? parseInt(c.req.query('feed_id')!) : undefined
  const folder = c.req.query('folder')
  const starred = c.req.query('starred') === '1'
  const unreadOnly = c.req.query('unread_only') === '1'
  const sort = c.req.query('sort') === 'oldest' ? 'ASC' : 'DESC'
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 100)
  const beforeId = c.req.query('before_id') ? parseInt(c.req.query('before_id')!) : undefined
  const search = c.req.query('search')?.trim()

  const articles = await getArticles(c.env.DB, user.id, {
    feedId, folder, starred, unreadOnly, sort, limit, beforeId, search
  })

  return c.json(articles)
})

// GET /api/articles/counts — unread counts per feed and folder
app.get('/counts', async (c) => {
  const user = c.get('user')
  const rows = await c.env.DB.prepare(`
    SELECT f.id as feed_id, uf.folder,
           COUNT(a.id) FILTER (WHERE COALESCE(ua.is_read, 0) = 0) as unread,
           COUNT(a.id) as total
    FROM user_feeds uf
    JOIN feeds f ON uf.feed_id = f.id
    LEFT JOIN articles a ON a.feed_id = f.id
    LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = uf.user_id
    WHERE uf.user_id = ?
    GROUP BY f.id, uf.folder
  `).bind(user.id).all()

  const starred = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM user_articles WHERE user_id = ? AND is_starred = 1'
  ).bind(user.id).first<{ count: number }>()

  return c.json({ feeds: rows.results, starred: starred?.count ?? 0 })
})

// PATCH /api/articles/:id — mark read/unread, star/unstar
app.patch('/:id', async (c) => {
  const user = c.get('user')
  const articleId = parseInt(c.req.param('id'))
  const body = await c.req.json<{ is_read?: boolean; is_starred?: boolean }>()

  // Verify the article belongs to a feed the user subscribes to
  const owns = await c.env.DB.prepare(
    'SELECT 1 FROM articles a JOIN user_feeds uf ON uf.feed_id = a.feed_id WHERE a.id = ? AND uf.user_id = ?'
  ).bind(articleId, user.id).first()
  if (!owns) return c.json({ error: 'Not found' }, 404)

  await c.env.DB.prepare(`
    INSERT INTO user_articles (user_id, article_id, is_read, is_starred)
    VALUES (?, ?, COALESCE(?, 0), COALESCE(?, 0))
    ON CONFLICT(user_id, article_id) DO UPDATE SET
      is_read = CASE WHEN ? IS NOT NULL THEN ? ELSE is_read END,
      is_starred = CASE WHEN ? IS NOT NULL THEN ? ELSE is_starred END,
      updated_at = unixepoch()
  `).bind(
    user.id, articleId,
    body.is_read !== undefined ? (body.is_read ? 1 : 0) : null,
    body.is_starred !== undefined ? (body.is_starred ? 1 : 0) : null,
    body.is_read !== undefined ? 1 : null, body.is_read ? 1 : 0,
    body.is_starred !== undefined ? 1 : null, body.is_starred ? 1 : 0,
  ).run()

  return c.json({ ok: true })
})

// POST /api/articles/mark-all-read — mark all as read for feed/folder/all
app.post('/mark-all-read', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ feed_id?: number; folder?: string }>()

  const marked = await markArticlesReadByCriteria(c.env.DB, user.id, {
    feedId: body.feed_id,
    folder: body.folder
  })

  return c.json({ ok: true, marked })
})

// POST /api/articles/mark-read-batch — mark specific article IDs as read
app.post('/mark-read-batch', async (c) => {
  const user = c.get('user')
  const { ids } = await c.req.json<{ ids: number[] }>()
  if (!ids?.length) return c.json({ ok: true })

  await markArticlesRead(c.env.DB, user.id, ids)
  return c.json({ ok: true })
})

// GET /api/articles/:id/full-content — fetch/return full content
app.get('/:id/full-content', async (c) => {
  const user = c.get('user')
  const articleId = parseInt(c.req.param('id'))

  const article = await c.env.DB.prepare(`
    SELECT a.id, a.url, a.full_content
    FROM articles a
    JOIN user_feeds uf ON uf.feed_id = a.feed_id AND uf.user_id = ?
    WHERE a.id = ?
  `).bind(user.id, articleId).first<{ id: number; url: string | null; full_content: string | null }>()

  if (!article) return c.json({ error: 'Not found' }, 404)

  if (article.full_content) return c.json({ content: article.full_content })

  if (!article.url) return c.json({ error: 'No URL' }, 400)

  try {
    const extracted = await fetchFullContent(article.url)
    await c.env.DB.prepare('UPDATE articles SET full_content = ?, word_count = ? WHERE id = ?')
      .bind(extracted.content, extracted.wordCount, articleId).run()
    return c.json({ content: extracted.content })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not extract content' }, 422)
  }
})

export { app as articleRoutes }

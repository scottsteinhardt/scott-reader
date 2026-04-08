// Fever API — compatible with Reeder, ReadKit, and other Fever clients
// Endpoint: POST /fever/?api
// Auth: api_key = md5(username + ":" + password), stored in users.fever_api_key
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../core/types/env'
import type { User } from '../core/types/entities'
import { md5 } from '../core/utils'
import { markArticlesReadByCriteria } from '../core/db'
import { feverAuthMiddleware } from '../core/auth'

type Variables = { user: User }
const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use('*', feverAuthMiddleware)

// ─── Handler ──────────────────────────────────────────────────────────────────

async function feverEndpoint(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const sp = new URL(c.req.url).searchParams
  const user = c.get('user')

  // Parse POST body for mark params + optional item params
  let body: Record<string, string | File> = {}
  if (c.req.method === 'POST') {
    try { body = (await c.req.parseBody()) as typeof body } catch { /* ignore */ }
  }

  const base = { api_version: 3, auth: 1, last_refreshed_on_time: Math.floor(Date.now() / 1000) }

  await handleMarkActions(c, user.id, body, sp)

  const resp: Record<string, unknown> = { ...base }

  if (sp.has('feeds')) {
    resp.feeds = await getFeeds(c, user.id)
  }

  if (sp.has('feeds') || sp.has('groups')) {
    const { groups, feeds_groups } = await getGroups(c, user.id)
    resp.groups = groups
    resp.feeds_groups = feeds_groups
  }

  if (sp.has('items')) {
    const sinceId = parseInt(String(body.since_id ?? sp.get('since_id') ?? '0')) || 0
    const maxId   = parseInt(String(body.max_id   ?? sp.get('max_id')   ?? '0')) || 0
    const withIds = String(body.with_ids ?? sp.get('with_ids') ?? '')
    const { items, total_items } = await getItems(c, user.id, { sinceId, maxId, withIds })
    resp.items = items
    resp.total_items = total_items
  }

  if (sp.has('unread_item_ids')) {
    resp.unread_item_ids = await getUnreadItemIds(c, user.id)
  }

  if (sp.has('saved_item_ids')) {
    resp.saved_item_ids = await getSavedItemIds(c, user.id)
  }

  if (sp.has('favicons')) {
    resp.favicons = await getFavicons(c, user.id)
  }

  if (sp.has('links')) resp.links = []

  return c.json(resp)
}

/**
 * Handles 'mark' actions for items, feeds, or groups.
 */
async function handleMarkActions(c: Context<{ Bindings: Env }>, userId: number, body: Record<string, any>, sp: URLSearchParams) {
  const mark   = String(body.mark   ?? sp.get('mark')   ?? '')
  const as_    = String(body.as     ?? sp.get('as')      ?? '')
  const markId = parseInt(String(body.id     ?? sp.get('id')     ?? '0')) || 0
  const beforeRaw = parseInt(String(body.before ?? sp.get('before') ?? '0')) || 0
  // Default to now if client omits before — marks all currently-visible articles as read
  const before = beforeRaw > 0 ? beforeRaw : Math.floor(Date.now() / 1000)

  if (!mark || !as_) return

  if (mark === 'item' && markId) {
    const isRead    = as_ === 'read'    ? 1 : as_ === 'unread'   ? 0 : null
    const isStarred = as_ === 'saved'   ? 1 : as_ === 'unsaved'  ? 0 : null
    if (isRead !== null || isStarred !== null) {
      await c.env.DB.prepare(`
        INSERT INTO user_articles (user_id, article_id, is_read, is_starred)
        VALUES (?, ?, COALESCE(?, 0), COALESCE(?, 0))
        ON CONFLICT(user_id, article_id) DO UPDATE SET
          is_read    = CASE WHEN ? IS NOT NULL THEN ? ELSE is_read END,
          is_starred = CASE WHEN ? IS NOT NULL THEN ? ELSE is_starred END,
          updated_at = unixepoch()
      `).bind(userId, markId, isRead, isStarred, isRead, isRead, isStarred, isStarred).run()
    }
  } else if (as_ === 'read' && (mark === 'feed' || mark === 'group')) {
    if (mark === 'feed' && markId) {
      await markArticlesReadByCriteria(c.env.DB, userId, {
        feedId: markId,
        beforeTimestamp: before
      })
    } else if (mark === 'group') {
      let folderFilter = ''
      const extraParams: unknown[] = []

      if (markId > 0) {
        folderFilter = `AND uf.folder = (
          SELECT folder FROM (
            SELECT folder, ROW_NUMBER() OVER (ORDER BY folder) as rn
            FROM (SELECT DISTINCT folder FROM user_feeds WHERE user_id = ? AND folder IS NOT NULL)
          ) WHERE rn = ?
        )`
        extraParams.push(userId, markId)
      } else {
        folderFilter = 'AND uf.folder IS NULL'
      }

      await c.env.DB.prepare(`
        INSERT INTO user_articles (user_id, article_id, is_read, is_starred)
        SELECT ?, a.id, 1, COALESCE(ua.is_starred, 0)
        FROM articles a
        JOIN feeds f ON a.feed_id = f.id
        JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
        LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = ?
        WHERE COALESCE(a.published_at, a.fetched_at) <= ? ${folderFilter}
        ON CONFLICT(user_id, article_id) DO UPDATE SET is_read = 1, updated_at = unixepoch()
      `).bind(userId, userId, userId, before, ...extraParams).run()
    }
  }
}

async function getFeeds(c: Context<{ Bindings: Env }>, userId: number) {
  const rows = await c.env.DB.prepare(`
    SELECT f.id, f.title, f.url, f.site_url,
           COALESCE(f.last_fetched_at, 0) as last_updated_on_time
    FROM user_feeds uf
    JOIN feeds f ON uf.feed_id = f.id
    WHERE uf.user_id = ?
    ORDER BY f.id
  `).bind(userId).all<{
    id: number; title: string | null; url: string
    site_url: string | null; last_updated_on_time: number
  }>()
  
  return rows.results.map(f => ({
    id: f.id,
    favicon_id: f.id,
    title: f.title ?? f.url,
    url: f.url,
    site_url: f.site_url ?? f.url,
    is_spark: 0,
    last_updated_on_time: f.last_updated_on_time,
  }))
}

async function getGroups(c: Context<{ Bindings: Env }>, userId: number) {
  const groupRows = await c.env.DB.prepare(`
    WITH distinct_folders AS (
      SELECT DISTINCT folder FROM user_feeds WHERE user_id = ? AND folder IS NOT NULL
    ),
    folders AS (
      SELECT folder, ROW_NUMBER() OVER (ORDER BY folder) as id FROM distinct_folders
    )
    SELECT fl.id, fl.folder as title, GROUP_CONCAT(uf.feed_id) as feed_ids_csv
    FROM folders fl
    JOIN user_feeds uf ON uf.user_id = ? AND uf.folder = fl.folder
    GROUP BY fl.id, fl.folder
    ORDER BY fl.id
  `).bind(userId, userId).all<{ id: number; title: string; feed_ids_csv: string }>()

  const ungrouped = await c.env.DB.prepare(
    'SELECT GROUP_CONCAT(feed_id) as ids FROM user_feeds WHERE user_id = ? AND folder IS NULL'
  ).bind(userId).first<{ ids: string | null }>()

  return {
    groups: [
      ...(ungrouped?.ids ? [{ id: 0, title: 'All' }] : []),
      ...groupRows.results.map(g => ({ id: g.id, title: g.title })),
    ],
    feeds_groups: [
      ...(ungrouped?.ids ? [{ group_id: 0, feed_ids: ungrouped.ids }] : []),
      ...groupRows.results.map(g => ({ group_id: g.id, feed_ids: g.feed_ids_csv })),
    ]
  }
}

async function getItems(c: Context<{ Bindings: Env }>, userId: number, options: { sinceId: number, maxId: number, withIds: string }) {
  const { sinceId, maxId, withIds } = options
  let whereClause = '1=1'
  let extraParams: unknown[] = []
  let orderDir = 'DESC'

  if (withIds) {
    const ids = withIds.split(',').map(s => parseInt(s.trim())).filter(n => n > 0)
    if (ids.length) {
      whereClause = `a.id IN (${ids.map(() => '?').join(',')})`
      extraParams = ids
    }
  } else if (sinceId > 0) {
    whereClause = 'a.id > ?'
    extraParams = [sinceId]
    orderDir = 'ASC'
  } else if (maxId > 0) {
    whereClause = 'a.id < ?'
    extraParams = [maxId]
  }

  const items = await c.env.DB.prepare(`
    SELECT a.id, a.feed_id, a.title, a.author,
           a.content, a.full_content, a.url,
           COALESCE(a.published_at, a.fetched_at) as created_on_time,
           COALESCE(ua.is_read, 0) as is_read,
           COALESCE(ua.is_starred, 0) as is_starred
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
    LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = ?
    WHERE ${whereClause}
    ORDER BY a.id ${orderDir}
    LIMIT 50
  `).bind(userId, userId, ...extraParams).all<{
    id: number; feed_id: number; title: string | null; author: string | null
    content: string | null; full_content: string | null; url: string | null
    created_on_time: number; is_read: number; is_starred: number
  }>()

  const total = await c.env.DB.prepare(`
    SELECT COUNT(*) as n FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
  `).bind(userId).first<{ n: number }>()

  return {
    items: items.results.map(a => ({
      id: a.id,
      feed_id: a.feed_id,
      title: a.title ?? '',
      author: a.author ?? '',
      html: a.full_content ?? a.content ?? '',
      url: a.url ?? '',
      is_saved: a.is_starred,
      is_read: a.is_read,
      created_on_time: a.created_on_time,
    })),
    total_items: total?.n ?? 0
  }
}

async function getUnreadItemIds(c: Context<{ Bindings: Env }>, userId: number) {
  const rows = await c.env.DB.prepare(`
    SELECT a.id FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
    LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = ?
    WHERE COALESCE(ua.is_read, 0) = 0
    ORDER BY a.id
  `).bind(userId, userId).all<{ id: number }>()
  return rows.results.map(r => r.id).join(',')
}

async function getSavedItemIds(c: Context<{ Bindings: Env }>, userId: number) {
  const rows = await c.env.DB.prepare(`
    SELECT ua.article_id as id FROM user_articles ua
    JOIN articles a ON a.id = ua.article_id
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
    WHERE ua.user_id = ? AND ua.is_starred = 1
    ORDER BY ua.article_id
  `).bind(userId, userId).all<{ id: number }>()
  return rows.results.map(r => r.id).join(',')
}

async function getFavicons(c: Context<{ Bindings: Env }>, userId: number) {
  const rows = await c.env.DB.prepare(`
    SELECT f.id, f.favicon_url FROM user_feeds uf
    JOIN feeds f ON uf.feed_id = f.id
    WHERE uf.user_id = ? AND f.favicon_url IS NOT NULL
  `).bind(userId).all<{ id: number; favicon_url: string }>()
  return rows.results.map(r => ({ id: r.id, data: r.favicon_url }))
}

// Register for both /fever (no trailing slash) and /fever/ (trailing slash)
app.all('/', feverEndpoint)
app.all('/*', feverEndpoint)

export { app as feverRoutes }

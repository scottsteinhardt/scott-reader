import type { D1Database } from '@cloudflare/workers-types'
import type { MarkReadCriteria } from './types/entities'

/**
 * Marks a batch of articles as read for a specific user.
 * Handles chunking to stay within D1 parameter limits.
 * 
 * @param db - The D1 database instance
 * @param userId - ID of the user performing the action
 * @param articleIds - Array of article IDs to mark as read
 * @returns Promise resolving when all chunks are processed
 */
export async function markArticlesRead(
  db: D1Database,
  userId: number,
  articleIds: number[]
): Promise<void> {
  if (!articleIds.length) return

  const CHUNK_SIZE = 50
  for (let i = 0; i < articleIds.length; i += CHUNK_SIZE) {
    const chunk = articleIds.slice(i, i + CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    
    await db.prepare(`
      INSERT INTO user_articles (user_id, article_id, is_read, is_starred)
      SELECT ?, a.id, 1, COALESCE(ua.is_starred, 0)
      FROM articles a
      JOIN user_feeds uf ON uf.feed_id = a.feed_id AND uf.user_id = ?
      LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = ?
      WHERE a.id IN (${placeholders})
      ON CONFLICT(user_id, article_id) DO UPDATE SET 
        is_read = 1, 
        updated_at = unixepoch()
    `).bind(userId, userId, userId, ...chunk).run()
  }
}

/**
 * Criteria for marking articles as read.
 */
export interface MarkReadCriteria {
  feedId?: number
  folder?: string
  beforeTimestamp?: number
}

/**
 * Fetches articles for a user based on various criteria.
 */
export async function getArticles(
  db: D1Database,
  userId: number,
  options: {
    feedId?: number
    folder?: string
    starred?: boolean
    unreadOnly?: boolean
    sort?: 'ASC' | 'DESC'
    limit?: number
    beforeId?: number
    search?: string
  }
): Promise<any[]> {
  const { sort = 'DESC', limit = 50 } = options
  const conditions: string[] = []
  const params: unknown[] = [userId, userId]

  if (options.feedId) { conditions.push('f.id = ?'); params.push(options.feedId) }
  if (options.folder) { conditions.push('uf.folder = ?'); params.push(options.folder) }
  if (options.starred) conditions.push('COALESCE(ua.is_starred, 0) = 1')
  if (options.unreadOnly) conditions.push('COALESCE(ua.is_read, 0) = 0')
  
  if (options.beforeId) {
    conditions.push(sort === 'DESC'
      ? 'COALESCE(a.published_at, a.fetched_at) < (SELECT COALESCE(published_at, fetched_at) FROM articles WHERE id = ?)'
      : 'COALESCE(a.published_at, a.fetched_at) > (SELECT COALESCE(published_at, fetched_at) FROM articles WHERE id = ?)'
    )
    params.push(options.beforeId)
  }

  const whereClause = conditions.length ? `AND ${conditions.join(' AND ')}` : ''

  if (options.search) {
    const searchParams = [...params, options.search, ...params.slice(2), limit]
    const rows = await db.prepare(`
      SELECT a.id, a.title, a.url, a.content, a.full_content, a.author,
             a.published_at, a.word_count, a.feed_id,
             f.url as feed_url, f.title as feed_title, f.favicon_url,
             COALESCE(ua.is_read, 0) as is_read,
             COALESCE(ua.is_starred, 0) as is_starred,
             uf.folder,
             snippet(articles_fts, 0, '<mark>', '</mark>', '…', 20) as snippet
      FROM articles_fts
      JOIN articles a ON a.id = articles_fts.rowid
      JOIN feeds f ON a.feed_id = f.id
      JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
      LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = ?
      WHERE articles_fts MATCH ? ${whereClause}
      ORDER BY rank
      LIMIT ?
    `).bind(...searchParams).all()
    return rows.results
  }

  const rows = await db.prepare(`
    SELECT a.id, a.title, a.url, a.content, a.full_content, a.author,
           a.published_at, a.word_count, a.feed_id,
           f.url as feed_url, f.title as feed_title, f.favicon_url,
           COALESCE(ua.is_read, 0) as is_read,
           COALESCE(ua.is_starred, 0) as is_starred,
           uf.folder,
           NULL as snippet
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
    LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = ?
    WHERE 1=1 ${whereClause}
    ORDER BY COALESCE(a.published_at, a.fetched_at) ${sort}, a.id ${sort}
    LIMIT ?
  `).bind(...params, limit).all()
  
  return rows.results
}

/**
 * Marks articles as read based on criteria like feed_id or folder.
 */
export async function markArticlesReadByCriteria(
  db: D1Database,
  userId: number,
  criteria: MarkReadCriteria
): Promise<number> {
  const conditions: string[] = []
  const params: unknown[] = [userId, userId, userId]

  if (criteria.feedId) {
    conditions.push('f.id = ?')
    params.push(criteria.feedId)
  }
  if (criteria.folder) {
    conditions.push('uf.folder = ?')
    params.push(criteria.folder)
  }
  if (criteria.beforeTimestamp) {
    conditions.push('COALESCE(a.published_at, a.fetched_at) <= ?')
    params.push(criteria.beforeTimestamp)
  }

  const whereClause = conditions.length ? `AND ${conditions.join(' AND ')}` : ''

  const result = await db.prepare(`
    INSERT INTO user_articles (user_id, article_id, is_read, is_starred)
    SELECT ?, a.id, 1, COALESCE(ua.is_starred, 0)
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN user_feeds uf ON uf.feed_id = f.id AND uf.user_id = ?
    LEFT JOIN user_articles ua ON ua.article_id = a.id AND ua.user_id = ?
    WHERE COALESCE(ua.is_read, 0) = 0 ${whereClause}
    ON CONFLICT(user_id, article_id) DO UPDATE SET 
      is_read = 1, 
      updated_at = unixepoch()
  `).bind(userId, userId, userId, ...params.slice(3)).run()

  return result.meta.changes
}

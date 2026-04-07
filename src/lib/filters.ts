import type { UserFilter } from '../core/types/entities'
import type { ParsedItem } from '../core/types/parser'

/**
 * Checks if a parsed item matches a specific user filter.
 * 
 * @param filter - The user filter configuration
 * @param item - The parsed article item to check
 * @param feedId - ID of the feed the item belongs to
 * @param folder - Optional folder name for scoped filters
 * @returns True if the item matches the filter criteria
 */
export function matchesFilter(filter: UserFilter, item: ParsedItem, feedId: number, folder: string | null): boolean {
  // Scope check
  if (filter.feed_id !== null && filter.feed_id !== feedId) return false
  if (filter.folder !== null && filter.folder !== folder) return false

  const keyword = filter.keyword.toLowerCase()
  const field = filter.match_field

  let target = ''
  if (field === 'title') target = item.title.toLowerCase()
  else if (field === 'content') target = item.content.toLowerCase()
  else if (field === 'author') target = item.author.toLowerCase()
  else if (field === 'any') target = `${item.title} ${item.content} ${item.author}`.toLowerCase()

  return target.includes(keyword)
}

/**
 * Fetches user filters and applies them to a newly discovered article.
 * Updates user_articles table if a filter matches.
 * 
 * @param db - The D1 database instance
 * @param userId - ID of the user whose filters should be applied
 * @param articleId - ID of the article to filter
 * @param item - Parsed item data for keyword matching
 * @param feedId - ID of the feed the article belongs to
 * @param folder - Folder the feed belongs to for this user
 */
export async function applyFilters(db: D1Database, userId: number, articleId: number, item: ParsedItem, feedId: number, folder: string | null): Promise<void> {

  const filters = await db.prepare(
    'SELECT * FROM user_filters WHERE user_id = ?'
  ).bind(userId).all<UserFilter>()

  if (!filters.results.length) return

  let markRead = false
  let markStarred = false

  for (const filter of filters.results) {
    if (!matchesFilter(filter, item, feedId, folder)) continue
    if (filter.action === 'mark_read') markRead = true
    if (filter.action === 'star') markStarred = true
  }

  if (!markRead && !markStarred) return

  await db.prepare(`
    INSERT INTO user_articles (user_id, article_id, is_read, is_starred)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, article_id) DO UPDATE SET
      is_read = CASE WHEN ? THEN 1 ELSE is_read END,
      is_starred = CASE WHEN ? THEN 1 ELSE is_starred END,
      updated_at = unixepoch()
  `).bind(userId, articleId, markRead ? 1 : 0, markStarred ? 1 : 0, markRead, markStarred).run()
}

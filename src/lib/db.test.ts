import { describe, it, expect, vi } from 'vitest'
import { markArticlesRead, markArticlesReadByCriteria } from '../core/db'
import type { D1Database } from '@cloudflare/workers-types'

describe('db helpers', () => {
  const mockDb = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
  } as unknown as D1Database

  describe('markArticlesRead', () => {
    it('handles empty ID array', async () => {
      await markArticlesRead(mockDb, 1, [])
      expect(mockDb.prepare).not.toHaveBeenCalled()
    })

    it('chunks large batches', async () => {
      const ids = Array.from({ length: 75 }, (_, i) => i + 1)
      await markArticlesRead(mockDb, 1, ids)
      
      // Should call prepare twice (chunk size 50)
      expect(mockDb.prepare).toHaveBeenCalledTimes(2)
      // First chunk: 50 placeholders + 3 userId params
      expect(mockDb.bind).toHaveBeenNthCalledWith(1, 1, 1, 1, ...ids.slice(0, 50))
      // Second chunk: 25 placeholders + 3 userId params
      expect(mockDb.bind).toHaveBeenNthCalledWith(2, 1, 1, 1, ...ids.slice(50))
    })
  })

  describe('markArticlesReadByCriteria', () => {
    it('builds query with all criteria', async () => {
      vi.clearAllMocks()
      await markArticlesReadByCriteria(mockDb, 1, {
        feedId: 10,
        folder: 'News',
        beforeTimestamp: 12345
      })

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('f.id = ?'))
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('uf.folder = ?'))
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('COALESCE(a.published_at, a.fetched_at) <= ?'))
      expect(mockDb.bind).toHaveBeenCalledWith(1, 1, 1, 10, 'News', 12345)
    })

    it('builds query with no criteria', async () => {
      vi.clearAllMocks()
      await markArticlesReadByCriteria(mockDb, 1, {})
      expect(mockDb.bind).toHaveBeenCalledWith(1, 1, 1)
    })
  })
})

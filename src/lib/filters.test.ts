import { describe, it, expect } from 'vitest'
import { matchesFilter } from './filters'
import type { UserFilter } from '../core/types/entities'
import type { ParsedItem } from '../core/types/parser'

describe('filters', () => {
  const mockItem: ParsedItem = {
    guid: '1',
    title: 'Hello World',
    content: 'This is a test article about coding.',
    author: 'John Doe',
    url: 'https://example.com/1',
    publishedAt: new Date()
  }

  const baseFilter: UserFilter = {
    id: 1,
    user_id: 1,
    name: 'Test Filter',
    match_field: 'title',
    keyword: 'hello',
    feed_id: null,
    folder: null,
    action: 'mark_read'
  }

  it('matches keyword in title', () => {
    expect(matchesFilter(baseFilter, mockItem, 1, null)).toBe(true)
    expect(matchesFilter({ ...baseFilter, keyword: 'world' }, mockItem, 1, null)).toBe(true)
    expect(matchesFilter({ ...baseFilter, keyword: 'missing' }, mockItem, 1, null)).toBe(false)
  })

  it('matches keyword in content', () => {
    const filter = { ...baseFilter, match_field: 'content', keyword: 'coding' }
    expect(matchesFilter(filter, mockItem, 1, null)).toBe(true)
  })

  it('matches keyword in author', () => {
    const filter = { ...baseFilter, match_field: 'author', keyword: 'john' }
    expect(matchesFilter(filter, mockItem, 1, null)).toBe(true)
  })

  it('matches "any" field', () => {
    const filter = { ...baseFilter, match_field: 'any' }
    expect(matchesFilter({ ...filter, keyword: 'world' }, mockItem, 1, null)).toBe(true)
    expect(matchesFilter({ ...filter, keyword: 'test' }, mockItem, 1, null)).toBe(true)
    expect(matchesFilter({ ...filter, keyword: 'doe' }, mockItem, 1, null)).toBe(true)
  })

  it('respects feed_id constraint', () => {
    expect(matchesFilter({ ...baseFilter, feed_id: 1 }, mockItem, 1, null)).toBe(true)
    expect(matchesFilter({ ...baseFilter, feed_id: 2 }, mockItem, 1, null)).toBe(false)
  })

  it('respects folder constraint', () => {
    expect(matchesFilter({ ...baseFilter, folder: 'Tech' }, mockItem, 1, 'Tech')).toBe(true)
    expect(matchesFilter({ ...baseFilter, folder: 'Tech' }, mockItem, 1, 'News')).toBe(false)
    expect(matchesFilter({ ...baseFilter, folder: 'Tech' }, mockItem, 1, null)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { parseFeed } from './parser'

describe('parser', () => {
  describe('RSS 2.0', () => {
    it('parses a basic RSS 2.0 feed', () => {
      const xml = `
        <rss version="2.0">
          <channel>
            <title>Test Feed</title>
            <link>https://example.com</link>
            <description>A test feed</description>
            <item>
              <title>Item 1</title>
              <link>https://example.com/1</link>
              <description>Content 1</description>
              <guid>guid1</guid>
              <pubDate>Mon, 06 Apr 2026 12:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>
      `
      const parsed = parseFeed(xml, 'https://example.com/feed.xml')
      expect(parsed.title).toBe('Test Feed')
      expect(parsed.items).toHaveLength(1)
      expect(parsed.items[0].title).toBe('Item 1')
      expect(parsed.items[0].guid).toBe('guid1')
      expect(parsed.items[0].publishedAt?.getFullYear()).toBe(2026)
    })
  })

  describe('Atom', () => {
    it('parses a basic Atom feed', () => {
      const xml = `
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Atom Feed</title>
          <subtitle>Test Atom</subtitle>
          <link href="https://example.com"/>
          <entry>
            <title>Entry 1</title>
            <link href="https://example.com/e1"/>
            <id>id1</id>
            <content type="html">Atom Content</content>
            <published>2026-04-06T12:00:00Z</published>
          </entry>
        </feed>
      `
      const parsed = parseFeed(xml, 'https://example.com/atom.xml')
      expect(parsed.title).toBe('Atom Feed')
      expect(parsed.items).toHaveLength(1)
      expect(parsed.items[0].title).toBe('Entry 1')
      expect(parsed.items[0].guid).toBe('id1')
    })
  })

  describe('JSON Feed', () => {
    it('parses a basic JSON feed', () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON Feed",
        home_page_url: "https://example.com",
        items: [
          {
            id: "j1",
            title: "JSON Item 1",
            content_html: "<p>Hello</p>",
            url: "https://example.com/j1"
          }
        ]
      })
      const parsed = parseFeed(json, 'https://example.com/feed.json')
      expect(parsed.title).toBe('JSON Feed')
      expect(parsed.items).toHaveLength(1)
      expect(parsed.items[0].title).toBe('JSON Item 1')
      expect(parsed.items[0].guid).toBe('j1')
    })
  })

  describe('Sanitization', () => {
    it('handles HTML entities in XML', () => {
      const xml = `
        <rss version="2.0">
          <channel>
            <title>Test &amp; &nbsp; &mdash;</title>
            <item>
              <title>Item</title>
              <guid>1</guid>
            </item>
          </channel>
        </rss>
      `
      const parsed = parseFeed(xml, 'url')
      expect(parsed.title).toContain('Test &')
      expect(parsed.title).toContain('\u00A0') // nbsp
      expect(parsed.title).toContain('\u2014') // mdash
    })

    it('rejects HTML content', () => {
      const html = '<!DOCTYPE html><html><body>Not a feed</body></html>'
      expect(() => parseFeed(html, 'url')).toThrow('Got HTML instead of a feed')
    })
  })
})

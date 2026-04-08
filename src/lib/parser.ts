import { XMLParser } from 'fast-xml-parser'
import type { ParsedFeed, ParsedItem } from '../core/types/parser'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
  allowBooleanAttributes: true,
  parseTagValue: false,
  processEntities: false, // we handle entities in sanitizeXml before parsing
})

// Common HTML entities not in the XML spec that appear in real-world RSS feeds
const HTML_ENTITIES: Record<string, string> = {
  nbsp: '\u00A0', mdash: '\u2014', ndash: '\u2013', ldquo: '\u201C', rdquo: '\u201D',
  lsquo: '\u2018', rsquo: '\u2019', hellip: '\u2026', copy: '\u00A9', reg: '\u00AE',
  trade: '\u2122', euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2',
  laquo: '\u00AB', raquo: '\u00BB', middot: '\u00B7', bull: '\u2022', prime: '\u2032',
  Prime: '\u2033', larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  harr: '\u2194', times: '\u00D7', divide: '\u00F7', plusmn: '\u00B1', frac12: '\u00BD',
  frac14: '\u00BC', frac34: '\u00BE', sup2: '\u00B2', sup3: '\u00B3', deg: '\u00B0',
  acute: '\u00B4', micro: '\u00B5', para: '\u00B6', cedil: '\u00B8', ordm: '\u00BA',
  ordf: '\u00AA', szlig: '\u00DF', agrave: '\u00E0', aacute: '\u00E1', acirc: '\u00E2',
  atilde: '\u00E3', auml: '\u00E4', aring: '\u00E5', aelig: '\u00E6', ccedil: '\u00E7',
  egrave: '\u00E8', eacute: '\u00E9', ecirc: '\u00EA', euml: '\u00EB', igrave: '\u00EC',
  iacute: '\u00ED', icirc: '\u00EE', iuml: '\u00EF', eth: '\u00F0', ntilde: '\u00F1',
  ograve: '\u00F2', oacute: '\u00F3', ocirc: '\u00F4', otilde: '\u00F5', ouml: '\u00F6',
  oslash: '\u00F8', ugrave: '\u00F9', uacute: '\u00FA', ucirc: '\u00FB', uuml: '\u00FC',
  yacute: '\u00FD', thorn: '\u00FE', yuml: '\u00FF', Agrave: '\u00C0', Aacute: '\u00C1',
  Acirc: '\u00C2', Atilde: '\u00C3', Auml: '\u00C4', Aring: '\u00C5', AElig: '\u00C6',
  Ccedil: '\u00C7', Egrave: '\u00C8', Eacute: '\u00C9', Ecirc: '\u00CA', Euml: '\u00CB',
  Igrave: '\u00CC', Iacute: '\u00CD', Icirc: '\u00CE', Iuml: '\u00CF', ETH: '\u00D0',
  Ntilde: '\u00D1', Ograve: '\u00D2', Oacute: '\u00D3', Ocirc: '\u00D4', Otilde: '\u00D5',
  Ouml: '\u00D6', Oslash: '\u00D8', Ugrave: '\u00D9', Uacute: '\u00DA', Ucirc: '\u00DB',
  Uuml: '\u00DC', Yacute: '\u00DD', THORN: '\u00DE',
}

function sanitizeXml(xml: string): string {
  // Strip UTF-8 BOM
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1)

  // Strip XML declaration if charset is specified but content is already a JS string
  // (avoids parser confusion on declared encodings)
  xml = xml.replace(/^<\?xml[^?]*\?>\s*/i, (m) => m)

  // Remove control characters that are invalid in XML (except tab, newline, carriage return)
  // eslint-disable-next-line no-control-regex
  xml = xml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

  // Decode numeric entities (&#123; or &#x1A;) to actual characters
  xml = xml.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
  })
  xml = xml.replace(/&#([0-9]+);/g, (_, dec) => {
    try { return String.fromCodePoint(parseInt(dec, 10)) } catch { return '' }
  })

  // Replace named HTML entities that aren't valid XML entities
  // Keep &amp; &lt; &gt; &quot; &apos; as-is (the XML parser needs these)
  xml = xml.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => {
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return match
    return HTML_ENTITIES[name] ?? match
  })

  // Replace any remaining bare & that aren't part of a valid entity (would break the parser)
  xml = xml.replace(/&(?![a-zA-Z#])/g, '&amp;')

  return xml
}

function getText(val: unknown): string {
  if (!val) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'object' && val !== null) {
    if ('#text' in val) return String((val as Record<string, unknown>)['#text'] ?? '')
    if ('__cdata' in val) return String((val as Record<string, unknown>)['__cdata'] ?? '')
  }
  return String(val)
}

function parseDate(val: unknown): Date | null {
  if (!val) return null
  const str = getText(val)
  if (!str) return null
  const d = new Date(str)
  return isNaN(d.getTime()) ? null : d
}

function getAtomLink(links: unknown[]): string {
  if (!Array.isArray(links)) return ''
  // prefer alternate
  const alt = links.find(l => {
    const rel = (l as Record<string, string>)?.['@_rel']
    return !rel || rel === 'alternate'
  })
  const target = alt ?? links[0]
  if (!target) return ''
  return (target as Record<string, string>)?.['@_href'] ?? getText(target)
}

/**
 * Parses an RSS, Atom, or JSON feed from an XML/JSON string.
 * Handles content sanitization and normalization into a standard ParsedFeed structure.
 * 
 * @param xml - The raw feed content (XML or JSON string)
 * @param feedUrl - The URL of the feed (used for error reporting)
 * @returns A normalized ParsedFeed object
 * @throws {Error} If the content is HTML, the format is unrecognized, or parsing fails
 */
export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  // Reject HTML responses (error pages, paywalls, redirects that landed on HTML)
  const trimmed = xml.trimStart()
  if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html/i.test(trimmed)) {
    throw new Error('Got HTML instead of a feed')
  }

  // JSON Feed (https://www.jsonfeed.org/)
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed)
      if (json.version?.includes('jsonfeed.org') || json.items) {
        return parseJsonFeed(json)
      }
    } catch {
      // fall through to XML parser
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parser.parse(sanitizeXml(xml)) as Record<string, unknown>
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // fast-xml-parser can throw internal JS errors (e.g. "Cannot read properties of undefined")
    // on severely malformed XML — surface a clean error either way
    throw new Error(`Invalid XML: ${msg}`)
  }

  // Atom feed
  if (parsed.feed) {
    return parseAtom(parsed.feed as Record<string, unknown>)
  }

  // RSS 2.0 or RSS 1.0
  if (parsed.rss) {
    const rss = parsed.rss as Record<string, unknown>
    const channel = rss.channel as Record<string, unknown>
    return parseRSS(channel)
  }

  // RSS 1.0 (RDF)
  if (parsed['rdf:RDF']) {
    const rdf = parsed['rdf:RDF'] as Record<string, unknown>
    const channel = rdf.channel as Record<string, unknown>
    const items = (rdf.item ?? []) as unknown[]
    return parseRSS({ ...channel, item: items })
  }

  throw new Error(`Unrecognized feed format from ${feedUrl}`)
}

function parseRSS(channel: Record<string, unknown>): ParsedFeed {
  if (!channel) throw new Error('Invalid RSS feed: missing channel element')
  const rawItems = (channel.item ?? []) as unknown[]
  const items: ParsedItem[] = rawItems.map(raw => {
    const item = raw as Record<string, unknown>
    const guid = getText(item.guid) || getText(item.link) || getText(item.title) || ''
    const content = getText(item['content:encoded']) || getText(item.description) || ''
    return {
      guid,
      title: getText(item.title),
      url: getText(item.link),
      content,
      author: getText(item.author) || getText(item['dc:creator']) || '',
      publishedAt: parseDate(item.pubDate) ?? parseDate(item['dc:date']),
    }
  }).filter(i => i.guid)

  return {
    title: getText(channel.title),
    description: getText(channel.description),
    siteUrl: getText(channel.link),
    items,
  }
}

function parseAtom(feed: Record<string, unknown>): ParsedFeed {
  if (!feed) throw new Error('Invalid Atom feed: missing feed element')
  const rawEntries = (feed.entry ?? []) as unknown[]
  const items: ParsedItem[] = rawEntries.map(raw => {
    const entry = raw as Record<string, unknown>
    const links = (entry.link ?? []) as unknown[]
    const url = getAtomLink(links)
    const guid = getText(entry.id) || url || getText(entry.title) || ''
    const mediaGroup = entry['media:group'] as Record<string, unknown> | undefined
    const content = getText((entry.content as Record<string, unknown>)?.['#text'])
      || getText(entry.content)
      || getText(entry.summary)
      || getText(mediaGroup?.['media:description'])
      || ''
    const authorObj = entry.author as Record<string, unknown> | undefined
    return {
      guid,
      title: getText(entry.title) || getText(mediaGroup?.['media:title']) || '',
      url,
      content,
      author: getText(authorObj?.name) || getText(entry.author) || '',
      publishedAt: parseDate(entry.published) ?? parseDate(entry.updated),
    }
  }).filter(i => i.guid)

  const feedLinks = (feed.link ?? []) as unknown[]
  return {
    title: getText(feed.title),
    description: getText(feed.subtitle) || getText(feed.description) || '',
    siteUrl: getAtomLink(feedLinks),
    items,
  }
}

function parseJsonFeed(json: Record<string, unknown>): ParsedFeed {
  if (!json || typeof json !== 'object') throw new Error('Invalid JSON feed')
  const rawItems = (json.items ?? []) as Record<string, unknown>[]
  const items: ParsedItem[] = rawItems.map(item => {
    const guid = String(item.id ?? item.url ?? item.title ?? '')
    const content = String(item.content_html ?? item.content_text ?? item.summary ?? '')
    const authorObj = item.author as Record<string, unknown> | undefined
    const authors = item.authors as Record<string, unknown>[] | undefined
    const author = String(authorObj?.name ?? authors?.[0]?.name ?? '')
    return {
      guid,
      title: String(item.title ?? ''),
      url: String(item.url ?? item.external_url ?? ''),
      content,
      author,
      publishedAt: parseDate(item.date_published) ?? parseDate(item.date_modified),
    }
  }).filter(i => i.guid)

  return {
    title: String(json.title ?? ''),
    description: String(json.description ?? ''),
    siteUrl: String(json.home_page_url ?? ''),
    items,
  }
}

export interface ParsedFeed {
  title: string
  description: string
  siteUrl: string
  items: ParsedItem[]
}

export interface ParsedItem {
  guid: string
  title: string
  url: string
  content: string
  author: string
  publishedAt: Date | null
}

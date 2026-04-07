export interface User {
  id: number
  username: string
  public_view_enabled: number
  is_admin: number
  theme: string
  accent_color: string
  article_view: string
}

export interface Feed {
  id: number
  url: string
  title: string | null
  description: string | null
  site_url: string | null
  favicon_url: string | null
  last_fetched_at: number | null
  last_error: string | null
  error_count: number
  next_fetch_at: number
  refresh_interval: number
}

export interface UserFeed extends Feed {
  folder: string | null
  custom_title: string | null
  unread_count?: number
}

export interface Article {
  id: number
  feed_id: number
  guid: string
  title: string | null
  url: string | null
  content: string | null
  full_content: string | null
  author: string | null
  published_at: number | null
  fetched_at: number
  word_count: number
}

export interface UserArticle extends Article {
  is_read: number
  is_starred: number
  feed_title: string | null
  feed_url: string
  feed_favicon: string | null
  folder: string | null
}

export interface UserFilter {
  id: number
  user_id: number
  name: string
  match_field: string
  keyword: string
  feed_id: number | null
  folder: string | null
  action: string
}

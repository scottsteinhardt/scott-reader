-- Users
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  public_view_enabled INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'system',
  accent_color TEXT NOT NULL DEFAULT '#2563eb',
  article_view TEXT NOT NULL DEFAULT 'comfortable',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Shared feed registry (deduped by URL)
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  description TEXT,
  site_url TEXT,
  favicon_url TEXT,
  last_fetched_at INTEGER,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  next_fetch_at INTEGER NOT NULL DEFAULT 0,
  refresh_interval INTEGER NOT NULL DEFAULT 900,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Per-user feed subscriptions
CREATE TABLE IF NOT EXISTS user_feeds (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  folder TEXT,
  custom_title TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, feed_id)
);

-- Articles (shared across users)
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT,
  url TEXT,
  content TEXT,
  full_content TEXT,
  author TEXT,
  published_at INTEGER,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  word_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(feed_id, guid)
);

-- Per-user article state
CREATE TABLE IF NOT EXISTS user_articles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, article_id)
);

-- User filter rules (auto mark-read / star)
CREATE TABLE IF NOT EXISTS user_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  match_field TEXT NOT NULL DEFAULT 'title',
  keyword TEXT NOT NULL,
  feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
  folder TEXT,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Auth tokens (for GReader API sessions)
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  content,
  author,
  content=articles,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- FTS triggers to keep index in sync
CREATE TRIGGER IF NOT EXISTS articles_fts_insert AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, content, author)
  VALUES (new.id, new.title, new.content, new.author);
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_delete AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, content, author)
  VALUES ('delete', old.id, old.title, old.content, old.author);
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_update AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, content, author)
  VALUES ('delete', old.id, old.title, old.content, old.author);
  INSERT INTO articles_fts(rowid, title, content, author)
  VALUES (new.id, new.title, new.content, new.author);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_articles_feed_published ON articles(feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_articles_user_read ON user_articles(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_user_articles_user_starred ON user_articles(user_id, is_starred);
CREATE INDEX IF NOT EXISTS idx_user_feeds_user ON user_feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch ON feeds(next_fetch_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);

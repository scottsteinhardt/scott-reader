# Scott Reader

A self-hosted RSS reader that runs entirely on **Cloudflare's free tier** — no server, no Docker, no VPS, no monthly bill. Built with Cloudflare Workers, D1 (SQLite at the edge), and a zero-dependency vanilla JS frontend.

## What makes this different

Most self-hosted RSS readers (Miniflux, FreshRSS, Tiny Tiny RSS) require a Linux server, a database process, and ongoing maintenance. Scott Reader runs as a serverless edge function with a managed SQLite database. The total infrastructure cost is $0.

- **No server to maintain.** Cloudflare Workers handles all compute.
- **No database to manage.** D1 is Cloudflare's serverless SQLite — fully managed, zero ops.
- **Cron-based background fetching** runs every minute via Workers triggers, refreshing up to 45 feeds per tick within free-tier limits.
- **Fever API compatible.** Works out of the box with [Reeder](https://reederapp.com/), [NetNewsWire](https://netnewswire.com/), and any other Fever-compatible client on iOS/macOS.
- **Multi-user.** Each user has their own feeds, folders, read state, stars, and filters — while sharing the underlying article storage so a feed is only fetched once regardless of how many users subscribe.
- **Full-text search** powered by SQLite FTS5 with Porter stemming.

---

## Features

### Reading
- RSS, Atom, and JSON Feed support
- Automatic full-content extraction for thin articles (Readability)
- Comfortable, compact, and magazine article density views
- Reader mode for distraction-free reading
- Keyboard shortcuts (`j/k` next/prev, `m` mark read, `s` star, `o` open, `r` refresh)
- Article font family and size controls

### Organisation
- Folders with click-to-browse and per-folder mark-all-read
- Unread Only view (sidebar shortcut)
- Starred articles
- Hide feeds with no unread (sidebar declutter toggle)
- OPML import and export

### Mark as read
- Mark all as read (with optional confirmation prompt)
- Right-click any article → **Mark above as read** / **Mark below as read**
- **Mark as read when scrolled past** (auto-read on scroll, toggle in settings)
- Per-folder mark-all-read from sidebar

### Filters
- Rule-based filters: match on title, content, author, or any field
- Scoped to a feed, folder, or all feeds
- Actions: auto mark-read or auto-star

### Sync
- **Fever API** at `/fever/` — compatible with Reeder 5, NetNewsWire, Unread, and more
- Background cron fetches every 15 minutes per feed
- Manual per-feed and refresh-all available from the UI

### Multi-user
- Admin (first registered user) creates and deletes accounts
- Each user has independent feeds, folders, read/starred state, and filters
- Shared article storage: one fetch serves all subscribers
- Optional public reading profile (`/u/username`)

### Customisation
- Light, dark, and system themes
- Accent colour picker
- Article font family (system, serif, mono) and size
- UI font size
- Sidebar width and article list width
- Sort order (newest/oldest)

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| Database | Cloudflare D1 (SQLite) |
| Routing | [Hono](https://hono.dev/) |
| Frontend | Vanilla JS, no build step |
| Feed parsing | Custom RSS/Atom/JSON Feed parser |
| Content extraction | Readability (Mozilla algorithm) |
| Full-text search | SQLite FTS5 with Porter stemming |
| Auth | PBKDF2-SHA256 password hashing, bearer tokens |
| Sync protocol | Fever API (MD5 key auth) |

---

## Deployment

### Prerequisites
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Node.js](https://nodejs.org/) and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Steps

```bash
git clone https://github.com/scottsteinhardt/scott-reader
cd scott-reader
npm install
```

Create a D1 database:
```bash
npx wrangler d1 create scott-reader
```

Update `wrangler.toml` with the returned `database_id`.

Run migrations:
```bash
npx wrangler d1 execute scott-reader --file=migrations/0001_initial.sql
npx wrangler d1 execute scott-reader --file=migrations/0002_fever_api_key.sql
```

Deploy:
```bash
npx wrangler deploy
```

Visit your Worker's URL, create your account (first registration is open, subsequent ones require admin login), and start adding feeds.

### Connecting a Fever client

In Reeder, NetNewsWire, or any Fever-compatible app:

- **Server:** `https://your-domain.com/fever/`
- **Username:** your Scott Reader username
- **Password:** your Scott Reader password

---

## Cloudflare free tier limits

Scott Reader is designed to stay within the free tier:

| Limit | Free tier | How we stay within it |
|---|---|---|
| Worker requests | 100K/day | Normal reading generates ~50–200 req/day per user |
| Worker CPU | 10ms/HTTP request | Article fetches are capped at 30 items; word count capped at 20K chars |
| D1 reads | 5M/day | Indexed queries; counts cached in sidebar |
| D1 writes | 100K/day | Write-only on new articles and state changes |
| Cron CPU | 30s/invocation | Cron batches 45 feeds/tick with full content extraction |

For larger feed lists, a [$5/month Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) removes the CPU constraints.

---

## Architecture notes

**Feed deduplication.** Feeds are stored once in a shared `feeds` table. `user_feeds` is a join table — subscribing links a user to a feed without duplicating it. If two users subscribe to the Guardian, it's fetched once and both see the same articles with independent read/starred state.

**Cron scheduling.** Each feed has a `next_fetch_at` timestamp. The cron fires every minute, picks the 45 most overdue feeds, fetches them, and updates `next_fetch_at = now + refresh_interval` (default 15 minutes). This naturally load-balances across the minute boundary.

**Full-text search.** Articles are indexed in an FTS5 virtual table via insert/delete/update triggers. Search queries use Porter stemming so "running" matches "run".

**Content extraction.** When a feed item's content is under 200 characters, the worker fetches the full article URL and runs it through a Readability pass to extract the main content. This is stored separately as `full_content` so the original feed content is preserved.

---

## License

MIT

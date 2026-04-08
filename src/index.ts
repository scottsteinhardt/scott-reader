import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './core/types/env'
import { feverRoutes } from './routes/fever'
import { feedRoutes } from './routes/feeds'
import { articleRoutes } from './routes/articles'
import { opmlRoutes } from './routes/opml'
import { userRoutes } from './routes/users'
import { publicRoutes } from './routes/public_view'
import { scheduledFetch, fetchOneDue } from './lib/fetcher'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}))

// Fever API
app.route('/fever', feverRoutes)

// REST API
app.route('/api/feeds', feedRoutes)
app.route('/api/articles', articleRoutes)
app.route('/api/opml', opmlRoutes)
app.route('/api/users', userRoutes)
app.route('/api/public', publicRoutes)

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

// GitHub Actions: fetch one overdue feed per call (each call = its own CPU budget)
app.post('/api/admin/fetch-one', async (c) => {
  const secret = c.req.header('x-trigger-secret')
  if (!secret || secret !== c.env.TRIGGER_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const result = await fetchOneDue(c.env.DB)
  return c.json(result)
})

// External cron trigger (GitHub Actions backup)
app.post('/api/admin/trigger-fetch', async (c) => {
  const secret = c.req.header('x-trigger-secret')
  if (!secret || secret !== c.env.TRIGGER_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.executionCtx.waitUntil(scheduledFetch(c.env.DB))
  return c.json({ ok: true })
})

// Static assets — serve index.html for SPA routes (no file extension)
app.get('*', async (c) => {
  const url = new URL(c.req.url)
  // If path has a file extension, serve it directly (js, css, ico, png, etc.)
  if (/\.[a-zA-Z0-9]+$/.test(url.pathname)) {
    return c.env.ASSETS.fetch(c.req.raw)
  }
  // SPA route — serve index.html so client-side JS handles it
  const indexUrl = new URL('/', c.req.url)
  return c.env.ASSETS.fetch(new Request(indexUrl.toString(), c.req.raw))
})

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(fetch(
      'https://api.github.com/repos/scottsteinhardt/scott-reader/actions/workflows/fetch-trigger.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'scott-reader-worker',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    ))
  },
}

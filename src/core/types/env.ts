export interface Env {
  DB: D1Database
  JWT_SECRET: string
  TRIGGER_SECRET: string
  GITHUB_TOKEN: string
  ASSETS: Fetcher
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { userRoutes } from './users'
import type { User } from '../core/types/entities'

vi.mock('../auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 1, username: 'admin', is_admin: 1 } as User)
    await next()
  },
  createPasswordHash: vi.fn().mockResolvedValue('salt:hash'),
  verifyPassword: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue('mock-token'),
  getUserFromToken: vi.fn(),
  extractToken: vi.fn()
}))

describe('User Routes', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono().route('/api/users', userRoutes)
  })

  it('GET /api/users/me returns current user', async () => {
    const res = await app.request('/api/users/me')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.username).toBe('admin')
  })

  it('GET /api/users/list returns user list for admin', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [{ id: 1, username: 'admin', is_admin: 1 }] })
    }
    
    // Inject mock DB into context
    const res = await app.request('/api/users/list', {}, { DB: mockDb } as any)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveLength(1)
    expect(data[0].username).toBe('admin')
  })
})

export interface AuthUser {
  id: string
  email: string
  name?: string
  role: 'admin' | 'user'
}

export interface AuthSession {
  authenticated: boolean
  setupRequired?: boolean
  user?: AuthUser
  generatedPassword?: string
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    },
    ...init
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(data?.error || response.statusText)
  }
  return data as T
}

export function getSession(): Promise<AuthSession> {
  return request<AuthSession>('/api/auth/session')
}

export function login(password: string, email?: string): Promise<AuthSession> {
  return request<AuthSession>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  })
}

export function setupAdmin(input: {
  mode: 'random' | 'custom'
  password?: string
  email?: string
}): Promise<AuthSession> {
  return request<AuthSession>('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export function logout(): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/auth/logout', { method: 'POST' })
}

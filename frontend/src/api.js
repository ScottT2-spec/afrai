const BASE = import.meta.env.VITE_API_URL || 'https://scott-123-afrai.hf.space'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`)
  return data
}

export function register(name, email) {
  return request('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email }),
  })
}

export function completion(messages, apiKey) {
  return request('/v1/completion', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ messages }),
  })
}

export function getTiers() {
  return request('/v1/payments/tiers')
}

export function getBalance(apiKey) {
  return request('/v1/wallet/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
}

export function health() {
  return request('/health')
}

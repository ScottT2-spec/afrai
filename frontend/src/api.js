const BASE = import.meta.env.VITE_API_URL || 'https://scott-123-afrai.hf.space'

async function request(path, options = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    })
  } catch (networkErr) {
    throw new Error('Network error — check your connection or try again')
  }

  let data
  try {
    data = await res.json()
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return {}
  }

  if (!res.ok) {
    const errField = data?.error
    const msg =
      typeof data === 'string'
        ? data
        : data?.detail
          || (typeof errField === 'string' ? errField : errField?.message)
          || data?.message
          || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

// Auth — OTP flow
export function sendOtp(email, name) {
  return request('/v1/auth/send-otp', {
    method: 'POST',
    body: JSON.stringify({ email, ...(name ? { name } : {}) }),
  })
}

export function verifyOtp(email, code, name) {
  return request('/v1/auth/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ email, code, ...(name ? { name } : {}) }),
  })
}

// Legacy register (still works)
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

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { register } from '../api'

export default function Register() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const data = await register(name, email)
      setResult(data)
      // Store API key for dashboard
      if (data.apiKey || data.api_key) {
        localStorage.setItem('afrai_api_key', data.apiKey || data.api_key)
        localStorage.setItem('afrai_tenant_name', name)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mx-auto max-w-md px-6 py-20">
      <h1 className="mb-2 text-3xl font-bold">Get Your API Key</h1>
      <p className="mb-8 text-afr-muted">Free tier — no credit card required.</p>

      {!result ? (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Name / Org</label>
            <input
              type="text"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Alpha Global Minds"
              className="w-full rounded-lg border border-afr-border bg-afr-card px-4 py-3 text-white placeholder-afr-muted outline-none transition-colors focus:border-afr-green"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-afr-border bg-afr-card px-4 py-3 text-white placeholder-afr-muted outline-none transition-colors focus:border-afr-green"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-afr-green py-3 text-lg font-bold text-white transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-afr-green/20 disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Free Account'}
          </button>
        </form>
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border border-afr-green/30 bg-afr-green/10 p-6">
            <p className="mb-1 text-sm font-medium text-afr-green">✅ You're in!</p>
            <p className="text-sm text-afr-muted">Your API key:</p>
            <code className="mt-2 block break-all rounded-lg bg-afr-dark px-4 py-3 text-sm text-afr-gold">
              {result.apiKey || result.api_key}
            </code>
            <p className="mt-3 text-xs text-afr-muted">
              Save this — it won't be shown again.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              to="/dashboard"
              className="flex-1 rounded-lg bg-afr-green py-2 text-center font-semibold text-white transition-all hover:bg-afr-green/80"
            >
              Go to Dashboard
            </Link>
            <a
              href="https://scott-123-afrai.hf.space/docs"
              target="_blank"
              rel="noreferrer"
              className="flex-1 rounded-lg border border-afr-border py-2 text-center font-semibold text-gray-300 transition-all hover:border-afr-gold hover:text-afr-gold"
            >
              API Docs ↗
            </a>
          </div>
        </div>
      )}
    </section>
  )
}

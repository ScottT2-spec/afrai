import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { completion, getBalance, health } from '../api'

export default function Dashboard() {
  const navigate = useNavigate()
  const apiKey = localStorage.getItem('afrai_api_key')
  const tenantName = localStorage.getItem('afrai_tenant_name') || 'Developer'

  const [balance, setBalance] = useState(null)
  const [apiStatus, setApiStatus] = useState('checking')
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [showKeyInput, setShowKeyInput] = useState(false)
  const [manualKey, setManualKey] = useState('')

  function handleSetKey(e) {
    e.preventDefault()
    if (manualKey.trim()) {
      localStorage.setItem('afrai_api_key', manualKey.trim())
      window.location.reload()
    }
  }

  useEffect(() => {
    if (!apiKey) {
      navigate('/register')
      return
    }

    // Check API health
    health()
      .then(() => setApiStatus('online'))
      .catch(() => setApiStatus('offline'))

    // Fetch balance (endpoint may not exist yet)
    getBalance(apiKey)
      .then(data => setBalance(data))
      .catch(() => setBalance({ balance: 'N/A' }))
  }, [apiKey, navigate])

  async function handleTest(e) {
    e.preventDefault()
    if (!prompt.trim()) return
    setLoading(true)
    setError('')
    setResponse('')
    try {
      const data = await completion(
        [{ role: 'user', content: prompt }],
        apiKey
      )
      setResponse(
        data.choices?.[0]?.message?.content ||
        data.content ||
        JSON.stringify(data, null, 2)
      )
    } catch (err) {
      setError(typeof err === 'string' ? err : err?.message || 'Request failed — try again')
    } finally {
      setLoading(false)
    }
  }

  function handleLogout() {
    localStorage.removeItem('afrai_api_key')
    localStorage.removeItem('afrai_tenant_name')
    navigate('/')
  }

  return (
    <section className="mx-auto max-w-4xl px-6 py-12">
      {/* Header */}
      <div className="mb-10 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-afr-muted">Welcome back, {tenantName}</p>
        </div>
        <button
          onClick={handleLogout}
          className="rounded-lg border border-afr-border px-4 py-2 text-sm text-gray-400 transition-colors hover:border-red-500 hover:text-red-400"
        >
          Logout
        </button>
      </div>

      {/* Status Cards */}
      <div className="mb-10 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-afr-border bg-afr-card p-5">
          <p className="text-sm text-afr-muted">API Status</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                apiStatus === 'online'
                  ? 'bg-afr-green'
                  : apiStatus === 'offline'
                  ? 'bg-red-500'
                  : 'bg-yellow-500 animate-pulse'
              }`}
            />
            {apiStatus === 'online'
              ? 'Online'
              : apiStatus === 'offline'
              ? 'Offline'
              : 'Checking...'}
          </p>
        </div>

        <div className="rounded-xl border border-afr-border bg-afr-card p-5">
          <p className="text-sm text-afr-muted">Balance</p>
          <p className="mt-1 text-lg font-semibold text-afr-gold">
            {balance
              ? balance.balance === 'N/A'
                ? 'Free Tier'
                : `$${(balance.balance_usd ?? balance.balance ?? 0).toFixed(2)}`
              : '—'}
          </p>
        </div>

        <div className="rounded-xl border border-afr-border bg-afr-card p-5">
          <p className="text-sm text-afr-muted">Your API Key</p>
          <p className="mt-1 truncate font-mono text-sm text-gray-300">
            {apiKey ? `${apiKey.slice(0, 16)}...` : '—'}
          </p>
          <button
            onClick={() => setShowKeyInput(!showKeyInput)}
            className="mt-2 text-xs text-afr-muted hover:text-afr-gold transition-colors"
          >
            Change key
          </button>
          {showKeyInput && (
            <form onSubmit={handleSetKey} className="mt-2 flex gap-2">
              <input
                value={manualKey}
                onChange={e => setManualKey(e.target.value)}
                placeholder="afr_live_..."
                className="flex-1 rounded border border-afr-border bg-afr-dark px-2 py-1 text-xs text-white outline-none focus:border-afr-green"
              />
              <button type="submit" className="rounded bg-afr-green px-2 py-1 text-xs font-semibold text-white">
                Set
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Playground */}
      <div className="rounded-xl border border-afr-border bg-afr-card p-6">
        <h2 className="mb-4 text-xl font-bold">🧪 Playground</h2>
        <form onSubmit={handleTest} className="space-y-4">
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Type a prompt to test the API..."
            rows={3}
            className="w-full resize-none rounded-lg border border-afr-border bg-afr-dark px-4 py-3 text-white placeholder-afr-muted outline-none transition-colors focus:border-afr-green"
          />
          <button
            type="submit"
            disabled={loading || !prompt.trim()}
            className="rounded-xl bg-afr-green px-6 py-2.5 font-semibold text-white transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-afr-green/20 disabled:opacity-50"
          >
            {loading ? 'Routing...' : 'Send →'}
          </button>
        </form>

        {error && (
          <div className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {response && (
          <div className="mt-4 rounded-lg border border-afr-border bg-afr-dark p-4">
            <p className="mb-2 text-xs font-medium text-afr-muted">Response</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-200">
              {response}
            </p>
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="mt-8 flex flex-wrap gap-3">
        <a
          href="https://scott-123-afrai.hf.space/docs"
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-afr-border px-4 py-2 text-sm text-gray-300 transition-all hover:border-afr-gold hover:text-afr-gold"
        >
          📄 API Docs
        </a>
        <a
          href="https://github.com/ScottT2-spec/afrai"
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-afr-border px-4 py-2 text-sm text-gray-300 transition-all hover:border-afr-gold hover:text-afr-gold"
        >
          🐙 GitHub
        </a>
      </div>
    </section>
  )
}

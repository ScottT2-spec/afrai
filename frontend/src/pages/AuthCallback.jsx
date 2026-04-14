import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function AuthCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [status, setStatus] = useState('processing')

  useEffect(() => {
    const apiKey = searchParams.get('api_key')
    const name = searchParams.get('name') || ''
    const email = searchParams.get('email') || ''
    const isNew = searchParams.get('new_account') === 'true'
    const isExisting = searchParams.get('existing') === 'true'

    if (apiKey) {
      // New account — save key and go to dashboard
      localStorage.setItem('afrai_api_key', apiKey)
      localStorage.setItem('afrai_tenant_name', name || email.split('@')[0])
      setStatus('success')
      setTimeout(() => navigate('/dashboard'), 1500)
    } else if (isExisting) {
      // Existing account — they already have a key
      localStorage.setItem('afrai_tenant_name', name || email.split('@')[0])
      setStatus('existing')
      setTimeout(() => navigate('/dashboard'), 2000)
    } else {
      setStatus('error')
    }
  }, [searchParams, navigate])

  return (
    <section className="mx-auto max-w-md px-6 py-20 text-center">
      {status === 'processing' && (
        <>
          <div className="mb-6 text-5xl animate-spin">⚡</div>
          <h1 className="mb-2 text-2xl font-bold">Signing you in...</h1>
          <p className="text-afr-muted">Hang tight.</p>
        </>
      )}

      {status === 'success' && (
        <>
          <div className="mb-6 text-5xl">🎉</div>
          <h1 className="mb-2 text-3xl font-bold">Welcome to AfrAI!</h1>
          <p className="mb-4 text-afr-muted">Your account is ready. Redirecting to dashboard...</p>
          <p className="text-xs text-afr-muted">
            Your API key has been saved. You can find it in the dashboard.
          </p>
        </>
      )}

      {status === 'existing' && (
        <>
          <div className="mb-6 text-5xl">👋</div>
          <h1 className="mb-2 text-3xl font-bold">Welcome back!</h1>
          <p className="mb-4 text-afr-muted">
            Signed in successfully. Enter your API key in the dashboard.
          </p>
          <button
            onClick={() => navigate('/dashboard')}
            className="mt-4 rounded-xl bg-afr-green px-8 py-3 font-bold text-white transition-all hover:scale-[1.02]"
          >
            Go to Dashboard →
          </button>
        </>
      )}

      {status === 'error' && (
        <>
          <div className="mb-6 text-5xl">😕</div>
          <h1 className="mb-2 text-3xl font-bold">Something went wrong</h1>
          <p className="mb-6 text-afr-muted">
            Google sign-in didn't complete. Try again or use email instead.
          </p>
          <button
            onClick={() => navigate('/auth')}
            className="rounded-xl bg-afr-green px-8 py-3 font-bold text-white transition-all hover:scale-[1.02]"
          >
            Back to Sign In
          </button>
        </>
      )}
    </section>
  )
}

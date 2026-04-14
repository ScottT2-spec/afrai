import { useState, useRef, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { sendOtp, verifyOtp } from '../api'

export default function Auth() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isSignUp = searchParams.get('mode') !== 'signin'

  const googleError = searchParams.get('error')

  const [step, setStep] = useState('email') // email | otp | success
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [countdown, setCountdown] = useState(0)

  const inputRefs = useRef([])

  // Countdown timer for resend
  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  // Auto-focus first OTP input
  useEffect(() => {
    if (step === 'otp' && inputRefs.current[0]) {
      inputRefs.current[0].focus()
    }
  }, [step])

  async function handleSendOtp(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await sendOtp(email, isSignUp ? name : undefined)
      setStep('otp')
      setCountdown(60)
    } catch (err) {
      setError(err?.message || 'Failed to send verification code')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOtp(code) {
    setError('')
    setLoading(true)
    try {
      const data = await verifyOtp(email, code, isSignUp ? name : undefined)
      setResult(data)
      if (data.api_key || data.apiKey) {
        localStorage.setItem('afrai_api_key', data.api_key || data.apiKey)
        localStorage.setItem('afrai_tenant_name', name || data.name || email.split('@')[0])
      }
      setStep('success')
    } catch (err) {
      setError(err?.message || 'Invalid code')
      setOtp(['', '', '', '', '', ''])
      if (inputRefs.current[0]) inputRefs.current[0].focus()
    } finally {
      setLoading(false)
    }
  }

  function handleOtpChange(index, value) {
    if (value.length > 1) value = value.slice(-1)
    if (value && !/^\d$/.test(value)) return

    const newOtp = [...otp]
    newOtp[index] = value
    setOtp(newOtp)

    // Auto-advance
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus()
    }

    // Auto-submit when all 6 digits entered
    if (value && index === 5) {
      const code = newOtp.join('')
      if (code.length === 6) {
        handleVerifyOtp(code)
      }
    }
  }

  function handleOtpKeyDown(index, e) {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  function handleOtpPaste(e) {
    const paste = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (paste.length === 6) {
      e.preventDefault()
      const newOtp = paste.split('')
      setOtp(newOtp)
      inputRefs.current[5]?.focus()
      handleVerifyOtp(paste)
    }
  }

  async function handleResend() {
    if (countdown > 0) return
    setError('')
    setLoading(true)
    try {
      await sendOtp(email, isSignUp ? name : undefined)
      setCountdown(60)
    } catch (err) {
      setError(err?.message || 'Failed to resend code')
    } finally {
      setLoading(false)
    }
  }

  function handleGoogleAuth() {
    const apiBase = import.meta.env.VITE_API_URL || 'https://scott-123-afrai.hf.space'
    window.location.href = `${apiBase}/v1/auth/google`
  }

  // ===== EMAIL STEP =====
  if (step === 'email') {
    return (
      <section className="mx-auto max-w-md px-6 py-20">
        <h1 className="mb-2 text-3xl font-bold">
          {isSignUp ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="mb-8 text-afr-muted">
          {isSignUp
            ? 'Start building with AI in minutes.'
            : 'Sign in to your AfrAI account.'}
        </p>

        {/* Google error banner */}
        {googleError && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-4 py-2 text-sm text-red-400">
            {googleError === 'access_denied'
              ? 'Google sign-in was cancelled.'
              : `Google sign-in failed: ${googleError.replace(/_/g, ' ')}`}
          </p>
        )}

        {/* Google Auth */}
        <button
          onClick={handleGoogleAuth}
          className="mb-6 flex w-full items-center justify-center gap-3 rounded-xl border border-afr-border bg-afr-card px-4 py-3 font-medium text-white transition-all hover:border-afr-gold hover:bg-afr-card/80"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Continue with Google
        </button>

        <div className="mb-6 flex items-center gap-4">
          <div className="h-px flex-1 bg-afr-border" />
          <span className="text-sm text-afr-muted">or</span>
          <div className="h-px flex-1 bg-afr-border" />
        </div>

        {/* Email form */}
        <form onSubmit={handleSendOtp} className="space-y-4">
          {isSignUp && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Name
              </label>
              <input
                type="text"
                required={isSignUp}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your name or org"
                className="w-full rounded-lg border border-afr-border bg-afr-card px-4 py-3 text-white placeholder-afr-muted outline-none transition-colors focus:border-afr-green"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">
              Email
            </label>
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
            <p className="rounded-lg bg-red-500/10 px-4 py-2 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-afr-green py-3 text-lg font-bold text-white transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-afr-green/20 disabled:opacity-50"
          >
            {loading ? 'Sending code...' : 'Continue'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-afr-muted">
          {isSignUp ? (
            <>
              Already have an account?{' '}
              <a href="/auth?mode=signin" className="text-afr-green hover:underline">
                Sign in
              </a>
            </>
          ) : (
            <>
              Don't have an account?{' '}
              <a href="/auth?mode=signup" className="text-afr-green hover:underline">
                Sign up
              </a>
            </>
          )}
        </p>
      </section>
    )
  }

  // ===== OTP STEP =====
  if (step === 'otp') {
    return (
      <section className="mx-auto max-w-md px-6 py-20">
        <h1 className="mb-2 text-3xl font-bold">Check your email</h1>
        <p className="mb-8 text-afr-muted">
          We sent a 6-digit code to{' '}
          <span className="font-medium text-white">{email}</span>
        </p>

        {/* OTP Inputs */}
        <div className="mb-6 flex justify-center gap-3" onPaste={handleOtpPaste}>
          {otp.map((digit, i) => (
            <input
              key={i}
              ref={el => (inputRefs.current[i] = el)}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={e => handleOtpChange(i, e.target.value)}
              onKeyDown={e => handleOtpKeyDown(i, e)}
              className="h-14 w-12 rounded-lg border border-afr-border bg-afr-card text-center text-2xl font-bold text-white outline-none transition-all focus:border-afr-green focus:ring-1 focus:ring-afr-green"
            />
          ))}
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-4 py-2 text-center text-sm text-red-400">
            {error}
          </p>
        )}

        {loading && (
          <p className="mb-4 text-center text-sm text-afr-muted">Verifying...</p>
        )}

        <div className="text-center">
          <button
            onClick={handleResend}
            disabled={countdown > 0}
            className="text-sm text-afr-muted transition-colors hover:text-afr-green disabled:cursor-not-allowed"
          >
            {countdown > 0
              ? `Resend code in ${countdown}s`
              : 'Resend code'}
          </button>
        </div>

        <button
          onClick={() => { setStep('email'); setOtp(['','','','','','']); setError('') }}
          className="mt-4 block w-full text-center text-sm text-afr-muted hover:text-white"
        >
          ← Use a different email
        </button>
      </section>
    )
  }

  // ===== SUCCESS STEP =====
  return (
    <section className="mx-auto max-w-md px-6 py-20 text-center">
      <div className="mb-6 text-5xl">🎉</div>
      <h1 className="mb-2 text-3xl font-bold">You're in!</h1>
      <p className="mb-6 text-afr-muted">
        Your account is ready. Here's your API key:
      </p>

      <code className="mb-2 block break-all rounded-xl border border-afr-green/30 bg-afr-green/10 px-4 py-3 text-sm text-afr-gold">
        {result?.api_key || result?.apiKey}
      </code>
      <p className="mb-8 text-xs text-afr-muted">
        Save this — you won't see it again.
      </p>

      <button
        onClick={() => navigate('/dashboard')}
        className="w-full rounded-xl bg-afr-green py-3 text-lg font-bold text-white transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-afr-green/20"
      >
        Go to Dashboard →
      </button>
    </section>
  )
}

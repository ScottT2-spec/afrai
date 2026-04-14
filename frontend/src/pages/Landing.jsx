import { Link } from 'react-router-dom'

const features = [
  {
    icon: '🧠',
    title: 'Smart Model Routing',
    desc: 'Automatically selects the best AI model based on your prompt — fast, cheap, or powerful.',
  },
  {
    icon: '🔗',
    title: 'Multi-Provider',
    desc: 'One API, many providers. Seamless fallback across OpenAI, Anthropic, Mistral and more.',
  },
  {
    icon: '📱',
    title: 'Mobile Money Payments',
    desc: 'Pay with MTN MoMo, Vodafone Cash, AirtelTigo — built for African wallets.',
  },
  {
    icon: '🛡️',
    title: 'Circuit Breaker',
    desc: 'Automatic failover keeps your app running even when upstream providers go down.',
  },
  {
    icon: '⚡',
    title: 'Semantic Caching',
    desc: 'Similar queries hit cache first — lower latency, lower cost, same quality.',
  },
  {
    icon: '🌐',
    title: 'Offline-First Ready',
    desc: 'Designed for Africa\'s connectivity reality. Queue requests and sync when back online.',
  },
]

export default function Landing() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-afr-green/10 via-transparent to-afr-gold/5" />
        <div className="relative mx-auto max-w-6xl px-6 py-28 text-center">
          <h1 className="text-5xl font-extrabold leading-tight tracking-tight md:text-7xl">
            AI Infrastructure{' '}
            <span className="bg-gradient-to-r from-afr-green to-afr-gold bg-clip-text text-transparent">
              for Africa
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-afr-muted">
            One API for intelligent model routing, multi-provider failover, and Mobile Money billing.
            Built on the continent, for the continent. 🌍
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              to="/auth?mode=signup"
              className="rounded-xl bg-afr-green px-8 py-3 text-lg font-bold text-white shadow-lg shadow-afr-green/20 transition-all hover:scale-105 hover:shadow-afr-green/40"
            >
              Get Started Free
            </Link>
            <Link
              to="/pricing"
              className="rounded-xl border border-afr-border px-8 py-3 text-lg font-medium text-gray-300 transition-all hover:border-afr-gold hover:text-afr-gold"
            >
              View Pricing
            </Link>
          </div>

          {/* Quick code preview */}
          <div className="mx-auto mt-16 max-w-xl overflow-hidden rounded-xl border border-afr-border bg-afr-card text-left">
            <div className="flex items-center gap-2 border-b border-afr-border px-4 py-2">
              <span className="h-3 w-3 rounded-full bg-red-500" />
              <span className="h-3 w-3 rounded-full bg-yellow-500" />
              <span className="h-3 w-3 rounded-full bg-green-500" />
              <span className="ml-2 text-xs text-afr-muted">curl</span>
            </div>
            <pre className="overflow-x-auto p-4 text-sm leading-relaxed text-gray-300">
{`curl https://api.afrai.dev/v1/completion \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -d '{"messages": [{"role": "user",
       "content": "Hello from Accra!"}]}'`}
            </pre>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-12 text-center text-3xl font-bold">
          Why <span className="text-afr-gold">Afr</span><span className="text-afr-green">AI</span>?
        </h2>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map(f => (
            <div
              key={f.title}
              className="rounded-xl border border-afr-border bg-afr-card p-6 transition-all hover:border-afr-green/50 hover:shadow-lg hover:shadow-afr-green/5"
            >
              <div className="mb-3 text-3xl">{f.icon}</div>
              <h3 className="mb-2 text-lg font-semibold text-white">{f.title}</h3>
              <p className="text-sm leading-relaxed text-afr-muted">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-afr-border bg-gradient-to-b from-afr-card to-afr-dark py-20 text-center">
        <h2 className="text-3xl font-bold">Ready to build?</h2>
        <p className="mt-4 text-afr-muted">Get your free API key in seconds. No credit card required.</p>
        <Link
          to="/auth?mode=signup"
          className="mt-8 inline-block rounded-xl bg-afr-gold px-8 py-3 text-lg font-bold text-afr-dark transition-all hover:scale-105"
        >
          Start Building →
        </Link>
      </section>
    </>
  )
}

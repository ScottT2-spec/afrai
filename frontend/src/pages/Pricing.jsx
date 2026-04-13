import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getTiers } from '../api'

const fallbackTiers = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    features: [
      '1,000 requests/month',
      'Smart model routing',
      'Community support',
      '3 models available',
    ],
    cta: 'Get Started',
    highlight: false,
  },
  {
    name: 'Growth',
    price: '$19',
    period: '/month',
    features: [
      '50,000 requests/month',
      'All models + priority routing',
      'Semantic caching',
      'Email support',
      'Mobile Money payments',
    ],
    cta: 'Start Building',
    highlight: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    features: [
      'Unlimited requests',
      'Dedicated infrastructure',
      'SLA guarantee',
      'Custom model fine-tuning',
      'Priority support + Slack channel',
      'Data sovereignty options',
    ],
    cta: 'Contact Us',
    highlight: false,
  },
]

export default function Pricing() {
  const [tiers, setTiers] = useState(fallbackTiers)

  useEffect(() => {
    getTiers()
      .then(data => {
        if (Array.isArray(data) && data.length > 0) setTiers(data)
      })
      .catch(() => {}) // keep fallback
  }, [])

  return (
    <section className="mx-auto max-w-5xl px-6 py-20">
      <h1 className="mb-4 text-center text-4xl font-bold">
        Simple, Transparent Pricing
      </h1>
      <p className="mb-14 text-center text-afr-muted">
        Start free. Scale when you're ready. Pay with Mobile Money or card.
      </p>

      <div className="grid gap-6 md:grid-cols-3">
        {tiers.map(tier => (
          <div
            key={tier.name}
            className={`relative rounded-2xl border p-8 transition-all ${
              tier.highlight
                ? 'border-afr-green bg-afr-green/5 shadow-lg shadow-afr-green/10'
                : 'border-afr-border bg-afr-card'
            }`}
          >
            {tier.highlight && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-afr-green px-4 py-1 text-xs font-bold text-white">
                POPULAR
              </span>
            )}
            <h3 className="text-lg font-semibold text-white">{tier.name}</h3>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-white">{tier.price}</span>
              {tier.period && (
                <span className="text-afr-muted">{tier.period}</span>
              )}
            </div>
            <ul className="mt-6 space-y-3">
              {tier.features.map(f => (
                <li key={f} className="flex items-start gap-2 text-sm text-gray-300">
                  <span className="mt-0.5 text-afr-green">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <Link
              to="/register"
              className={`mt-8 block rounded-xl py-3 text-center font-semibold transition-all hover:scale-[1.02] ${
                tier.highlight
                  ? 'bg-afr-green text-white shadow-lg shadow-afr-green/20'
                  : 'border border-afr-border text-gray-300 hover:border-afr-gold hover:text-afr-gold'
              }`}
            >
              {tier.cta}
            </Link>
          </div>
        ))}
      </div>

      <div className="mt-16 rounded-xl border border-afr-border bg-afr-card p-8 text-center">
        <h3 className="text-xl font-bold">🇬🇭 Pay with Mobile Money</h3>
        <p className="mt-2 text-afr-muted">
          MTN MoMo • Vodafone Cash • AirtelTigo Money — first AI API to accept African mobile wallets.
        </p>
      </div>
    </section>
  )
}

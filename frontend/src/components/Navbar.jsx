import { Link, useLocation } from 'react-router-dom'

const links = [
  { to: '/', label: 'Home' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/dashboard', label: 'Dashboard' },
]

export default function Navbar() {
  const { pathname } = useLocation()
  const hasKey = !!localStorage.getItem('afrai_api_key')

  return (
    <nav className="sticky top-0 z-50 border-b border-afr-border bg-afr-dark/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2 text-xl font-bold">
          <span className="text-afr-gold">Afr</span>
          <span className="text-afr-green">AI</span>
        </Link>

        <div className="flex items-center gap-6">
          {links.map(l => (
            <Link
              key={l.to}
              to={l.to}
              className={`text-sm font-medium transition-colors hover:text-afr-gold ${
                pathname === l.to ? 'text-afr-gold' : 'text-gray-400'
              }`}
            >
              {l.label}
            </Link>
          ))}
          {hasKey ? (
            <Link
              to="/dashboard"
              className="rounded-lg bg-afr-green px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-afr-green/80"
            >
              Dashboard
            </Link>
          ) : (
            <div className="flex items-center gap-3">
              <Link
                to="/auth?mode=signin"
                className="text-sm font-medium text-gray-400 transition-colors hover:text-white"
              >
                Sign in
              </Link>
              <Link
                to="/auth?mode=signup"
                className="rounded-lg bg-afr-green px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-afr-green/80"
              >
                Get Started
              </Link>
            </div>
          )}
        </div>
      </div>
    </nav>
  )
}

import { Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import Landing from './pages/Landing'
import Auth from './pages/Auth'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import Pricing from './pages/Pricing'

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/pricing" element={<Pricing />} />
          {/* Legacy route */}
          <Route path="/register" element={<Auth />} />
        </Routes>
      </main>
      <footer className="border-t border-afr-border py-6 text-center text-sm text-afr-muted">
        © 2025 AfrAI · Alpha Global Minds · Built for Africa 🌍
      </footer>
    </div>
  )
}

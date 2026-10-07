import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/context'
import { Layout } from './components/Layout'
import { LiveProvider } from './live/LiveProvider'
import { AlertsPage } from './pages/AlertsPage'
import { DevicePage } from './pages/DevicePage'
import { LoginPage } from './pages/LoginPage'
import { OverviewPage } from './pages/OverviewPage'
import { PersonsPage } from './pages/PersonsPage'

// ECharts pèse lourd : chargé seulement à l'ouverture de l'historique.
const HistoryPage = lazy(() => import('./pages/HistoryPage').then((m) => ({ default: m.HistoryPage })))

export default function App() {
  const { user } = useAuth()
  if (!user) return <LoginPage />

  return (
    <LiveProvider key={user.id}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<OverviewPage />} />
            <Route path="alertes" element={<AlertsPage />} />
            <Route
              path="historique"
              element={
                <Suspense fallback={<p className="text-sm text-muted">Chargement…</p>}>
                  <HistoryPage />
                </Suspense>
              }
            />
            <Route path="personnes" element={<PersonsPage />} />
            <Route path="boitier" element={<DevicePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </LiveProvider>
  )
}

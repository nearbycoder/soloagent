import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DashboardLayout } from './components/layout/dashboard-layout'
import { ThemeProvider } from './components/layout/theme-provider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <DashboardLayout />
    </ThemeProvider>
  </StrictMode>
)

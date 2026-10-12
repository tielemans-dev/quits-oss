// SYNTHETIC FIXTURE. Imports the actual OSS route components and app stylesheet.
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../../src/lib/i18n/react'
import { applyTheme } from '../../../src/lib/theme'
import { Route as Login } from '../../../src/routes/login'
import { Route as Forgot } from '../../../src/routes/forgot-password'
import { Route as Reset } from '../../../src/routes/reset-password'
import { SignupPage } from '../../../src/routes/signup'
import './styles.css'

applyTheme()
const pages = { '/login': Login, '/forgot-password': Forgot, '/reset-password': Reset }
const page = pages[window.location.pathname as keyof typeof pages]
// The fixture's router adapter exposes the same route component, without app boot/database setup.
const Page = page ? (page as unknown as { component: React.ComponentType }).component : SignupPage
createRoot(document.getElementById('root')!).render(<I18nProvider><Page /></I18nProvider>)

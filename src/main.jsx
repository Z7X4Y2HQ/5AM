import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

if (window.location.hostname === 'localhost') {
  const canonicalUrl = new URL(window.location.href)
  canonicalUrl.hostname = '127.0.0.1'
  const savedClientId = window.localStorage.getItem('aftertone-spotify-client-id')
  if (savedClientId && !canonicalUrl.hash) canonicalUrl.hash = `spotify-client-id=${encodeURIComponent(savedClientId)}`
  window.location.replace(canonicalUrl.href)
} else {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// Primeiro de tudo: guarda o retorno do link de confirmação de e-mail antes
// de o supabase-js limpar a URL (src/lib/authRedirect.js).
import '@/lib/authRedirect'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

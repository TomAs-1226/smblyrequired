import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Note: intentionally not using <StrictMode>. Its double-invoke in development
// would mount Lenis and GSAP timelines twice, causing janky duplicate motion.
createRoot(document.getElementById('root')).render(<App />)

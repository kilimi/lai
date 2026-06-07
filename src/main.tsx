import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { installDemoBackend, shouldEnableDemoMode } from './demo/demoBackend'

if (shouldEnableDemoMode()) {
  installDemoBackend();
}

createRoot(document.getElementById("root")!).render(<App />);

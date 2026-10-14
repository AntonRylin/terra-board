import { createRoot } from 'react-dom/client';
import App from './App';
import GuestApp from './GuestApp';
import './styles.css';
import './liquid-glass.css';
import './night-mode.css';
import { initializeAppearance } from './appearance';
initializeAppearance();
// A browser opening /live is visiting a board someone shares from their computer.
const guest = !window.canvas && location.pathname.startsWith('/live');
createRoot(document.getElementById('root')!).render(guest ? <GuestApp /> : <App />);

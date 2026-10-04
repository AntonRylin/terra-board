import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './liquid-glass.css';
import './night-mode.css';
import { initializeAppearance } from './appearance';
initializeAppearance();
createRoot(document.getElementById('root')!).render(<App />);

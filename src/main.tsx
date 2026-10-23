import { createRoot } from 'react-dom/client';
import App from './App';
import GuestApp from './GuestApp';
import './styles.css';
import './liquid-glass.css';
import './night-mode.css';
import { initializeAppearance } from './appearance';
import { loadBundledFonts } from './fonts';
import { android } from './bridge';
import { MobileGate, startMobile } from './mobile/platform';
initializeAppearance();
// A browser opening /live is visiting a board someone shares from their computer.
const guest = !window.canvas && location.pathname.startsWith('/live');
// Android opens its storage worker first (docs/android.md).
if (android) document.documentElement.classList.add('android');
const storage = android ? startMobile() : Promise.resolve();
// The board draws text onto a canvas, which never waits for a web font.
Promise.all([loadBundledFonts(), storage]).then(
  () =>
    createRoot(document.getElementById('root')!).render(
      guest ? (
        <GuestApp />
      ) : (
        <MobileGate>
          <App />
        </MobileGate>
      ),
    ),
  (e) => {
    const message = document.querySelector('#startup-screen p');
    if (message) message.textContent = String(e?.message || e);
  },
);

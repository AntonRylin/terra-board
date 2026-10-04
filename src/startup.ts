export function finishStartup() {
  const screen = document.getElementById('startup-screen');
  if (!screen || screen.hasAttribute('data-ready')) return;
  // Keep the overlay through the first painted canvas frame, then reveal the app.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      document.getElementById('root')?.removeAttribute('inert');
      document.getElementById('root')?.setAttribute('aria-busy', 'false');
      screen.setAttribute('data-ready', '');
      setTimeout(() => screen.remove(), 250);
    }),
  );
}

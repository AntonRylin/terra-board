// Fonts bundled with the app. Canvas text is drawn once and cached, and a
// canvas never waits for a web font, so they are loaded before the first draw.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';

// One character from each alphabet whose part of the font should be ready:
// Latin, Latin extended, Cyrillic, Cyrillic extended, Greek.
const sample = 'AaĀāЯяҐґΩω';

export function loadBundledFonts() {
  const loads = ['normal', 'italic'].map((style) =>
    document.fonts.load(`${style} 400 16px "Inter Variable"`, sample),
  );
  // A missing font must never keep the app from opening.
  const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
  return Promise.race([Promise.all(loads), timeout]).catch(() => {});
}

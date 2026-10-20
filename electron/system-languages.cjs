// The app ships only Chromium's English locale (package.json electronLanguages),
// so Chromium's own guesses would always say English. Websites and the
// spellchecker get the system's preferred languages instead.
const tag = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const validTags = (languages) =>
  (Array.isArray(languages) ? languages : []).filter((l) => typeof l === 'string' && tag.test(l));

// Accept-Language for websites.
const acceptLanguages = (languages) => [...new Set(validTags(languages))].slice(0, 10).join(',');

// Spellcheck dictionaries for the preferred languages: the exact tag, else the
// base language ('ru-RU' -> 'ru'), else a regional variant ('de-AT' -> 'de-DE').
function spellcheckLanguages(preferred, available) {
  const dictionaries = Array.isArray(available) ? available : [];
  const chosen = [];
  for (const language of validTags(preferred)) {
    const base = language.split('-')[0];
    const match =
      dictionaries.find((d) => d === language) ||
      dictionaries.find((d) => d === base) ||
      dictionaries.find((d) => d.startsWith(base + '-'));
    if (match && !chosen.includes(match)) chosen.push(match);
  }
  return chosen.slice(0, 4);
}

module.exports = { acceptLanguages, spellcheckLanguages };

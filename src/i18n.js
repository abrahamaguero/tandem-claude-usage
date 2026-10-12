// The app's texts. Shared by the main process (require) and the renderer (script tags:
// the files of lang/ first, then this one). Each language is one file of lang/, with the
// same keys as en.js; tools/i18n-test.js checks that none is missing.

// Each language by the name it calls itself, in the order the settings list them. The
// code is also the one dates and numbers are written with.
const LANGUAGES = {
  en: 'English',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  fr: 'Français',
  de: 'Deutsch',
  ja: '日本語',
};

const STRINGS = typeof module !== 'undefined'
  ? Object.fromEntries(Object.keys(LANGUAGES).map((code) => [code, require(`./lang/${code}.js`)]))
  : { en: LANG_EN, es: LANG_ES, 'pt-BR': LANG_PT_BR, fr: LANG_FR, de: LANG_DE, ja: LANG_JA };

function translate(language, key, vars = {}) {
  const text = (STRINGS[language] || STRINGS.en)[key] ?? STRINGS.en[key];
  if (text === undefined) return key.replace(/^metric\./, '').replace(/_/g, ' ');
  return text.replace(/\{(\w+)\}/g, (_m, name) => vars[name]);
}

if (typeof module !== 'undefined') module.exports = { translate, languages: Object.keys(LANGUAGES), STRINGS };

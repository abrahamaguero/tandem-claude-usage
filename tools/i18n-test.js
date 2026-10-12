// Checks the texts in src/lang: every language has the texts English has, with the same
// {words} to fill in, and loads both ways the app loads it.
// Run with: node tools/i18n-test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { translate, languages, STRINGS } = require('../src/i18n');
const { TEXT } = require('../src/handoff');

const src = path.join(__dirname, '..', 'src');
const holes = (text) => (text.match(/\{\w+\}/g) || []).sort().join(' ');
const english = STRINGS.en;
const keys = Object.keys(english);

assert.deepStrictEqual(fs.readdirSync(path.join(src, 'lang')).sort(), languages.map((code) => `${code}.js`).sort(), 'one file in src/lang per language of the list in i18n.js');

for (const code of languages) {
  const texts = STRINGS[code];
  assert.deepStrictEqual(Object.keys(texts).filter((key) => !(key in english)), [], `${code}: texts English does not have`);
  assert.deepStrictEqual(keys.filter((key) => !(key in texts)), [], `${code}: texts missing`);
  for (const key of keys) {
    assert.ok(typeof texts[key] === 'string' && texts[key].trim(), `${code}: "${key}" is empty`);
    assert.strictEqual(holes(texts[key]), holes(english[key]), `${code}: "${key}" does not fill in the same words as English`);
  }
  // The prompt that carries a chat over is written in the app's language too.
  assert.deepStrictEqual(Object.keys(TEXT[code] || {}), Object.keys(TEXT.en), `${code}: the handoff prompt's texts`);
}

// The page loads the same files as scripts, one after another, with no require: each
// language file has to leave its texts under the name i18n.js looks them up by.
const page = fs.readFileSync(path.join(src, 'renderer', 'index.html'), 'utf8');
const scripts = [...page.matchAll(/<script src="\.\.\/([^"]+)"><\/script>/g)].map((m) => m[1]);
assert.deepStrictEqual(scripts, [...languages.map((code) => `lang/${code}.js`), 'i18n.js'], 'the scripts of the page: every language, then i18n.js');
const context = vm.createContext({});
const code = scripts.map((file) => fs.readFileSync(path.join(src, file), 'utf8')).join('\n');
vm.runInContext(`${code}\nthis.say = translate; this.names = LANGUAGES;`, context);
assert.deepStrictEqual(Object.keys(context.names), languages);
for (const language of languages) {
  assert.strictEqual(context.say(language, 'settings'), translate(language, 'settings'), `${language}: the page and the app read the same text`);
  assert.strictEqual(context.say(language, 'notifBody', { org: 'Acme', threshold: 75 }).includes('{'), false, `${language}: words filled in`);
}

// A text a language lacks is said in English, and one nobody has, by its key.
assert.strictEqual(translate('xx', 'settings'), english.settings);
assert.strictEqual(translate('en', 'metric.some_new_limit'), 'some new limit');

console.log(`i18n: ${languages.length} languages, ${keys.length} texts each, all cases passed`);

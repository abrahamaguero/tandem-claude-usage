// The line above a sign-in window: how to get through it quickly, and why it is a window of
// Tandem's own and not the browser. The app gives the words and the theme in the address.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') || '';
document.documentElement.lang = params.get('lang') || 'en';
document.getElementById('note-title').textContent = params.get('title') || '';
document.getElementById('note-text').textContent = params.get('text') || '';

const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('viewBox', '0 0 24 24');
const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
path.setAttribute('d', ICONS.bulb);
svg.append(path);
document.getElementById('note-icon').append(svg);

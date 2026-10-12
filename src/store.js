// JSON files in the user's data folder, written so that closing the app mid-write
// (installing an update does that) cannot damage them.
const fs = require('fs');
const path = require('path');

const intact = new Set(); // files known to be complete on disk

function parse(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Falls back to the copy kept by the last save when the file is damaged.
// Null when neither can be read.
function readJson(file) {
  const data = parse(file);
  if (data) {
    intact.add(file);
    return data;
  }
  return parse(`${file}.bak`);
}

// Written to a temporary file and renamed over the old one, so there is never half a
// file. The version it replaces is kept as <file>.bak.
function writeJson(file, data, space) {
  const text = JSON.stringify(data, null, space);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  // A damaged file must not replace the good copy.
  if (intact.has(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {}
  }
  try {
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    fs.writeFileSync(file, text);
  }
  intact.add(file);
}

module.exports = { readJson, writeJson };

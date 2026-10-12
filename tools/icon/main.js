// Draws the app icon on a canvas and saves it as PNG files. Run with: electron . <outDir> [artwork.png]
// With artwork (a square, full-bleed image) the tile is cut out of it; without, the usage rings are drawn.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [outDir, artwork] = process.argv.slice(2);
const artworkUrl = artwork ? 'data:image/png;base64,' + fs.readFileSync(artwork).toString('base64') : null;

const draw = `
(async () => {
  const size = 1024;
  const artworkUrl = ${JSON.stringify(artworkUrl)};
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  // Dark rounded tile with a faint top-to-bottom sheen.
  const bg = ctx.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, '#2b2b33');
  bg.addColorStop(1, '#141418');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(40, 40, size - 80, size - 80, 220);
  ctx.fill();

  // Artwork fills the tile and is clipped to its rounded shape.
  if (artworkUrl) {
    const img = new Image();
    img.src = artworkUrl;
    await img.decode();
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 40, 40, size - 80, size - 80);
    return c.toDataURL('image/png');
  }

  // Two usage rings: the outer one for the session, the inner one for the week.
  const ring = (radius, width, color, fraction) => {
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
    ctx.stroke();
  };
  ring(318, 104, '#d4ff00', 0.72);
  ring(186, 104, '#e91e8c', 0.46);

  // Core dot: the account in use.
  ctx.fillStyle = '#00a0b0';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 62, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL('image/png');
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html></html>');
  const dataUrl = await win.webContents.executeJavaScript(draw);
  const { nativeImage } = require('electron');
  const full = nativeImage.createFromDataURL(dataUrl);
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of [1024, 512, 256, 64, 32, 16]) {
    fs.writeFileSync(path.join(outDir, `icon-${size}.png`), full.resize({ width: size, height: size, quality: 'best' }).toPNG());
  }
  app.quit();
});

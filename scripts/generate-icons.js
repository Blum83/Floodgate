const sharp = require('sharp');
const png2icons = require('png2icons');
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

// Floodgate icon: purple lightning bolt on dark rounded-square background
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#110820"/>
      <stop offset="100%" stop-color="#080c10"/>
    </linearGradient>
    <linearGradient id="bolt" x1="0.4" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#c084fc"/>
      <stop offset="100%" stop-color="#5b21b6"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" rx="110" fill="url(#bg)"/>
  <path filter="url(#glow)"
    d="M 300,50 L 175,270 L 255,270 L 200,465 L 330,245 L 248,245 Z"
    fill="url(#bolt)"/>
</svg>`;

async function run() {
  console.log('Rendering SVG → PNG 1024×1024…');
  const png = await sharp(Buffer.from(svg))
    .resize(1024, 1024)
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
  console.log('  ✓ build/icon.png');

  console.log('Generating ICO (Windows)…');
  const ico = png2icons.createICO(png, png2icons.BICUBIC, 0, true);
  if (!ico) throw new Error('ICO generation failed');
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('  ✓ build/icon.ico');

  console.log('Generating ICNS (macOS)…');
  const icns = png2icons.createICNS(png, png2icons.BICUBIC, 0);
  if (!icns) throw new Error('ICNS generation failed');
  fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns);
  console.log('  ✓ build/icon.icns');

  console.log('\nDone! Icons saved to build/');
}

run().catch(err => { console.error(err.message); process.exit(1); });

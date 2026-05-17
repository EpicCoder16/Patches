const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const buildDir = path.join(__dirname, '..', 'build');
const sourcePath = path.join(buildDir, 'patcheslogorounded.png');
const pngPath = path.join(buildDir, 'icon.png');
const icoPath = path.join(buildDir, 'icon.ico');
const icnsPath = path.join(buildDir, 'icon.icns');

// macOS Dock / toolbar: transparent padding so the system squircle does not crop your art.
// Increase (e.g. 0.14) for more inset; decrease (e.g. 0.08) for a larger icon. Range ~0.06–0.20.
const ICON_INSET = 0.09;
const ICON_CANVAS = 512;

const svg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#6e6af0"/>
  <text
    x="50%"
    y="52%"
    text-anchor="middle"
    dominant-baseline="middle"
    fill="#ffffff"
    font-family="Helvetica, Arial, sans-serif"
    font-weight="700"
    font-size="300"
  >P</text>
</svg>
`.trim();

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });

  if (fs.existsSync(sourcePath)) {
    const pad = Math.round(ICON_CANVAS * ICON_INSET);
    const inner = ICON_CANVAS - pad * 2;
    await sharp(sourcePath)
      .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({
        top: pad,
        bottom: pad,
        left: pad,
        right: pad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(pngPath);
    process.stdout.write(`Using source logo: build/patcheslogorounded.png (inset ${ICON_INSET})\n`);
  } else {
    await sharp(Buffer.from(svg)).png().toFile(pngPath);
    process.stdout.write('Source build/patcheslogorounded.png not found; using fallback SVG icon.\n');
  }

  const pngBuffer = fs.readFileSync(pngPath);
  const icoBuffer = png2icons.createICO(pngBuffer, png2icons.BILINEAR, false);
  const icnsBuffer = png2icons.createICNS(pngBuffer, png2icons.BILINEAR, false);

  if (!icoBuffer) throw new Error('Failed to generate ICO icon.');
  if (!icnsBuffer) throw new Error('Failed to generate ICNS icon.');

  fs.writeFileSync(icoPath, icoBuffer);
  fs.writeFileSync(icnsPath, icnsBuffer);

  process.stdout.write('Generated build/icon.png, build/icon.ico, build/icon.icns\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const buildDir = path.join(__dirname, '..', 'build');
const pngPath = path.join(buildDir, 'icon.png');
const icoPath = path.join(buildDir, 'icon.ico');
const icnsPath = path.join(buildDir, 'icon.icns');

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

  await sharp(Buffer.from(svg)).png().toFile(pngPath);

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

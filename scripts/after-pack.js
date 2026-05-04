/*
 * scripts/after-pack.js
 *
 * Hooked into electron-builder's `afterPack` lifecycle. Runs after
 * Electron + the app are packaged into dist/win-unpacked/ but before
 * the NSIS installer is built. Uses rcedit to write our logo into
 * Clawdeck.exe's Win32 icon resource so taskbar / start menu / desktop
 * shortcuts pick it up.
 *
 * We do this ourselves (rather than letting electron-builder do it via
 * signAndEditExecutable: true) because that path also pulls down the
 * winCodeSign toolchain, whose archive includes macOS .dylib symlinks
 * that 7za can't extract on Windows without Developer Mode. Doing the
 * icon edit by hand sidesteps that entire detour.
 */

const fs = require("node:fs");
const path = require("node:path");
// Both packages ship as ES modules; require() returns a namespace object,
// so the real function lives one level deeper.
const { rcedit } = require("rcedit");
const pngToIco = require("png-to-ico").default;

const SOURCE_PNG = path.resolve(__dirname, "..", "build", "icon.png");
const ICO_PATH = path.resolve(__dirname, "..", "build", "icon.ico");

async function ensureIco() {
  // pngToIco generates a multi-size ICO (16/24/32/48/64/128/256) from a
  // single high-res PNG. We regenerate every build so source changes flow
  // through automatically — it's only ~150 ms for a 1254-px source.
  const buf = await pngToIco(SOURCE_PNG);
  fs.writeFileSync(ICO_PATH, buf);
  return ICO_PATH;
}

module.exports = async function afterPack(context) {
  // Only embed when packaging for Windows. macOS / Linux builds (none
  // today, but cheap to be safe) have their own icon flow.
  if (context.electronPlatformName !== "win32") return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] expected exe not found: ${exePath}`);
    return;
  }

  const ico = await ensureIco();

  await rcedit(exePath, {
    icon: ico,
    "version-string": {
      ProductName: "Clawdeck",
      FileDescription: "Clawdeck — Claude Code companion",
      CompanyName: "Clawdeck",
      LegalCopyright: "© 2026 Clawdeck",
    },
    "product-version": context.packager.appInfo.version,
    "file-version": context.packager.appInfo.version,
  });

  const sizeKB = (fs.statSync(exePath).size / 1024).toFixed(0);
  console.log(`[after-pack] embedded icon + metadata into ${path.relative(process.cwd(), exePath)} (${sizeKB} KB)`);
};

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import archiver from 'archiver';

const DIST = path.resolve('dist');

function slugify(s) {
  return String(s)
    .replace(/[\/\\?%*:|"<>]/g, '-') // remove illegal filename chars
    .replace(/\s+/g, ' ')
    .trim();
}

async function readManifest() {
  const appJsonPath = path.join(DIST, 'app.json');
  const pkgJsonPath = path.join(DIST, 'package.json');

  const app = JSON.parse(await fsp.readFile(appJsonPath, 'utf8'));
  // fallback to package.json if needed
  const pkg = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf8'));

  const name = app.name || pkg.name || 'FabMoApp';
  const version = app.version || pkg.version || '0.0.0';
  return { name: slugify(name), version: slugify(version) };
}

async function zipDist() {
  if (!fs.existsSync(DIST)) {
    throw new Error(`No dist/ folder found. Run "npm run build" first.`);
  }

  const { name, version } = await readManifest();
  const outName = `${name}-${version}.fma`;
  const outPath = path.resolve(outName);

  // create stream
  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () =>
      resolve({ file: outName, bytes: archive.pointer() })
    );
    archive.on('warning', (err) => (err.code === 'ENOENT' ? console.warn(err) : reject(err)));
    archive.on('error', reject);

    archive.pipe(output);
    // include the contents of dist/ at the root of the archive (no top-level folder)
    archive.directory(DIST + '/', false);
    archive.finalize();
  });
}

zipDist()
  .then(({ file, bytes }) => {
    console.log(`Created ${file} (${(bytes / 1024).toFixed(1)} KB)`);
  })
  .catch((err) => {
    console.error('Packaging failed:', err.message);
    process.exit(1);
  });

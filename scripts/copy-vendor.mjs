import { mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const vendorDir = path.join(rootDir, 'public', 'vendor');

const assets = [
  {
    type: 'file',
    target: 'xterm.js',
    sources: ['xterm/lib/xterm.js', '@xterm/xterm/lib/xterm.js']
  },
  {
    type: 'file',
    target: 'xterm.css',
    sources: ['xterm/css/xterm.css', '@xterm/xterm/css/xterm.css']
  },
  {
    type: 'file',
    target: 'xterm-addon-fit.js',
    sources: [
      'xterm-addon-fit/lib/xterm-addon-fit.js',
      '@xterm/addon-fit/lib/addon-fit.js',
      '@xterm/addon-fit/lib/addon-fit.umd.js'
    ]
  },
  {
    type: 'file',
    target: 'xterm-addon-attach.js',
    sources: [
      'xterm-addon-attach/lib/xterm-addon-attach.js',
      '@xterm/addon-attach/lib/addon-attach.js',
      '@xterm/addon-attach/lib/addon-attach.umd.js'
    ]
  },
  {
    type: 'file',
    target: 'xterm-addon-webgl.js',
    sources: [
      '@xterm/addon-webgl/lib/addon-webgl.js',
      '@xterm/addon-webgl/lib/addon-webgl.umd.js',
      'xterm-addon-webgl/lib/xterm-addon-webgl.js'
    ]
  }
];

async function firstExistingPath(candidates) {
  for (const relativePath of candidates) {
    const fullPath = path.join(rootDir, 'node_modules', relativePath);
    try {
      await access(fullPath);
      return fullPath;
    } catch {
      // Keep trying candidates.
    }
  }
  return null;
}

async function main() {
  await mkdir(vendorDir, { recursive: true });
  const missing = [];

  for (const asset of assets) {
    const sourcePath = await firstExistingPath(asset.sources);
    if (!sourcePath) {
      missing.push(`${asset.target} <= ${asset.sources.join(' | ')}`);
      continue;
    }

    const targetPath = path.join(vendorDir, asset.target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    console.log(`Copied ${asset.target}`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing vendor assets:\n- ${missing.join('\n- ')}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

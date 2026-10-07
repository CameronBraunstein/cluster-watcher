'use strict';

/** Generate the immutable native-download manifest embedded in a release VSIX. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Hash one release artifact without loading it all into memory. */
function sha256(filename) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('data', (chunk) => digest.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(digest.digest('hex')));
  });
}

/** Build download metadata from the canonical target list and native files. */
async function createBackendManifest(platforms, assetsDirectory, version, repository = 'CameronBraunstein/cluster-watcher') {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid extension version: ${version}`);
  if (!platforms || platforms.schema_version !== 1 || !Array.isArray(platforms.targets)) {
    throw new Error('release-platforms.json is not a supported target manifest');
  }
  const targets = [];
  for (const target of platforms.targets) {
    if (!/^[A-Za-z0-9._-]+$/.test(target.artifact || '')) throw new Error(`unsafe artifact name: ${target.artifact}`);
    const filename = path.join(assetsDirectory, target.artifact);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size < 1) throw new Error(`release artifact is missing or empty: ${target.artifact}`);
    targets.push({
      ...target,
      size: stat.size,
      sha256: await sha256(filename),
    });
  }
  return {
    schema_version: 1,
    version,
    base_url: `https://github.com/${repository}/releases/download/v${version}/`,
    targets,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    throw new Error('usage: node create-backend-manifest.js RELEASE_PLATFORMS ASSETS_DIRECTORY OUTPUT');
  }
  const [platformsFilename, assetsDirectory, outputFilename] = argv;
  const platforms = JSON.parse(fs.readFileSync(platformsFilename, 'utf8'));
  const version = require('../package.json').version;
  const manifest = await createBackendManifest(platforms, assetsDirectory, version);
  fs.writeFileSync(outputFilename, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { createBackendManifest, sha256 };

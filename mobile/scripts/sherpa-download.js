#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');

const API_BASE =
  'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags';
const ARCHIVE_EXTENSIONS = ['.tar.bz2', '.onnx'];

const args = parseArgs(process.argv.slice(2));
const exampleRoot = path.resolve(__dirname, '..');
// Default output: copy models into the sherpa_models asset-pack used by the example app
const defaultOutput = path.join(
  exampleRoot,
  'android',
  'sherpa_models',
  'src',
  'main',
  'assets',
  'models'
);
const outputDir = args.output ? path.resolve(args.output) : defaultOutput;
const cacheDir = path.resolve(
  args.cache || path.join(exampleRoot, '.model-cache')
);
const manualDir = path.resolve(args.manual || path.join(exampleRoot, 'models'));
const configPath = path.resolve(
  args.config || path.join(__dirname, 'model-download-config.json')
);

// Ensure output is defined (we use a sensible default pointing at the asset-pack)
if (!outputDir) {
  console.error('[SherpaOnnx] Internal error: output dir undefined.');
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error(`[SherpaOnnx] Config not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const releaseCache = new Map();

const manualHint =
  `[SherpaOnnx] You can manually place model folders under: ${manualDir}\n` +
  `[SherpaOnnx] Each model should be in its own folder named after the model id.\n` +
  `[SherpaOnnx] Re-run the build to copy them into: ${outputDir}`;

(async () => {
  try {
    ensureDir(outputDir);
    ensureDir(cacheDir);

    if (!Array.isArray(config.models) || config.models.length === 0) {
      throw new Error('Model config is empty.');
    }

    for (const entry of config.models) {
      await ensureModel(entry);
    }

    console.log('[SherpaOnnx] Model download step completed.');
  } catch (error) {
    console.error('[SherpaOnnx] Model download failed.');
    if (error instanceof Error) {
      console.error(`[SherpaOnnx] ${error.message}`);
    } else {
      console.error('[SherpaOnnx] Unknown error.');
    }
    console.error(manualHint);
    process.exit(1);
  }
})();

async function ensureModel(entry) {
  const modelId = entry.id;
  const tag = entry.tag;

  if (!modelId || !tag) {
    throw new Error('Model config entry is missing id or tag.');
  }

  const targetModelDir = path.join(outputDir, modelId);
  if (hasModelContent(targetModelDir)) {
    console.log(`[SherpaOnnx] ${modelId} already present in output. Skipping.`);
    return;
  }

  const cacheModelDir = path.join(cacheDir, modelId);
  if (!hasModelContent(cacheModelDir)) {
    const manualModelDir = path.join(manualDir, modelId);
    if (hasModelContent(manualModelDir)) {
      console.log(`[SherpaOnnx] Using manual model: ${manualModelDir}`);
      replaceDir(cacheModelDir, manualModelDir);
    } else {
      await downloadModelToCache(modelId, tag, cacheModelDir);
    }
  }

  console.log(`[SherpaOnnx] Copying ${modelId} into output.`);
  replaceDir(targetModelDir, cacheModelDir);
}

function hasModelContent(dirPath) {
  if (!fs.existsSync(dirPath)) return false;
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) return false;
  const entries = fs
    .readdirSync(dirPath)
    .filter((name) => !name.startsWith('.'));
  return entries.length > 0;
}

async function downloadModelToCache(modelId, tag, cacheModelDir) {
  console.log(`[SherpaOnnx] Downloading ${modelId} (${tag})...`);
  const release = await getRelease(tag);
  const asset = findAsset(release, modelId);

  if (!asset) {
    throw new Error(`Model asset not found for ${modelId} in release ${tag}.`);
  }

  const archivePath = path.join(cacheDir, `${modelId}${asset.ext}`);
  await downloadFile(asset.url, archivePath);

  if (asset.ext === '.onnx') {
    ensureDir(cacheModelDir);
    fs.copyFileSync(archivePath, path.join(cacheModelDir, `${modelId}.onnx`));
    return;
  }

  const extractDir = path.join(cacheDir, `.${modelId}-extract`);
  removePath(extractDir);
  ensureDir(extractDir);

  try {
    execFileSync('tar', ['-xjf', archivePath, '-C', extractDir], {
      stdio: 'inherit',
    });
  } catch {
    throw new Error(
      `Failed to extract ${path.basename(
        archivePath
      )}. Ensure 'tar' is available.`
    );
  }

  const extractedRoot = resolveExtractedRoot(extractDir, modelId);
  if (!extractedRoot) {
    throw new Error(`Could not find extracted model folder for ${modelId}.`);
  }

  replaceDir(cacheModelDir, extractedRoot);
}

function resolveExtractedRoot(extractDir, modelId) {
  const modelPath = path.join(extractDir, modelId);
  if (hasModelContent(modelPath)) {
    return modelPath;
  }

  const entries = fs
    .readdirSync(extractDir)
    .filter((name) => !name.startsWith('.'));
  if (entries.length === 1) {
    const candidate = path.join(extractDir, entries[0]);
    if (fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return extractDir;
}

async function getRelease(tag) {
  if (releaseCache.has(tag)) {
    return releaseCache.get(tag);
  }

  const url = `${API_BASE}/${encodeURIComponent(tag)}`;
  const release = await fetchJson(url);
  releaseCache.set(tag, release);
  return release;
}

function findAsset(release, modelId) {
  if (!release || !Array.isArray(release.assets)) {
    return null;
  }

  for (const ext of ARCHIVE_EXTENSIONS) {
    const name = `${modelId}${ext}`;
    const asset = release.assets.find((item) => item.name === name);
    if (asset && asset.browser_download_url) {
      return { url: asset.browser_download_url, ext };
    }
  }

  return null;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = getUrl(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`Download failed: ${response.statusCode} ${url}`));
        return;
      }

      ensureDir(path.dirname(dest));
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });

    request.on('error', reject);
  });
}

function getUrl(url, onResponse) {
  const client = url.startsWith('https') ? https : http;
  const headers = {
    'User-Agent': 'sherpa-onnx-model-downloader',
    'Accept': 'application/vnd.github+json',
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return client.get(url, { headers }, (response) => {
    if (
      response.statusCode &&
      [301, 302, 307, 308].includes(response.statusCode) &&
      response.headers.location
    ) {
      getUrl(response.headers.location, onResponse);
      return;
    }

    onResponse(response);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = getUrl(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`Request failed: ${response.statusCode} ${url}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          reject(new Error('Failed to parse GitHub API response.'));
        }
      });
    });

    request.on('error', reject);
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function replaceDir(destDir, sourceDir) {
  removePath(destDir);
  ensureDir(path.dirname(destDir));
  fs.cpSync(sourceDir, destDir, { recursive: true });
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = value;
      i += 1;
    }
  }
  return parsed;
}
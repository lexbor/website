const path = require('path');
const fs = require('fs');
const { execSync, execFileSync, spawn } = require('child_process');

let LEXBOR_DIR;
let CACHE_DIR;

const modulesCache = {};
const MIN_VERSION = [2, 7, 0];

class GenerationQueue {
    constructor() {
        this._queue = Promise.resolve();
    }

    enqueue(fn) {
        const task = this._queue.then(fn, fn);
        this._queue = task.then(() => {}, () => {});
        return task;
    }
}

const generationQueue = new GenerationQueue();

function init(lexborDir, cacheDir, repoUrl) {
    LEXBOR_DIR = lexborDir;
    CACHE_DIR = cacheDir;

    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    if (!fs.existsSync(path.join(LEXBOR_DIR, '.git'))) {
        if (!repoUrl) {
            throw new Error(
                'Lexbor repo not found at ' + LEXBOR_DIR +
                ' and LEXBOR_REPO_URL is not set. Please clone manually or set LEXBOR_REPO_URL.'
            );
        }

        console.log(`[amalgamation] Cloning ${repoUrl} into ${LEXBOR_DIR}...`);
        execSync('git clone -- ' + shellescape(repoUrl) + ' ' + shellescape(LEXBOR_DIR), { stdio: 'inherit' });
        console.log('[amalgamation] Clone complete.');
    }
}

function shellescape(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

function parseVersion(tag) {
    const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}

function versionGte(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
    }
    return true;
}

function gitExec(...args) {
    return execFileSync('git', args, { cwd: LEXBOR_DIR, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function getAvailableVersions() {
    const output = gitExec('tag', '--sort=-version:refname');
    const tags = output.split('\n').filter(tag => {
        const v = parseVersion(tag);
        return v && versionGte(v, MIN_VERSION);
    });
    return ['latest', 'master', ...tags];
}

function resolveVersion(version) {
    if (version === 'latest') {
        const versions = getAvailableVersions();
        const firstTag = versions.find(v => v !== 'latest' && v !== 'master');
        if (!firstTag) throw new Error('No release versions available');
        return firstTag;
    }
    return version;
}

function getHeadCommitShort() {
    return gitExec('rev-parse', '--short=6', 'HEAD');
}

function getMasterCacheKey() {
    const commit = getHeadCommitShort();
    return `master_${commit}`;
}

function readModulesFromDisk() {
    const modulesDir = path.join(LEXBOR_DIR, 'source', 'lexbor');
    return fs.readdirSync(modulesDir)
        .filter(entry => {
            if (entry.startsWith('.') || entry === 'ports') return false;
            return fs.statSync(path.join(modulesDir, entry)).isDirectory();
        })
        .sort();
}

function getModulesForVersion(version) {
    const resolved = resolveVersion(version);

    if (resolved === 'master') {
        return generationQueue.enqueue(() => {
            gitExec('checkout', 'master');
            gitExec('pull', '--ff-only');
            const key = getMasterCacheKey();
            if (modulesCache[key]) return modulesCache[key];
            const modules = readModulesFromDisk();
            modulesCache[key] = modules;
            return modules;
        });
    }

    // Tag — check cache first (no queue needed)
    if (modulesCache[resolved]) {
        return Promise.resolve(modulesCache[resolved]);
    }

    return generationQueue.enqueue(() => {
        // Double-check after queue wait
        if (modulesCache[resolved]) return modulesCache[resolved];
        gitExec('checkout', resolved);
        const modules = readModulesFromDisk();
        modulesCache[resolved] = modules;
        return modules;
    });
}

function buildCacheKey(resolvedVersion, modules, commitHash) {
    const sortedModules = [...modules].sort().join('_');
    const versionPart = commitHash
        ? `master_${commitHash}`
        : resolvedVersion;
    return `${sortedModules}__${versionPart}.c`;
}

function getCachePath(cacheKey) {
    const safeName = path.basename(cacheKey);
    const fullPath = path.join(CACHE_DIR, safeName);

    if (!fullPath.startsWith(path.resolve(CACHE_DIR))) {
        throw new Error('Invalid cache key: path traversal detected');
    }

    return fullPath;
}

function generate(version, modules) {
    const resolved = resolveVersion(version);
    const sortedModules = [...modules].sort();

    // For tags — try cache before queue
    if (resolved !== 'master') {
        const cacheKey = buildCacheKey(resolved, sortedModules, null);
        const cachePath = getCachePath(cacheKey);
        if (fs.existsSync(cachePath)) {
            return Promise.resolve({
                cachePath,
                resolvedVersion: resolved,
                commitHash: null
            });
        }
    }

    return generationQueue.enqueue(() => {
        return new Promise((resolve, reject) => {
            gitExec('checkout', resolved);

            let commitHash = null;
            if (resolved === 'master') {
                gitExec('pull', '--ff-only');
                commitHash = getHeadCommitShort();
            }

            const cacheKey = buildCacheKey(resolved, sortedModules, commitHash);
            const cachePath = getCachePath(cacheKey);

            // Check cache after checkout (especially for master)
            if (fs.existsSync(cachePath)) {
                return resolve({ cachePath, resolvedVersion: resolved, commitHash });
            }

            const scriptPath = path.join(LEXBOR_DIR, 'single.pl');
            const child = spawn('perl', [scriptPath, ...sortedModules], {
                cwd: LEXBOR_DIR
            });

            const tmpPath = cachePath + '.tmp';
            const writeStream = fs.createWriteStream(tmpPath);

            child.stdout.pipe(writeStream);

            let stderr = '';
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (err) => {
                try { fs.unlinkSync(tmpPath); } catch (e) {}
                reject(new Error(`Failed to spawn single.pl: ${err.message}`));
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    try { fs.unlinkSync(tmpPath); } catch (e) {}
                    reject(new Error(`single.pl exited with code ${code}: ${stderr}`));
                    return;
                }

                try {
                    fs.renameSync(tmpPath, cachePath);
                } catch (err) {
                    reject(new Error(`Failed to save cache: ${err.message}`));
                    return;
                }

                resolve({ cachePath, resolvedVersion: resolved, commitHash });
            });
        });
    });
}

function fetchUpdates() {
    return generationQueue.enqueue(() => {
        try {
            gitExec('fetch', '--tags', '--prune');
            console.log('[amalgamation] Fetched latest tags and refs');
        } catch (err) {
            console.error('[amalgamation] Failed to fetch updates:', err.message);
        }
    });
}

function cleanupMasterCache() {
    try {
        const files = fs.readdirSync(CACHE_DIR);
        const masterFiles = files.filter(f => f.includes('__master_'));

        if (masterFiles.length === 0) return;

        // Group by module set (everything before __master_)
        const groups = {};
        for (const file of masterFiles) {
            const match = file.match(/^(.+)__master_([a-f0-9]+)\.c$/);
            if (!match) continue;
            const moduleKey = match[1];
            const commit = match[2];
            if (!groups[moduleKey]) groups[moduleKey] = [];
            groups[moduleKey].push({ file, commit });
        }

        // Get current master commit
        let currentCommit;
        try {
            gitExec('checkout', 'master');
            gitExec('pull', '--ff-only');
            currentCommit = getHeadCommitShort();
        } catch (err) {
            console.error('[amalgamation] Failed to get master HEAD for cleanup:', err.message);
            return;
        }

        let removed = 0;
        for (const [moduleKey, entries] of Object.entries(groups)) {
            for (const entry of entries) {
                if (entry.commit !== currentCommit) {
                    try {
                        fs.unlinkSync(path.join(CACHE_DIR, entry.file));
                        removed++;
                    } catch (e) {}
                }
            }
        }

        // Cleanup stale master entries from modulesCache
        for (const key of Object.keys(modulesCache)) {
            if (key.startsWith('master_') && key !== `master_${currentCommit}`) {
                delete modulesCache[key];
            }
        }

        if (removed > 0) {
            console.log(`[amalgamation] Cleaned up ${removed} stale master cache file(s)`);
        }
    } catch (err) {
        console.error('[amalgamation] Cache cleanup error:', err.message);
    }
}

module.exports = {
    init,
    getAvailableVersions,
    resolveVersion,
    getModulesForVersion,
    generate,
    fetchUpdates,
    cleanupMasterCache
};

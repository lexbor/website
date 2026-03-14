const express = require('express');
const router = express.Router();
const amalgamation = require('../lib/amalgamation');

const MAX_FILENAME_LENGTH = 1024;
const MAX_MODULES = 500;
const MAX_PARAM_LENGTH = 8192;

function validateStringParam(value, maxLen) {
    return typeof value === 'string' && value.length <= maxLen;
}

// GET /api/amalgamation/modules?version=...
router.get('/api/amalgamation/modules', async (req, res) => {
    const { version } = req.query;

    if (!version) {
        return res.status(400).json({ error: 'version parameter is required' });
    }

    if (!validateStringParam(version, MAX_PARAM_LENGTH)) {
        return res.status(400).json({ error: 'Invalid version parameter' });
    }

    const available = amalgamation.getAvailableVersions();
    if (!available.includes(version)) {
        return res.status(400).json({ error: `Unknown version: ${version}` });
    }

    try {
        const modules = await amalgamation.getModulesForVersion(version);
        const deps = await amalgamation.getDepsForVersion(version);
        const resolved = amalgamation.resolveVersion(version);
        res.json({ modules, dependencies: deps, version: resolved });
    } catch (err) {
        console.error('Error getting modules:', err);
        res.status(500).json({ error: 'Failed to get modules' });
    }
});

// GET /api/amalgamation?version=...&modules=...&ext=...&filename=...
router.get('/api/amalgamation', async (req, res) => {
    const { version, modules: modulesParam, ext, filename } = req.query;

    if (!version) {
        return res.status(400).json({ error: 'version parameter is required' });
    }

    if (!validateStringParam(version, MAX_PARAM_LENGTH)
        || (modulesParam && !validateStringParam(modulesParam, MAX_PARAM_LENGTH)))
    {
        return res.status(400).json({ error: 'Invalid parameters' });
    }

    if (filename && !validateStringParam(filename, MAX_FILENAME_LENGTH)) {
        return res.status(400).json({ error: 'Filename too long' });
    }

    // Validate version
    const available = amalgamation.getAvailableVersions();
    if (!available.includes(version)) {
        return res.status(400).json({ error: `Unknown version: ${version}` });
    }

    // Fetch version modules (needed for 'all' resolution and validation)
    let versionModules;
    try {
        versionModules = await amalgamation.getModulesForVersion(version);
    } catch (err) {
        console.error('Error getting modules for validation:', err);
        return res.status(500).json({ error: 'Failed to validate modules' });
    }

    // Parse modules — no modules or 'all' means all modules
    let selectedModules;
    if (!modulesParam || modulesParam.trim().toLowerCase() === 'lexbor') {
        selectedModules = versionModules;
    } else {
        selectedModules = modulesParam.split(',').map(m => m.trim()).filter(Boolean);
    }

    if (selectedModules.length === 0) {
        return res.status(400).json({ error: 'At least one module is required' });
    }

    if (selectedModules.length > MAX_MODULES) {
        return res.status(400).json({ error: 'Too many modules' });
    }

    const invalidModules = selectedModules.filter(m => !versionModules.includes(m));
    if (invalidModules.length > 0) {
        return res.status(400).json({
            error: `Modules not available in ${version}: ${invalidModules.join(', ')}`
        });
    }

    // Sanitize extension
    const extension = (ext || 'h').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!extension) {
        return res.status(400).json({ error: 'Invalid extension' });
    }

    // Sanitize filename
    let sanitizedFilename = '';
    if (filename) {
        sanitizedFilename = filename.replace(/[^a-zA-Z0-9_-]/g, '');
    }

    // Generate
    let result;
    try {
        result = await amalgamation.generate(version, selectedModules);
    } catch (err) {
        console.error('Error generating amalgamation:', err);
        return res.status(500).json({ error: 'Failed to generate amalgamation' });
    }

    // Build download filename
    const versionSuffix = result.commitHash
        ? `master_${result.commitHash}`
        : result.resolvedVersion;

    let downloadName;
    const isAllModules = selectedModules.length === versionModules.length
        && selectedModules.every(m => versionModules.includes(m));

    if (isAllModules && !sanitizedFilename) {
        downloadName = `lexbor-${versionSuffix}.${extension}`;
    } else if (sanitizedFilename) {
        downloadName = `${sanitizedFilename}-${versionSuffix}.${extension}`;
    } else {
        const modulesPart = [...selectedModules].sort().join('_');
        downloadName = `${modulesPart}-${versionSuffix}.${extension}`;
    }

    res.download(result.cachePath, downloadName);
});

// GET /generate/amalgamation — HTML page
router.get('/generate/amalgamation', async (req, res) => {
    try {
        const versions = amalgamation.getAvailableVersions();
        const defaultVersion = versions[0] || 'latest';
        const modules = await amalgamation.getModulesForVersion(defaultVersion);
        const deps = await amalgamation.getDepsForVersion(defaultVersion);

        res.render('amalgamation', {
            title: 'Generate Amalgamation',
            versions,
            modules,
            deps,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error rendering amalgamation page:', err);
        res.render('amalgamation', {
            title: 'Generate Amalgamation',
            versions: [],
            modules: [],
            deps: {},
            error: 'Failed to load versions and modules'
        });
    }
});

module.exports = router;

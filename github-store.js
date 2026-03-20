/**
 * GitHub-as-database storage.
 *
 * Each submission is saved as  results/{cage_name}_{iso_timestamp}.json
 * in the private repo specified by GITHUB_REPO env var.
 *
 * On server startup, loadAllResults() pulls every file and seeds
 * the in-memory SQLite so queries work as normal.
 *
 * Required env vars:
 *   GITHUB_TOKEN  — fine-grained PAT with contents:write on the data repo
 *   GITHUB_REPO   — e.g. "Asinha145/ifc-checker-data"
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const BASE_URL     = 'https://api.github.com';

function ghHeaders() {
    return {
        'Authorization'       : `Bearer ${GITHUB_TOKEN}`,
        'Accept'              : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type'        : 'application/json',
        'User-Agent'          : 'ifc-checker',
    };
}

function isConfigured() {
    return !!(GITHUB_TOKEN && GITHUB_REPO);
}

/**
 * Save a submission object to GitHub.
 * fileStem should be unique per submission, e.g. "HL230605AC1_2025-06-18T143022Z".
 */
async function saveResult(fileStem, data) {
    if (!isConfigured()) {
        console.warn('GitHub storage not configured — skipping save');
        return;
    }

    const filePath = `results/${fileStem}.json`;
    const url      = `${BASE_URL}/repos/${GITHUB_REPO}/contents/${filePath}`;
    const content  = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');

    // Fetch existing SHA so we can update if a same-name file exists.
    let sha = null;
    try {
        const check = await fetch(url, { headers: ghHeaders() });
        if (check.ok) {
            const existing = await check.json();
            sha = existing.sha || null;
        }
    } catch (_) {}

    const body = {
        message: `Add result: ${data.cage_name || fileStem}`,
        content,
    };
    if (sha) body.sha = sha;

    const resp = await fetch(url, {
        method : 'PUT',
        headers: ghHeaders(),
        body   : JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text();
        console.error(`GitHub save failed (${resp.status}): ${text}`);
    } else {
        console.log(`Saved to GitHub: ${filePath}`);
    }
}

/**
 * Load all submission JSON files from the results/ folder.
 * Returns an array of submission objects.
 */
async function loadAllResults() {
    if (!isConfigured()) return [];

    try {
        const url  = `${BASE_URL}/repos/${GITHUB_REPO}/contents/results`;
        const resp = await fetch(url, { headers: ghHeaders() });

        if (!resp.ok) {
            if (resp.status === 404) return []; // folder doesn't exist yet
            console.error(`GitHub list failed (${resp.status})`);
            return [];
        }

        const files = await resp.json();
        if (!Array.isArray(files)) return [];

        const results = [];
        for (const file of files) {
            if (!file.name.endsWith('.json')) continue;
            try {
                const fResp = await fetch(file.download_url);
                if (!fResp.ok) continue;
                const data = await fResp.json();
                results.push(data);
            } catch (e) {
                console.warn(`Failed to load ${file.name}: ${e.message}`);
            }
        }

        console.log(`Loaded ${results.length} results from GitHub`);
        return results;

    } catch (e) {
        console.error('GitHub loadAllResults error:', e.message);
        return [];
    }
}

module.exports = { saveResult, loadAllResults, isConfigured };

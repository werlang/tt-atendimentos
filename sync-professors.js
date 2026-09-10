const fs = require('fs');
const path = require('path');

const DEFAULT_TROCAAULA_URL = 'https://trocaaula.sistemas.charqueadas.ifsul.edu.br/';

/**
 * Strips accents and non-alphanumeric characters, returning trimmed lowercase text.
 *
 * @param {string} value - Raw string to normalize.
 * @returns {string} Normalized string.
 */
function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Normalizes text and removes all whitespace for exact signature comparisons.
 *
 * @param {string} value - Raw string to normalize.
 * @returns {string} Normalized text with no spaces.
 */
function normalizeCompactText(value) {
    return normalizeText(value).replace(/\s+/g, '');
}

/**
 * Resolves the full `/timetables` endpoint URL from a TrocaAula base URL.
 * Attempts to read `apiUrl` from `#template-vars` on the page, falling back
 * to domain heuristics (e.g. `trocaaula.` -> `api.trocaaula.`).
 *
 * @param {string} targetUrl - TrocaAula web or API URL.
 * @returns {Promise<string>} Direct URL to the /timetables endpoint.
 */
async function resolveTimetablesUrl(targetUrl) {
    if (targetUrl.endsWith('/timetables') || targetUrl.includes('/timetables?')) {
        return targetUrl;
    }

    try {
        const response = await fetch(targetUrl);
        if (response.ok) {
            const html = await response.text();
            const match = html.match(/<script id="template-vars"[^>]*>([\s\S]*?)<\/script>/);
            if (match) {
                const vars = JSON.parse(match[1]);
                if (vars.apiUrl) {
                    return `${vars.apiUrl.replace(/\/+$/, '')}/timetables`;
                }
            }
        }
    } catch {
        // Fall back to URL resolution heuristics below
    }

    try {
        const parsed = new URL(targetUrl);
        if (parsed.hostname.startsWith('trocaaula.')) {
            parsed.hostname = `api.${parsed.hostname}`;
            parsed.pathname = '/timetables';
            return parsed.toString();
        }
    } catch {
        // Ignore URL parse errors
    }

    return `${targetUrl.replace(/\/+$/, '')}/timetables`;
}

/**
 * Reads and normalizes existing professors from the local JSON file.
 *
 * @param {string} filePath - Path to professors.json.
 * @returns {Array<{name: string, short: string, email: string|null}>}
 */
function readExistingProfessors(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) return [];

        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return parsed.map(record => ({
                name: String(record?.name || record?.short || '').trim(),
                short: String(record?.short || record?.name || '').trim(),
                email: record?.email ? String(record.email).trim().toLowerCase() : null,
            })).filter(p => p.short);
        }
    } catch (err) {
        console.warn(`Warning: Could not parse existing ${path.basename(filePath)}:`, err.message);
    }

    return [];
}

/**
 * Extracts unique email addresses found in form.csv.
 *
 * @param {string} formPath - Path to form.csv.
 * @returns {string[]} List of lowercase email addresses.
 */
function extractFormEmails(formPath) {
    if (!fs.existsSync(formPath)) {
        return [];
    }

    try {
        const content = fs.readFileSync(formPath, 'utf8');
        const matches = content.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
        return Array.from(new Set(matches.map(email => email.trim().toLowerCase())));
    } catch {
        return [];
    }
}

/**
 * Matches a professor to an email from form.csv using username aliases,
 * first + last name combinations, or first + middle name combinations.
 *
 * @param {{name: string, short: string, email?: string|null}} professor
 * @param {string[]} availableEmails - Array of emails from form responses.
 * @returns {string|null} Matched email or null.
 */
function matchEmailForProfessor(professor, availableEmails) {
    if (!professor || !availableEmails || availableEmails.length === 0) {
        return null;
    }

    const nameParts = (professor.name || '').trim().split(/\s+/).filter(Boolean);
    if (nameParts.length === 0) {
        return null;
    }

    const normFirst = normalizeCompactText(nameParts[0]);
    const normLast = normalizeCompactText(nameParts[nameParts.length - 1]);

    // 0. If professor has an existing/raw email, match form email by username
    if (professor.email) {
        const profUser = normalizeCompactText(professor.email.split('@')[0]);
        const matchedUser = availableEmails.find(email => normalizeCompactText(email.split('@')[0]) === profUser);
        if (matchedUser) return matchedUser;
    }

    // 1. Direct match: username equals first + last name (e.g. rodrigoferreira@ifsul.edu.br)
    const exactFirstLast = availableEmails.find(email => {
        const username = normalizeCompactText(email.split('@')[0]);
        return username === normFirst + normLast;
    });
    if (exactFirstLast) return exactFirstLast;

    // 2. Match with any middle or compound name (e.g. first + middle)
    for (let i = 1; i < nameParts.length; i += 1) {
        const part = normalizeCompactText(nameParts[i]);
        const match = availableEmails.find(email => {
            const username = normalizeCompactText(email.split('@')[0]);
            return username === normFirst + part;
        });
        if (match) return match;
    }

    return null;
}

/**
 * Fetches teachers from TrocaAula, merges with local professors.json,
 * associates emails from form.csv, and writes the updated JSON file.
 *
 * @param {object} options
 * @param {string} options.targetUrl - TrocaAula web or API base URL.
 * @param {string} options.baseDir - Project directory path.
 */
async function syncProfessors({ targetUrl, baseDir }) {
    const professorsPath = path.join(baseDir, 'professors.json');
    const formPath = path.join(baseDir, 'form.csv');

    console.log(`Resolvendo URL do TrocaAula: ${targetUrl}`);
    const timetablesUrl = await resolveTimetablesUrl(targetUrl);
    console.log(`Buscando professores em: ${timetablesUrl}`);

    const response = await fetch(timetablesUrl);
    if (!response.ok) {
        throw new Error(`Falha ao consultar TrocaAula (${response.status} ${response.statusText})`);
    }

    const data = await response.json();
    const teachers = Array.isArray(data.teachers) ? data.teachers : [];
    if (teachers.length === 0) {
        throw new Error('Nenhum professor retornado pelo endpoint do TrocaAula.');
    }

    const existingProfessors = readExistingProfessors(professorsPath);
    const existingByShort = new Map();
    const existingByName = new Map();
    for (const prof of existingProfessors) {
        if (prof.short) existingByShort.set(normalizeCompactText(prof.short), prof);
        if (prof.name) existingByName.set(normalizeCompactText(prof.name), prof);
    }

    const formEmails = extractFormEmails(formPath);

    let createdCount = 0;
    let preservedEmailCount = 0;
    let autoMatchedEmailCount = 0;

    const mergedProfessors = teachers.map(teacher => {
        const short = String(teacher.short || teacher.name || '').trim();
        const name = String(teacher.name || `${teacher.firstname || ''} ${teacher.lastname || ''}`.trim() || short).trim();

        const existing = existingByShort.get(normalizeCompactText(short)) || existingByName.get(normalizeCompactText(name));

        let email = null;
        const candidateEmail = (existing && existing.email) || (teacher.email ? String(teacher.email).trim().toLowerCase() : null);
        const matchedFromForm = matchEmailForProfessor({ name, short, email: candidateEmail }, formEmails);

        if (matchedFromForm) {
            email = matchedFromForm;
            autoMatchedEmailCount += 1;
        } else if (candidateEmail) {
            email = candidateEmail;
            preservedEmailCount += 1;
        }

        if (!existing) {
            createdCount += 1;
        }

        return {
            name,
            short,
            email,
        };
    });

    // Preserve any existing local professors that weren't in the remote list
    const remoteSignatures = new Set(mergedProfessors.map(p => normalizeCompactText(p.short)));
    let preservedLocalCount = 0;
    for (const existing of existingProfessors) {
        if (!remoteSignatures.has(normalizeCompactText(existing.short))) {
            mergedProfessors.push(existing);
            preservedLocalCount += 1;
        }
    }

    mergedProfessors.sort((profA, profB) => profA.name.localeCompare(profB.name, 'pt-BR'));

    fs.writeFileSync(professorsPath, `${JSON.stringify(mergedProfessors, null, 4)}\n`, 'utf8');

    console.log('');
    console.log(`Sucesso: ${path.basename(professorsPath)} atualizado.`);
    console.log(`- Total de professores: ${mergedProfessors.length}`);
    console.log(`- Novos professores adicionados: ${createdCount}`);
    console.log(`- Registros locais preservados: ${preservedLocalCount}`);
    console.log(`- E-mails preservados/obtidos: ${preservedEmailCount}`);
    console.log(`- E-mails associados automaticamente via form.csv: ${autoMatchedEmailCount}`);
    console.log(`- Professores com e-mail definido: ${mergedProfessors.filter(p => p.email).length}`);
}

async function main() {
    const args = process.argv.slice(2);
    const targetUrl = args[0] || process.env.TROCAAULA_URL || DEFAULT_TROCAAULA_URL;
    const baseDir = __dirname;

    try {
        await syncProfessors({ targetUrl, baseDir });
    } catch (err) {
        console.error('Erro na sincronização de professores:', err.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    syncProfessors,
    resolveTimetablesUrl,
    matchEmailForProfessor,
};

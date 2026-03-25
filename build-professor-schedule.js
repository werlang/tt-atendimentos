const fs = require('fs');
const path = require('path');

const DAY_ORDER = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'];
const PERIOD_CODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'N0', 'N1', 'N2', 'N3', 'N4', 'N5'];
const SAMPLE_HTML_FILE = 'sample.html';
const MATCH_TOKEN_MIN_LENGTH = 3;
const NAME_CONNECTORS = new Set(['da', 'de', 'do', 'das', 'dos', 'del', 'e']);
const HTML_ENTITY_MAP = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
};

class CsvParser {
    static parse(text) {
        const rows = [];
        let currentField = '';
        let currentRow = [];
        let insideQuotes = false;

        for (let index = 0; index < text.length; index += 1) {
            const character = text[index];
            const nextCharacter = text[index + 1];

            if (character === '"') {
                if (insideQuotes && nextCharacter === '"') {
                    currentField += '"';
                    index += 1;
                } else {
                    insideQuotes = !insideQuotes;
                }
                continue;
            }

            if (character === ',' && !insideQuotes) {
                currentRow.push(currentField);
                currentField = '';
                continue;
            }

            if ((character === '\n' || character === '\r') && !insideQuotes) {
                if (character === '\r' && nextCharacter === '\n') {
                    index += 1;
                }

                currentRow.push(currentField);
                if (currentRow.some(field => field.length > 0)) {
                    rows.push(currentRow);
                }

                currentField = '';
                currentRow = [];
                continue;
            }

            currentField += character;
        }

        if (currentField.length > 0 || currentRow.length > 0) {
            currentRow.push(currentField);
            if (currentRow.some(field => field.length > 0)) {
                rows.push(currentRow);
            }
        }

        return rows;
    }
}

class ProfessorScheduleBuilder {
    constructor(baseDir, csvFileName, mappingFileName) {
        this.baseDir = baseDir;
        this.csvPath = path.join(baseDir, csvFileName);
        this.mappingPath = path.join(baseDir, mappingFileName);
    }

    run() {
        const { headers, responses } = this.readLatestResponses();
        const timeSlots = this.extractTimeSlots(headers);
        const generatedAt = new Date().toISOString();
        const professorAliases = this.readProfessorAliases();
        const matchedResponses = responses.filter(response => professorAliases[response.email]);
        const matchedScheduleTable = this.buildScheduleTable(
            timeSlots,
            matchedResponses,
            response => professorAliases[response.email],
        );

        const clickData = this.buildClickData(matchedScheduleTable, generatedAt);
        const totalSlots = this.flattenEntries(matchedScheduleTable).length;

        const clickDataPath = path.join(this.baseDir, 'click-data.json');

        fs.writeFileSync(clickDataPath, `${JSON.stringify(clickData, null, 4)}\n`, 'utf8');

        console.log('Build concluído.');
        console.log(`Arquivo atualizado: ${path.basename(clickDataPath)}`);
        console.log(`Períodos com professores: ${totalSlots}`);
        console.log('');
        console.log('Próximos passos no navegador:');
        console.log('1. Cole o conteúdo do helper click.js no console do site do Timetables');
        console.log(`2. Quando o seletor abrir, escolha o arquivo: ${path.basename(clickDataPath)}`);
        console.log('3. Na seleção de professores para a aula, rode: run()');
        console.log('4. Para um período específico, rode: run("T3", "TER")');
        console.log('5. Para reiniciar a sequência, rode: resetRun()');
    }

    readProfessorAliases() {
        if (!fs.existsSync(this.mappingPath)) {
            return {};
        }

        return JSON.parse(fs.readFileSync(this.mappingPath, 'utf8'));
    }

    syncProfessorAliasesFromHtml(sampleHtmlFileName = SAMPLE_HTML_FILE) {
        const sampleHtmlPath = path.join(this.baseDir, sampleHtmlFileName);
        if (!fs.existsSync(sampleHtmlPath)) {
            throw new Error(`Sample HTML file not found: ${sampleHtmlFileName}`);
        }

        const currentAliases = this.readProfessorAliases();
        const sampleRows = this.readProfessorRowsFromSampleHtml(sampleHtmlPath);
        const syncedAliases = {};
        const updates = [];
        const unmatched = [];

        for (const [email, currentAlias] of Object.entries(currentAliases)) {
            const match = this.findProfessorSampleMatch(email, currentAlias, sampleRows);

            if (!match) {
                syncedAliases[email] = currentAlias;
                unmatched.push({ email, currentAlias });
                continue;
            }

            syncedAliases[email] = match.row.abbreviation;

            if (match.row.abbreviation !== currentAlias) {
                updates.push({
                    email,
                    from: currentAlias,
                    to: match.row.abbreviation,
                });
            }
        }

        fs.writeFileSync(this.mappingPath, `${JSON.stringify(syncedAliases, null, 4)}\n`, 'utf8');

        const unchangedCount = Object.keys(currentAliases).length - updates.length - unmatched.length;
        console.log(`Professores sincronizados em ${path.basename(this.mappingPath)} usando ${path.basename(sampleHtmlPath)}.`);
        console.log(`Atualizados: ${updates.length}`);
        console.log(`Sem alteração: ${unchangedCount}`);
        console.log(`Sem correspondência segura: ${unmatched.length}`);

        if (updates.length > 0) {
            console.log('');
            console.log('Atualizações aplicadas:');
            for (const update of updates) {
                console.log(`- ${update.email}: ${update.from} -> ${update.to}`);
            }
        }

        if (unmatched.length > 0) {
            console.log('');
            console.log('Mantidos sem alteração por falta de correspondência segura:');
            for (const entry of unmatched) {
                console.log(`- ${entry.email}: ${entry.currentAlias}`);
            }
        }

        return { syncedAliases, updates, unmatched };
    }

    readProfessorRowsFromSampleHtml(sampleHtmlPath) {
        const html = fs.readFileSync(sampleHtmlPath, 'utf8');
        const rowPattern = /<tr\b[^>]*class="[^"]*\brec\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
        const rows = [];
        const seenRows = new Set();

        let rowMatch = rowPattern.exec(html);
        while (rowMatch) {
            const cellMatches = Array.from(rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi));
            if (cellMatches.length >= 4) {
                const abbreviation = this.extractHtmlText(cellMatches[1][1]);
                const lastName = this.extractHtmlText(cellMatches[2][1]);
                const firstName = this.extractHtmlText(cellMatches[3][1]);

                if (abbreviation && lastName && firstName) {
                    const signature = `${abbreviation}|${lastName}|${firstName}`;
                    if (!seenRows.has(signature)) {
                        seenRows.add(signature);
                        rows.push({
                            abbreviation,
                            lastName,
                            firstName,
                            normalizedAbbreviation: this.normalizeText(abbreviation),
                            compactAbbreviation: this.normalizeCompactText(abbreviation),
                            compactFirstName: this.normalizeCompactText(firstName),
                            compactLastName: this.normalizeCompactText(lastName),
                            tokens: this.buildMatchTokens(abbreviation, lastName, firstName),
                        });
                    }
                }
            }

            rowMatch = rowPattern.exec(html);
        }

        if (rows.length === 0) {
            throw new Error(`No professor rows found in ${path.basename(sampleHtmlPath)}.`);
        }

        return rows;
    }

    findProfessorSampleMatch(email, currentAlias, sampleRows) {
        const localPart = String(email || '').split('@')[0] || '';
        const emailCompact = this.normalizeCompactText(localPart);
        const aliasCompact = this.normalizeCompactText(currentAlias);

        const rankedMatches = sampleRows
            .map(row => this.scoreProfessorSampleRow(row, emailCompact, aliasCompact))
            .filter(match => match.score > 0)
            .sort((matchA, matchB) => {
                if (matchB.score !== matchA.score) {
                    return matchB.score - matchA.score;
                }

                if (matchB.distinctTokenCount !== matchA.distinctTokenCount) {
                    return matchB.distinctTokenCount - matchA.distinctTokenCount;
                }

                return matchA.row.abbreviation.localeCompare(matchB.row.abbreviation, 'pt-BR');
            });

        if (rankedMatches.length === 0) {
            return null;
        }

        const [bestMatch, secondMatch] = rankedMatches;

        if (secondMatch && secondMatch.score === bestMatch.score && secondMatch.distinctTokenCount === bestMatch.distinctTokenCount) {
            return null;
        }

        if (bestMatch.distinctTokenCount < 2) {
            const canUseUniqueSingleTokenMatch = !secondMatch
                && bestMatch.distinctTokenCount === 1
                && bestMatch.emailMatchCount > 0
                && bestMatch.aliasMatchCount > 0
                && bestMatch.score >= 17;

            if (!canUseUniqueSingleTokenMatch) {
                return null;
            }
        }

        return bestMatch;
    }

    scoreProfessorSampleRow(row, emailCompact, aliasCompact) {
        const emailMatches = row.tokens.filter(token => emailCompact.includes(token));
        const aliasMatches = row.tokens.filter(token => aliasCompact.includes(token));
        const distinctTokens = Array.from(new Set([...emailMatches, ...aliasMatches]));

        let score = emailMatches.length * 10;
        score += aliasMatches.length * 4;

        if (aliasCompact && aliasCompact === row.compactAbbreviation) {
            score += 12;
        }

        if (row.compactFirstName && emailCompact.includes(row.compactFirstName)) {
            score += 3;
        }

        if (row.compactLastName && emailCompact.includes(row.compactLastName)) {
            score += 3;
        }

        return {
            row,
            score,
            distinctTokenCount: distinctTokens.length,
            emailMatchCount: emailMatches.length,
            aliasMatchCount: aliasMatches.length,
        };
    }

    buildMatchTokens(...values) {
        return Array.from(new Set(values
            .flatMap(value => this.tokenizeMatchText(value))));
    }

    tokenizeMatchText(value) {
        return this.normalizeText(value)
            .split(' ')
            .filter(token => token.length >= MATCH_TOKEN_MIN_LENGTH && !NAME_CONNECTORS.has(token));
    }

    normalizeText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    normalizeCompactText(value) {
        return this.normalizeText(value).replace(/\s+/g, '');
    }

    extractHtmlText(value) {
        return this.decodeHtmlEntities(String(value || ''))
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    decodeHtmlEntities(value) {
        let decoded = String(value || '');

        for (const [entity, replacement] of Object.entries(HTML_ENTITY_MAP)) {
            decoded = decoded.split(entity).join(replacement);
        }

        decoded = decoded.replace(/&#(\d+);/g, (_, codePoint) => String.fromCodePoint(Number(codePoint)));
        decoded = decoded.replace(/&#x([\da-f]+);/gi, (_, codePoint) => String.fromCodePoint(parseInt(codePoint, 16)));

        return decoded;
    }

    readLatestResponses() {
        const csvContent = fs.readFileSync(this.csvPath, 'utf8');
        const [headers, ...rows] = CsvParser.parse(csvContent);

        const timestampIndex = headers.indexOf('Carimbo de data/hora');
        const emailIndex = headers.indexOf('Nome de usuário');

        if (timestampIndex === -1 || emailIndex === -1) {
            throw new Error('CSV must contain the columns "Carimbo de data/hora" and "Nome de usuário".');
        }

        const latestByEmail = new Map();

        rows.forEach((row, rowIndex) => {
            const email = (row[emailIndex] || '').trim();
            if (!email) {
                return;
            }

            const timestamp = this.parseTimestamp((row[timestampIndex] || '').trim());
            const existing = latestByEmail.get(email);

            if (!existing || timestamp > existing.timestamp || (timestamp === existing.timestamp && rowIndex > existing.rowIndex)) {
                latestByEmail.set(email, { row, timestamp, rowIndex });
            }
        });

        return {
            headers,
            responses: Array.from(latestByEmail.entries())
                .sort(([emailA], [emailB]) => emailA.localeCompare(emailB, 'pt-BR'))
                .map(([email, entry]) => ({ email, row: entry.row })),
        };
    }

    parseTimestamp(value) {
        const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)\s+GMT([+-]\d+)$/i);

        if (!match) {
            return Number.NEGATIVE_INFINITY;
        }

        const [, year, month, day, rawHour, minute, second, meridiem, timezoneOffset] = match;
        let hour = Number(rawHour);

        if (meridiem.toUpperCase() === 'PM' && hour < 12) {
            hour += 12;
        }

        if (meridiem.toUpperCase() === 'AM' && hour === 12) {
            hour = 0;
        }

        const utcTimestamp = Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day),
            hour - Number(timezoneOffset),
            Number(minute),
            Number(second),
        );

        return utcTimestamp;
    }

    extractTimeSlots(headers) {
        return headers.slice(2).map((header, index) => {
            const normalizedHeader = header.replace(/\s+/g, ' ').trim();
            const periodMatch = normalizedHeader.match(/^(MANHÃ|TARDE|NOITE)/);
            const timeMatch = normalizedHeader.match(/(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})/);

            return {
                code: PERIOD_CODES[index] || `P${index + 1}`,
                header,
                label: normalizedHeader,
                period: periodMatch ? periodMatch[1] : 'OUTRO',
                time: timeMatch ? timeMatch[1].replace(/\s*-\s*/, ' - ') : normalizedHeader,
            };
        });
    }

    buildScheduleTable(timeSlots, responses, labelResolver) {
        return timeSlots.map((slot, slotIndex) => {
            const days = this.createEmptyDays();

            for (const response of responses) {
                const rawValue = (response.row[slotIndex + 2] || '').trim();
                if (!rawValue) {
                    continue;
                }

                const professorLabel = String(labelResolver(response) || '').trim();
                if (!professorLabel) {
                    continue;
                }

                const selectedDays = rawValue
                    .split(';')
                    .map(day => day.trim().toUpperCase())
                    .filter(Boolean);

                for (const day of selectedDays) {
                    if (!days[day]) {
                        days[day] = [];
                    }

                    days[day].push(professorLabel);
                }
            }

            for (const day of Object.keys(days)) {
                days[day] = Array.from(new Set(days[day]))
                    .sort((nameA, nameB) => nameA.localeCompare(nameB, 'pt-BR'));
            }

            return {
                code: slot.code,
                period: slot.period,
                time: slot.time,
                header: slot.label,
                days,
            };
        });
    }

    flattenEntries(scheduleTable) {
        const entries = [];

        for (const day of DAY_ORDER) {
            for (const slot of scheduleTable) {
                const professors = slot.days[day] || [];
                if (professors.length === 0) {
                    continue;
                }

                entries.push({
                    day,
                    code: slot.code,
                    time: slot.time,
                    professors,
                });
            }
        }

        return entries;
    }

    buildPeriodTimes(scheduleTable) {
        return Object.fromEntries(scheduleTable.map(slot => [slot.code, slot.time]));
    }

    buildClickData(scheduleTable, generatedAt) {
        const entries = this.flattenEntries(scheduleTable);
        const scheduleByDayAndPeriod = DAY_ORDER.reduce((days, day) => {
            days[day] = {};
            return days;
        }, {});
        const professorsByPeriod = {};
        const periodTimes = this.buildPeriodTimes(scheduleTable);

        for (const entry of entries) {
            scheduleByDayAndPeriod[entry.day][entry.code] = entry.professors;

            if (!professorsByPeriod[entry.code]) {
                professorsByPeriod[entry.code] = [];
            }

            professorsByPeriod[entry.code].push(...entry.professors);
        }

        for (const periodCode of Object.keys(professorsByPeriod)) {
            professorsByPeriod[periodCode] = Array.from(new Set(professorsByPeriod[periodCode]))
                .sort((nameA, nameB) => nameA.localeCompare(nameB, 'pt-BR'));
        }

        return {
            generatedAt,
            periodTimes,
            professorsByPeriod,
            scheduleByDayAndPeriod,
        };
    }

    createEmptyDays() {
        return DAY_ORDER.reduce((days, day) => {
            days[day] = [];
            return days;
        }, {});
    }

}

function main() {
    const baseDir = __dirname;
    const builder = new ProfessorScheduleBuilder(baseDir, 'form.csv', 'professors.json');
    const command = process.argv[2] || 'build';

    if (command === 'build') {
        builder.run();
        return;
    }

    if (command === 'sync-professors') {
        builder.syncProfessorAliasesFromHtml(process.argv[3] || SAMPLE_HTML_FILE);
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

main();
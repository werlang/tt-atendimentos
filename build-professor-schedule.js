const fs = require('fs');
const path = require('path');

const DAY_ORDER = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'];
const PERIOD_CODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'N0', 'N1', 'N2', 'N3', 'N4', 'N5'];

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

/**
 * Builds schedule click data by matching form responses against professor abbreviations.
 */
class ProfessorScheduleBuilder {
    /**
     * @param {string} baseDir - Base workspace directory.
     * @param {string} csvFileName - CSV file name (e.g. 'form.csv').
     * @param {string} mappingFileName - JSON file name (e.g. 'professors.json').
     */
    constructor(baseDir, csvFileName, mappingFileName) {
        this.baseDir = baseDir;
        this.csvPath = path.join(baseDir, csvFileName);
        this.mappingPath = path.join(baseDir, mappingFileName);
    }

    /**
     * Executes the schedule extraction and click-data generation process.
     */
    run() {
        const { headers, responses } = this.readLatestResponses();
        const timeSlots = this.extractTimeSlots(headers);
        const generatedAt = new Date().toISOString();
        const professors = this.readProfessors();
        const professorsByEmail = this.buildProfessorLookupByEmail(professors);
        const resolveProfessor = response => {
            const email = (response.email || '').toLowerCase();
            const username = email.split('@')[0];
            return professorsByEmail.get(email) || professorsByEmail.get(username) || null;
        };
        const matchedResponses = responses.filter(response => Boolean(resolveProfessor(response)));
        const matchedScheduleTable = this.buildScheduleTable(
            timeSlots,
            matchedResponses,
            response => resolveProfessor(response).short,
        );

        const clickData = this.buildClickData(matchedScheduleTable, generatedAt);
        const totalSlots = this.flattenEntries(matchedScheduleTable).length;

        const clickDataPath = path.join(this.baseDir, 'click-data.json');

        fs.writeFileSync(clickDataPath, `${JSON.stringify(clickData, null, 4)}\n`, 'utf8');

        console.log('Build concluído.');
        console.log(`Arquivo atualizado: ${path.basename(clickDataPath)}`);
        console.log(`Períodos com professores: ${totalSlots}`);
        console.log('');
        console.log('Próximos passos no navegador (EduPage):');
        console.log('1. Cole create-lessons.browser.js no console do EduPage');
        console.log('2. Rode: await createAllSlots()');
    }

    /**
     * Reads professors from the JSON mapping file.
     *
     * @returns {Array<{name: string, short: string, email: string|null}>}
     */
    readProfessors() {
        if (!fs.existsSync(this.mappingPath)) {
            return [];
        }

        const parsedProfessors = JSON.parse(fs.readFileSync(this.mappingPath, 'utf8'));

        if (Array.isArray(parsedProfessors)) {
            return parsedProfessors.map((professor, index) => this.normalizeProfessorRecord(professor, `index ${index}`));
        }

        if (parsedProfessors && typeof parsedProfessors === 'object') {
            return Object.entries(parsedProfessors)
                .map(([email, short]) => this.normalizeProfessorRecord({
                    name: short,
                    short,
                    email,
                }, email));
        }

        throw new Error(`${path.basename(this.mappingPath)} must contain either an array of professor records or an object keyed by email.`);
    }

    /**
     * Normalizes a raw professor record.
     *
     * @param {object} professor - Raw professor object.
     * @param {string} sourceLabel - Debug label for error messages.
     * @returns {{name: string, short: string, email: string|null}}
     */
    normalizeProfessorRecord(professor, sourceLabel) {
        const normalizedProfessor = {
            name: String(professor && professor.name ? professor.name : professor && professor.short ? professor.short : '').trim(),
            short: String(professor && professor.short ? professor.short : '').trim(),
            email: professor && professor.email ? String(professor.email).trim().toLowerCase() : null,
        };

        if (!normalizedProfessor.short) {
            throw new Error(`Professor record missing \"short\" in ${path.basename(this.mappingPath)} (${sourceLabel}).`);
        }

        if (!normalizedProfessor.name) {
            normalizedProfessor.name = normalizedProfessor.short;
        }

        return normalizedProfessor;
    }

    /**
     * Builds a Map index keyed by both email address and username prefix.
     *
     * @param {Array<{name: string, short: string, email: string|null}>} professors
     * @returns {Map<string, {name: string, short: string, email: string|null}>}
     */
    buildProfessorLookupByEmail(professors) {
        const professorsByEmail = new Map();

        for (const professor of professors) {
            if (!professor.email) {
                continue;
            }

            const email = professor.email.toLowerCase();
            if (professorsByEmail.has(email)) {
                throw new Error(`Duplicate professor email in ${path.basename(this.mappingPath)}: ${professor.email}`);
            }

            professorsByEmail.set(email, professor);

            const username = email.split('@')[0];
            if (username && !professorsByEmail.has(username)) {
                professorsByEmail.set(username, professor);
            }
        }

        return professorsByEmail;
    }

    /**
     * Reads form responses from CSV, deduplicating by email keeping only the latest submission.
     *
     * @returns {{headers: string[], responses: Array<{email: string, row: string[]}>}}
     */
    readLatestResponses() {
        const csvContent = fs.readFileSync(this.csvPath, 'utf8');
        const [headers, ...rows] = CsvParser.parse(csvContent);

        const timestampIndex = headers.findIndex(header => {
            const normalized = (header || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            return normalized.includes('carimbo') || normalized.includes('timestamp') || normalized.includes('data');
        });
        const emailIndex = headers.findIndex(header => {
            const normalized = (header || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            return normalized.includes('email') || normalized.includes('e-mail') || normalized.includes('usuario');
        });

        if (timestampIndex === -1 || emailIndex === -1) {
            throw new Error('CSV must contain a timestamp column ("Carimbo de data/hora") and an email column ("Endereço de e-mail" or "Nome de usuário").');
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

    /**
     * Parses multiple timestamp formats (Brazilian DD/MM/YYYY, GMT string, or ISO) to milliseconds UTC.
     *
     * @param {string} value - Raw timestamp string.
     * @returns {number} UTC timestamp in milliseconds.
     */
    parseTimestamp(value) {
        if (!value) {
            return Number.NEGATIVE_INFINITY;
        }

        const brMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
        if (brMatch) {
            const [, day, month, year, hour, minute, second] = brMatch;
            return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
        }

        const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)\s+GMT([+-]\d+)$/i);

        if (!match) {
            const parsed = Date.parse(value);
            return isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
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

    /**
     * Extracts time slot headers from the CSV headers row.
     *
     * @param {string[]} headers - Raw column headers.
     * @returns {Array<{code: string, header: string, label: string, period: string, time: string}>}
     */
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

    /**
     * Assembles a schedule matrix by slot and day.
     *
     * @param {Array<object>} timeSlots - Time slot definitions.
     * @param {Array<{email: string, row: string[]}>} responses - Filtered form responses.
     * @param {Function} labelResolver - Function returning professor abbreviation from response.
     * @returns {Array<object>}
     */
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
                    .split(/[,;]/)
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

    /**
     * Flattens schedule table entries into a list of day-slot professor selections.
     *
     * @param {Array<object>} scheduleTable
     * @returns {Array<{day: string, code: string, time: string, professors: string[]}>}
     */
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
    builder.run();
}

main();
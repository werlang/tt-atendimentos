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
        const professors = this.readProfessors();
        const professorsByEmail = this.buildProfessorLookupByEmail(professors);
        const matchedResponses = responses.filter(response => professorsByEmail.has(response.email));
        const matchedScheduleTable = this.buildScheduleTable(
            timeSlots,
            matchedResponses,
            response => professorsByEmail.get(response.email).short,
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

    buildProfessorLookupByEmail(professors) {
        const professorsByEmail = new Map();

        for (const professor of professors) {
            if (!professor.email) {
                continue;
            }

            if (professorsByEmail.has(professor.email)) {
                throw new Error(`Duplicate professor email in ${path.basename(this.mappingPath)}: ${professor.email}`);
            }

            professorsByEmail.set(professor.email, professor);
        }

        return professorsByEmail;
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
    builder.run();
}

main();
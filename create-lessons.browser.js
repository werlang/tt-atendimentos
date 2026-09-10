// ============================================================
// EDUPAGE TIMETABLES — AUTOMATIC LESSON & CARD CREATION
// Direct API helper for EduPage Timetables Online
//
// Usage in DevTools Console on https://ifsulcharq.edupage.org/timetable/online.php:
//   1. Paste this script into the console.
//   2. Run: await inspect()           // Checks EduPage metadata (teachers, days, periods)
//   3. Run: await testSlot('TER', 'T3') // Creates and places 1 test slot
//   4. Run: await createAllSlots()    // Creates all slots from click-data.json
// ============================================================

let clickData = null;
let eduMetadata = null;

const ENDPOINT = '/timetable/app/server/ttdoc.js?__func=ttuidocDBIAccessor';

const DAY_BITMASKS = {
    SEG: '10000',
    TER: '01000',
    QUA: '00100',
    QUI: '00010',
    SEX: '00001'
};

const DEFAULT_CONFIG = {
    subjectId: '*1',        // Atendimento
    classIds: ['*1'],       // Target class
    groupIds: ['*217'],     // Group
    weeksDefId: '*3',       // All weeks
    termsDefId: '*5',       // All terms
    durationPeriods: 1,
    count: 1
};

/**
 * Strips accents, punctuation, and trims text for resilient comparison.
 *
 * @param {string} value
 * @returns {string}
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
 * Retrieves the current timetable project ID (ttgpid) from URL or page context.
 *
 * @returns {number}
 */
function getTtgpid() {
    const urlParam = new URLSearchParams(window.location.search).get('ttgpid');
    if (urlParam) return Number(urlParam);
    if (window.EduPage && window.EduPage.ttgpid) return Number(window.EduPage.ttgpid);
    return 8588234;
}

/**
 * Retrieves the active session CSRF token (__gsh).
 *
 * @returns {string}
 */
function getGsh() {
    if (window.__gsh) return window.__gsh;
    if (window.EduPage && window.EduPage.gsh) return window.EduPage.gsh;

    // Search HTML source for __gsh token
    const html = document.documentElement.innerHTML;
    const match = html.match(/["']__gsh["']\s*:\s*["']([a-f0-9]+)["']/i)
        || html.match(/gsh\s*=\s*["']([a-f0-9]+)["']/i);
    if (match) return match[1];

    // Fallback: prompt user if not found automatically
    const prompted = window.prompt('Informe o token __gsh da sessão (ex: ee1abf16):');
    if (prompted) {
        window.__gsh = prompted.trim();
        return window.__gsh;
    }

    throw new Error('Não foi possível identificar o token __gsh da sessão.');
}

/**
 * Sends an authenticated JSON RPC request to the EduPage ttuidocDBIAccessor endpoint.
 *
 * @param {object} payload
 * @returns {Promise<any>}
 */
async function sendDbiRequest(payload) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'accept': '*/*',
            'content-type': 'application/json; charset=UTF-8',
            'cache-control': 'no-cache'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Falha na requisição (${response.status} ${response.statusText})`);
    }

    return response.json();
}

/**
 * Extracts rows from any EduPage DBI response structure (handles tables array, data.rows, or direct properties).
 *
 * @param {any} root
 * @param {string} tableName
 * @returns {Array<object>}
 */
function extractRowsFromDbi(root, tableName) {
    if (!root) return [];
    const r = root.r || root;

    // 1. Array of table objects: [{ id: "cards", data_rows: [...] }, ...]
    const tablesList = r.tables || (Array.isArray(r) ? r : (r.data && r.data.tables));
    if (Array.isArray(tablesList)) {
        const tbl = tablesList.find(t => t && (t.id === tableName || t.table === tableName || t.name === tableName));
        if (tbl) return tbl.data_rows || tbl.rows || tbl.data || [];
    }

    // 2. Direct property: r.cards or r.data.cards
    if (Array.isArray(r[tableName])) return r[tableName];
    if (r.data && Array.isArray(r.data[tableName])) return r.data[tableName];

    // 3. r.data is single table object: { table: "lessons", rows: [...] }
    if (r.data && (r.data.table === tableName || r.data.id === tableName)) {
        return r.data.rows || r.data.data_rows || [];
    }

    // 4. r is single table object: { table: "lessons", rows: [...] }
    if (r.table === tableName || r.id === tableName) {
        return r.rows || r.data_rows || [];
    }

    // 5. r.rows or r.data.rows
    if (Array.isArray(r.rows)) return r.rows;
    if (r.data && Array.isArray(r.data.rows)) return r.data.rows;

    return [];
}

/**
 * Fetches timetable metadata from EduPage (teachers, daysdefs, periods, subjects, classes, etc.).
 *
 * @returns {Promise<object>}
 */
async function fetchEduMetadata() {
    const ttgpid = getTtgpid();
    const gsh = getGsh();

    console.log(`Buscando metadados do EduPage (ttgpid: ${ttgpid})...`);

    const requestBody = {
        __args: [
            null,
            ttgpid,
            {
                op: 'fetch',
                needed_part: {
                    teachers: ['short', 'name', 'firstname', 'lastname', 'classroomids', 'color'],
                    subjects: ['short', 'name', 'metaclassroomids'],
                    classes: ['short', 'name', 'classroomids'],
                    groups: ['classid', 'name', 'entireclass'],
                    daysdefs: ['short', 'name', 'vals', 'typ'],
                    periods: ['short', 'name', 'period', 'starttime', 'endtime'],
                    weeksdefs: ['short', 'name', 'vals', 'typ'],
                    termsdefs: ['short', 'name', 'vals', 'typ']
                },
                needed_combos: {}
            }
        ],
        __gsh: gsh
    };

    const res = await sendDbiRequest(requestBody);

    eduMetadata = {
        teachers: extractRowsFromDbi(res, 'teachers'),
        daysdefs: extractRowsFromDbi(res, 'daysdefs'),
        periods: extractRowsFromDbi(res, 'periods'),
        subjects: extractRowsFromDbi(res, 'subjects'),
        classes: extractRowsFromDbi(res, 'classes'),
        groups: extractRowsFromDbi(res, 'groups'),
        weeksdefs: extractRowsFromDbi(res, 'weeksdefs'),
        termsdefs: extractRowsFromDbi(res, 'termsdefs')
    };

    return eduMetadata;
}

/**
 * File picker prompt to load click-data.json.
 *
 * @returns {Promise<object>}
 */
async function loadClickDataFile() {
    if (clickData) return clickData;

    let text = '';
    if (typeof window.showOpenFilePicker === 'function') {
        const [handle] = await window.showOpenFilePicker({
            multiple: false,
            types: [{ description: 'JSON data', accept: { 'application/json': ['.json'] } }]
        });
        const file = await handle.getFile();
        text = await file.text();
    } else {
        text = await new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.style.display = 'none';
            input.addEventListener('change', async event => {
                const file = event.target.files && event.target.files[0];
                if (!file) return reject(new Error('Nenhum arquivo selecionado.'));
                resolve(await file.text());
            }, { once: true });
            document.body.appendChild(input);
            input.click();
            setTimeout(() => input.remove(), 0);
        });
    }

    clickData = JSON.parse(text);
    console.log('click-data.json carregado com sucesso!');
    return clickData;
}

/**
 * Maps a list of professor names from click-data.json to internal EduPage teacher IDs.
 *
 * @param {string[]} professorNames
 * @param {Array<object>} teachers
 * @returns {{ teacherIds: string[], missing: string[] }}
 */
function resolveTeacherIds(professorNames, teachers) {
    const teacherIds = [];
    const missing = [];

    const normalizedTeachers = teachers.map(t => ({
        id: t.id,
        normShort: normalizeText(t.short),
        normName: normalizeText(t.name),
        normFull: normalizeText(`${t.firstname || ''} ${t.lastname || ''}`.trim())
    }));

    for (const name of professorNames) {
        const norm = normalizeText(name);
        const match = normalizedTeachers.find(t =>
            t.normShort === norm ||
            t.normName === norm ||
            t.normFull === norm ||
            t.normName.includes(norm) ||
            norm.includes(t.normShort)
        );

        if (match && match.id) {
            teacherIds.push(match.id);
        } else {
            missing.push(name);
        }
    }

    return { teacherIds, missing };
}

/**
 * Resolves the daysdef ID for a given day code (SEG, TER, QUA, QUI, SEX).
 *
 * @param {string} dayCode
 * @param {Array<object>} daysdefs
 * @returns {string|null}
 */
function resolveDaysDefId(dayCode, daysdefs) {
    const bitmask = DAY_BITMASKS[dayCode.toUpperCase()];
    if (!bitmask) return null;

    const match = daysdefs.find(d => Array.isArray(d.vals) && d.vals.includes(bitmask));
    return match ? match.id : null;
}

/**
 * Resolves the EduPage period index for a given period code (e.g. M3, T3).
 *
 * @param {string} periodCode
 * @param {Array<object>} periods
 * @param {object} periodTimes
 * @returns {string}
 */
function resolvePeriodValue(periodCode, periods, periodTimes) {
    const code = periodCode.toUpperCase().trim();
    const timeRange = periodTimes && periodTimes[code] ? periodTimes[code] : '';
    const startTime = timeRange.split('-')[0] ? timeRange.split('-')[0].trim() : '';

    // 1. Match by period.short or period.name
    const matchByShort = periods.find(p =>
        normalizeText(p.short) === normalizeText(code) ||
        normalizeText(p.name) === normalizeText(code)
    );
    if (matchByShort) return String(matchByShort.period || matchByShort.id || matchByShort.short);

    // 2. Match by starttime
    if (startTime) {
        const matchByTime = periods.find(p => p.starttime && p.starttime.includes(startTime));
        if (matchByTime) return String(matchByTime.period || matchByTime.id || matchByTime.short);
    }

    // 3. Fallback: standard period code number extraction (e.g. "T3" -> "3", "M4" -> "4")
    const numMatch = code.match(/\d+/);
    return numMatch ? numMatch[0] : '1';
}


/**
 * Extracts the created lesson ID from the add lesson response.
 *
 * @param {object} addResponse
 * @returns {string|null}
 */
function extractCreatedLessonId(addResponse) {
    if (!addResponse) return null;
    const lessonRows = extractRowsFromDbi(addResponse, 'lessons');
    if (lessonRows.length > 0 && lessonRows[0].id) {
        return lessonRows[0].id;
    }

    // Fallback: search for any ID string starting with '*'
    const raw = JSON.stringify(addResponse);
    const matches = raw.match(/"id"\s*:\s*"(\*[0-9]+)"/g);
    if (matches && matches.length > 0) {
        const idMatch = matches[0].match(/"(\*[0-9]+)"/);
        return idMatch ? idMatch[1] : null;
    }

    return null;
}

/**
 * Extracts the created card ID from the add lesson response, or queries via fetch fallback.
 *
 * @param {object} addResponse
 * @param {string} createdLessonId
 * @returns {Promise<string|null>}
 */
async function extractCardId(addResponse, createdLessonId) {
    // 1. Direct card returned in addResponse
    const directCards = extractRowsFromDbi(addResponse, 'cards');
    if (directCards.length > 0) {
        const match = (createdLessonId ? directCards.find(c => c.lessonid === createdLessonId) : null) || directCards[0];
        if (match && match.id) {
            console.log(`Cartão encontrado diretamente no addResponse: ${match.id}`);
            return match.id;
        }
    }

    // 2. Query EduPage cards table
    const ttgpid = getTtgpid();
    const gsh = getGsh();

    console.log(`Consultando tabela de cartões no EduPage para vincular à aula ${createdLessonId || ''}...`);
    const query = {
        __args: [
            null,
            ttgpid,
            {
                op: 'fetch',
                needed_part: { cards: ['id', 'lessonid', 'period', 'days', 'weeks'] },
                needed_combos: {}
            }
        ],
        __gsh: gsh
    };

    const queryRes = await sendDbiRequest(query);
    const allCards = extractRowsFromDbi(queryRes, 'cards');
    console.log(`Total de cartões recuperados do EduPage: ${allCards.length}`);

    // If we have createdLessonId, match by lessonid
    if (createdLessonId) {
        const match = allCards.find(c => c && (c.lessonid === createdLessonId || c.lesson_id === createdLessonId));
        if (match && match.id) {
            console.log(`Cartão associado à aula ${createdLessonId} localizado: ${match.id}`);
            return match.id;
        }
    }

    // Fallback: look for newly created card that is unassigned (empty period or days)
    const unallocated = allCards.filter(c => !c.period || c.period === '' || c.period === '0');
    if (unallocated.length > 0) {
        const candidate = unallocated[unallocated.length - 1];
        console.log(`Cartão não alocado selecionado como fallback: ${candidate.id}`);
        return candidate.id;
    }

    return null;
}

/**
 * Creates a lesson and places its card for a specific slot (e.g. TER T3).
 *
 * @param {string} dayCode - Day abbreviation (SEG, TER, QUA, QUI, SEX).
 * @param {string} periodCode - Period code (e.g. M3, T2, T3).
 * @param {string[]} professorNames - Array of professor names.
 * @param {object} [customConfig] - Optional overrides for IDs.
 * @returns {Promise<object>}
 */
async function createAndAssignSlot(dayCode, periodCode, professorNames, customConfig = {}) {
    if (!eduMetadata) await fetchEduMetadata();

    const ttgpid = getTtgpid();
    const gsh = getGsh();
    const config = { ...DEFAULT_CONFIG, ...customConfig };

    const normDay = dayCode.toUpperCase().trim();
    const normPeriod = periodCode.toUpperCase().trim();

    // 1. Resolve Day Definition & Bitmask
    const dayBitmask = DAY_BITMASKS[normDay];
    if (!dayBitmask) throw new Error(`Dia desconhecido: ${normDay}`);
    const daysDefId = resolveDaysDefId(normDay, eduMetadata.daysdefs) || '*6';

    // 2. Resolve Period Value
    const periodValue = resolvePeriodValue(normPeriod, eduMetadata.periods, clickData ? clickData.periodTimes : {});

    // 3. Resolve Teacher IDs
    const { teacherIds, missing } = resolveTeacherIds(professorNames, eduMetadata.teachers);
    if (missing.length > 0) {
        console.warn(`[${normDay} ${normPeriod}] Professores não localizados no EduPage:`, missing.join(', '));
    }

    console.log(`[${normDay} ${normPeriod}] Criando aula com ${teacherIds.length} professores (daysdef: ${daysDefId}, period: ${periodValue})...`);

    // 4. Create the Lesson
    const addLessonPayload = {
        __args: [
            null,
            ttgpid,
            {
                op: 'add',
                data: {
                    table: 'lessons',
                    rows: [
                        {
                            subjectid: config.subjectId,
                            teacherids: teacherIds,
                            metaclassroomidss: [['*teacher']],
                            classids: config.classIds,
                            groupids: config.groupIds,
                            seminargroup: null,
                            count: config.count,
                            durationperiods: config.durationPeriods,
                            daysdefid: daysDefId,
                            weeksdefid: config.weeksDefId,
                            termsdefid: config.termsDefId,
                            bell: '',
                            minstudents: null,
                            maxstudents: null,
                            distrib: '',
                            minutes: null,
                            _uial: null
                        }
                    ]
                }
            }
        ],
        __gsh: gsh
    };

    const addResponse = await sendDbiRequest(addLessonPayload);
    const createdLessonId = extractCreatedLessonId(addResponse);
    console.log(`[${normDay} ${normPeriod}] Aula criada com ID: ${createdLessonId || '(não retornado diretamente)'}`);

    // 5. Extract Card ID
    const cardId = await extractCardId(addResponse, createdLessonId);

    // 6. Assign Card to Time Slot & Day
    let cardUpdateResponse = null;
    if (cardId) {
        console.log(`[${normDay} ${normPeriod}] Alocando cartão ${cardId} no período ${periodValue} (dias: ${dayBitmask})...`);
        const updateCardPayload = {
            __args: [
                null,
                ttgpid,
                {
                    op: 'update',
                    data: {
                        table: 'cards',
                        rows: [
                            {
                                id: cardId,
                                period: String(periodValue),
                                days: dayBitmask,
                                weeks: '1',
                                locked: false,
                                classroomids: []
                            }
                        ]
                    },
                    log_module: 'useLocalDbi'
                }
            ],
            __gsh: gsh
        };
        cardUpdateResponse = await sendDbiRequest(updateCardPayload);
        console.log(`[${normDay} ${normPeriod}] Cartão ${cardId} alocado com sucesso!`);
    } else {
        console.warn(`[${normDay} ${normPeriod}] Cartão não identificado para alocação automática.`);
    }

    return {
        day: normDay,
        period: normPeriod,
        lessonId: createdLessonId,
        cardId,
        teachersCount: teacherIds.length,
        missingTeachers: missing,
        addResponse,
        cardUpdateResponse
    };
}

/**
 * Allocates the latest unassigned card (or a specific card ID) to a day and period.
 * Useful to allocate cards that were already created earlier.
 *
 * @param {string} [dayCode='TER']
 * @param {string} [periodCode='T3']
 * @param {string} [specificCardId]
 */
async function allocatePendingCard(dayCode = 'TER', periodCode = 'T3', specificCardId = null) {
    if (!eduMetadata) await fetchEduMetadata();
    const ttgpid = getTtgpid();
    const gsh = getGsh();

    const normDay = dayCode.toUpperCase().trim();
    const normPeriod = periodCode.toUpperCase().trim();
    const dayBitmask = DAY_BITMASKS[normDay];
    const periodValue = resolvePeriodValue(normPeriod, eduMetadata.periods, clickData ? clickData.periodTimes : {});

    let cardId = specificCardId;
    if (!cardId) {
        const query = {
            __args: [null, ttgpid, { op: 'fetch', needed_part: { cards: ['id', 'lessonid', 'period', 'days'] }, needed_combos: {} }],
            __gsh: gsh
        };
        const queryRes = await sendDbiRequest(query);
        const allCards = extractRowsFromDbi(queryRes, 'cards');
        const unallocated = allCards.filter(c => !c.period || c.period === '' || c.period === '0');
        if (unallocated.length === 0) {
            console.warn('Nenhum cartão pendente/não alocado encontrado.');
            return;
        }
        cardId = unallocated[unallocated.length - 1].id;
    }

    console.log(`Alocando cartão pendente ${cardId} para ${normDay} ${normPeriod} (período: ${periodValue}, dias: ${dayBitmask})...`);
    const updatePayload = {
        __args: [
            null,
            ttgpid,
            {
                op: 'update',
                data: {
                    table: 'cards',
                    rows: [{
                        id: cardId,
                        period: String(periodValue),
                        days: dayBitmask,
                        weeks: '1',
                        locked: false,
                        classroomids: []
                    }]
                },
                log_module: 'useLocalDbi'
            }
        ],
        __gsh: gsh
    };

    const res = await sendDbiRequest(updatePayload);
    console.log(`Sucesso! Cartão ${cardId} alocado:`, res);
    return res;
}

/**
 * Inspects and logs the EduPage environment and database tables.
 */
async function inspect() {
    console.log('=== EDUPAGE TIMETABLES INSPECTOR ===');
    const ttgpid = getTtgpid();
    const gsh = getGsh();
    console.log(`TTGPID: ${ttgpid} | GSH: ${gsh}`);

    const meta = await fetchEduMetadata();

    console.log('\n--- Professores cadastrados no EduPage (' + meta.teachers.length + ') ---');
    console.table(meta.teachers.slice(0, 10).map(t => ({ id: t.id, short: t.short, name: t.name })));

    console.log('\n--- Definições de Dias (daysdefs: ' + meta.daysdefs.length + ') ---');
    console.table(meta.daysdefs.map(d => ({ id: d.id, short: d.short, name: d.name, vals: (d.vals || []).join(',') })));

    console.log('\n--- Períodos / Horários (periods: ' + meta.periods.length + ') ---');
    console.table(meta.periods.map(p => ({ period: p.period || p.id, short: p.short, name: p.name, starttime: p.starttime, endtime: p.endtime })));

    console.log('\n--- Disciplinas (subjects: ' + meta.subjects.length + ') ---');
    console.table(meta.subjects.slice(0, 10).map(s => ({ id: s.id, short: s.short, name: s.name })));

    console.log('\n--- Turmas (classes: ' + meta.classes.length + ') ---');
    console.table(meta.classes.slice(0, 10).map(c => ({ id: c.id, short: c.short, name: c.name })));

    console.log('\nInspeção concluída! Pronto para testar com testSlot("TER", "T3").');
}

/**
 * Creates and assigns 1 test slot (reads professors from click-data.json or uses a sample list).
 *
 * @param {string} [dayCode='TER']
 * @param {string} [periodCode='T3']
 */
async function testSlot(dayCode = 'TER', periodCode = 'T3') {
    await loadClickDataFile();

    const normDay = dayCode.toUpperCase();
    const normPeriod = periodCode.toUpperCase();

    const professors = (clickData.scheduleByDayAndPeriod[normDay] && clickData.scheduleByDayAndPeriod[normDay][normPeriod])
        || clickData.professorsByPeriod[normPeriod]
        || ['Pablo', 'Rodrigo'];

    console.log(`\n=== TESTANDO CRIAÇÃO DE SLOT: ${normDay} ${normPeriod} ===`);
    console.log('Professores:', professors.join(', '));

    const result = await createAndAssignSlot(normDay, normPeriod, professors);
    console.log('Resultado do teste:', result);
    console.log('\nSucesso! Recarregue ou verifique a grade no EduPage para ver a aula inserida.');
}

/**
 * Iterates through all slots in click-data.json and creates/assigns all lessons.
 */
async function createAllSlots() {
    await loadClickDataFile();
    await fetchEduMetadata();

    const dayOrder = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'];
    const periodOrder = Object.keys(clickData.periodTimes);

    const queue = [];
    for (const day of dayOrder) {
        const daySlots = clickData.scheduleByDayAndPeriod[day] || {};
        for (const period of periodOrder) {
            const professors = daySlots[period];
            if (Array.isArray(professors) && professors.length > 0) {
                queue.push({ day, period, professors });
            }
        }
    }

    console.log(`\n=== INICIANDO CRIAÇÃO DE ${queue.length} AULAS ===`);
    const confirmRun = window.confirm(`Deseja criar automaticamente ${queue.length} aulas de atendimento na grade do Timetables?`);
    if (!confirmRun) return;

    const results = [];
    for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        console.log(`\n[${index + 1}/${queue.length}] Processando ${item.day} ${item.period}...`);

        try {
            const res = await createAndAssignSlot(item.day, item.period, item.professors);
            results.push(res);
        } catch (err) {
            console.error(`Erro no slot ${item.day} ${item.period}:`, err.message);
        }

        // Small cooldown between requests to avoid server throttling
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log('\n=============================================');
    console.log(`FINALIZADO! ${results.length}/${queue.length} aulas criadas com sucesso.`);
    console.log('Recarregue a página do EduPage para visualizar a grade completa.');
    console.log('=============================================');
}

console.log('=== Helper Carregado ===');
console.log('Comandos disponíveis:');
console.log('  await inspect()                      // Visualiza metadados e tabelas do EduPage');
console.log('  await allocatePendingCard("TER", "T3") // Aloca na grade o cartão que já foi criado');
console.log('  await testSlot("TER", "T3")          // Cria aula e aloca cartão em 1 slot');
console.log('  await createAllSlots()               // Cria todas as aulas e cartões do click-data.json');

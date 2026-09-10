// ============================================================
// EDUPAGE TIMETABLES — AUTOMATIC LESSON & CARD CREATION (WITH UI)
// Direct API helper & Floating In-Page Control Panel for EduPage
//
// Usage:
//   Paste this entire script into DevTools Console on:
//   https://ifsulcharq.edupage.org/timetable/online.php
//
// A floating UI will appear automatically where you can:
//   1. Upload/drop click-data.json
//   2. Inspect EduPage metadata
//   3. Test individual slots
//   4. Allocate pending cards
//   5. Run the full schedule generation with live streaming logs
// ============================================================

(function () {
    'use strict';

    const ENDPOINT = '/timetable/app/server/ttdoc.js?__func=ttuidocDBIAccessor';

    const DAY_BITMASKS = {
        SEG: '10000',
        TER: '01000',
        QUA: '00100',
        QUI: '00010',
        SEX: '00001'
    };

    const DEFAULT_CONFIG = {
        subjectId: '*1',
        classIds: ['*1'],
        groupIds: ['*217'],
        weeksDefId: '*3',
        termsDefId: '*5',
        durationPeriods: 1,
        count: 1
    };

    let state = {
        clickData: null,
        eduMetadata: null,
        isRunning: false,
        abortRequested: false,
        stats: { total: 0, success: 0, warn: 0, error: 0 },
        logs: []
    };

    // ============================================================
    // UTILITIES & DATA NORMALIZATION
    // ============================================================

    function normalizeText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    function getTtgpid() {
        const urlParam = new URLSearchParams(window.location.search).get('ttgpid');
        if (urlParam) return Number(urlParam);
        if (window.EduPage && window.EduPage.ttgpid) return Number(window.EduPage.ttgpid);
        return 8588234;
    }

    function scanWindowForGsh() {
        if (window.__gsh) return window.__gsh;
        if (window.gsh) return window.gsh;
        if (window._gsh) return window._gsh;

        const namespaces = [window.EduPage, window.edupage, window.ASC, window.asc, window.ttdoc, window.g_data, window._tt];
        for (const ns of namespaces) {
            if (ns && typeof ns === 'object') {
                if (typeof ns.gsh === 'string' && /^[a-f0-9]+$/i.test(ns.gsh)) return ns.gsh;
                if (typeof ns.__gsh === 'string' && /^[a-f0-9]+$/i.test(ns.__gsh)) return ns.__gsh;
                if (typeof ns._gsh === 'string' && /^[a-f0-9]+$/i.test(ns._gsh)) return ns._gsh;
            }
        }
        return null;
    }

    function scanScriptsForGsh() {
        for (const script of document.querySelectorAll('script')) {
            const text = script.textContent || '';
            const match = text.match(/(?:__)?gsh["']?\s*[:=]\s*["']([a-f0-9]{6,32})["']/i);
            if (match) return match[1];
        }
        return null;
    }

    function detectGsh() {
        const stored = sessionStorage.getItem('edupage_gsh');
        if (stored) return stored;

        const fromWindow = scanWindowForGsh();
        if (fromWindow) {
            sessionStorage.setItem('edupage_gsh', fromWindow);
            return fromWindow;
        }

        const fromScripts = scanScriptsForGsh();
        if (fromScripts) {
            sessionStorage.setItem('edupage_gsh', fromScripts);
            return fromScripts;
        }

        return null;
    }

    function getGsh() {
        // 1. Check UI input field first (respects user manual edit)
        const uiInput = ui?.shadow?.querySelector('#input-gsh')?.value?.trim();
        if (uiInput) {
            sessionStorage.setItem('edupage_gsh', uiInput);
            return uiInput;
        }

        // 2. Try auto-detecting
        const detected = detectGsh();
        if (detected) {
            if (ui) ui.updateConfigInput('gsh', detected);
            return detected;
        }

        // 3. Fallback: prompt user once
        const prompted = window.prompt(
            'Token __gsh não detectado automaticamente.\n\n' +
            'Por favor, informe o token __gsh da sessão (ex: ee1abf16):\n' +
            '(Dica: no DevTools > Network, veja o payload de qualquer requisição para ttdoc.js)'
        );
        if (prompted && prompted.trim()) {
            const clean = prompted.trim();
            window.__gsh = clean;
            sessionStorage.setItem('edupage_gsh', clean);
            if (ui) ui.updateConfigInput('gsh', clean);
            return clean;
        }

        return null;
    }

    // ============================================================
    // DBI API CLIENT
    // ============================================================

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
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
    }

    function extractRowsFromDbi(root, tableName) {
        if (!root) return [];
        const r = root.r || root;

        const tablesList = r.tables || (Array.isArray(r) ? r : (r.data && r.data.tables));
        if (Array.isArray(tablesList)) {
            const tbl = tablesList.find(t => t && (t.id === tableName || t.table === tableName || t.name === tableName));
            if (tbl) return tbl.data_rows || tbl.rows || tbl.data || [];
        }

        if (Array.isArray(r[tableName])) return r[tableName];
        if (r.data && Array.isArray(r.data[tableName])) return r.data[tableName];

        if (r.data && (r.data.table === tableName || r.data.id === tableName)) {
            return r.data.rows || r.data.data_rows || [];
        }

        if (r.table === tableName || r.id === tableName) {
            return r.rows || r.data_rows || [];
        }

        if (Array.isArray(r.rows)) return r.rows;
        if (r.data && Array.isArray(r.data.rows)) return r.data.rows;

        return [];
    }

    async function fetchEduMetadata() {
        const ttgpid = getTtgpid();
        const gsh = getGsh();
        if (!gsh) throw new Error('Token __gsh não encontrado. Abra a página do horário no EduPage.');

        ui.addLog('info', `Buscando metadados do EduPage (ttgpid: ${ttgpid})...`);

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

        state.eduMetadata = {
            teachers: extractRowsFromDbi(res, 'teachers'),
            daysdefs: extractRowsFromDbi(res, 'daysdefs'),
            periods: extractRowsFromDbi(res, 'periods'),
            subjects: extractRowsFromDbi(res, 'subjects'),
            classes: extractRowsFromDbi(res, 'classes'),
            groups: extractRowsFromDbi(res, 'groups'),
            weeksdefs: extractRowsFromDbi(res, 'weeksdefs'),
            termsdefs: extractRowsFromDbi(res, 'termsdefs')
        };

        // Auto-detect "Atendimento" subject if exists
        const atendimentoSubject = state.eduMetadata.subjects.find(s =>
            normalizeText(s.name).includes('atendimento') || normalizeText(s.short).includes('atend')
        );
        if (atendimentoSubject && atendimentoSubject.id) {
            DEFAULT_CONFIG.subjectId = atendimentoSubject.id;
            ui.updateConfigInput('subjectId', atendimentoSubject.id);
            ui.addLog('info', `Disciplina detectada: ${atendimentoSubject.name} (${atendimentoSubject.id})`);
        }

        ui.addLog('success', `Metadados carregados: ${state.eduMetadata.teachers.length} professores, ${state.eduMetadata.periods.length} períodos, ${state.eduMetadata.daysdefs.length} dias.`);
        return state.eduMetadata;
    }

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

    function resolveDaysDefId(dayCode, daysdefs) {
        const bitmask = DAY_BITMASKS[dayCode.toUpperCase()];
        if (!bitmask) return null;

        const match = daysdefs.find(d => Array.isArray(d.vals) && d.vals.includes(bitmask));
        return match ? match.id : null;
    }

    function resolvePeriodValue(periodCode, periods, periodTimes) {
        const code = periodCode.toUpperCase().trim();
        const timeRange = periodTimes && periodTimes[code] ? periodTimes[code] : '';
        const startTime = timeRange.split('-')[0] ? timeRange.split('-')[0].trim() : '';

        const matchByShort = periods.find(p =>
            normalizeText(p.short) === normalizeText(code) ||
            normalizeText(p.name) === normalizeText(code)
        );
        if (matchByShort) return String(matchByShort.period || matchByShort.id || matchByShort.short);

        if (startTime) {
            const matchByTime = periods.find(p => p.starttime && p.starttime.includes(startTime));
            if (matchByTime) return String(matchByTime.period || matchByTime.id || matchByTime.short);
        }

        const numMatch = code.match(/\d+/);
        return numMatch ? numMatch[0] : '1';
    }

    function extractCreatedLessonId(addResponse) {
        if (!addResponse) return null;
        const lessonRows = extractRowsFromDbi(addResponse, 'lessons');
        if (lessonRows.length > 0 && lessonRows[0].id) {
            return lessonRows[0].id;
        }

        const raw = JSON.stringify(addResponse);
        const matches = raw.match(/"id"\s*:\s*"(\*[0-9]+)"/g);
        if (matches && matches.length > 0) {
            const idMatch = matches[0].match(/"(\*[0-9]+)"/);
            return idMatch ? idMatch[1] : null;
        }

        return null;
    }

    async function extractCardId(addResponse, createdLessonId) {
        const directCards = extractRowsFromDbi(addResponse, 'cards');
        if (directCards.length > 0) {
            const match = (createdLessonId ? directCards.find(c => c.lessonid === createdLessonId) : null) || directCards[0];
            if (match && match.id) return match.id;
        }

        const ttgpid = getTtgpid();
        const gsh = getGsh();

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

        if (createdLessonId) {
            const match = allCards.find(c => c && (c.lessonid === createdLessonId || c.lesson_id === createdLessonId));
            if (match && match.id) return match.id;
        }

        const unallocated = allCards.filter(c => !c.period || c.period === '' || c.period === '0');
        if (unallocated.length > 0) {
            return unallocated[unallocated.length - 1].id;
        }

        return null;
    }

    async function createAndAssignSlot(dayCode, periodCode, professorNames, customConfig = {}) {
        if (!state.eduMetadata) await fetchEduMetadata();

        const ttgpid = getTtgpid();
        const gsh = getGsh();
        const config = { ...DEFAULT_CONFIG, ...ui.getConfig(), ...customConfig };

        const normDay = dayCode.toUpperCase().trim();
        const normPeriod = periodCode.toUpperCase().trim();

        const dayBitmask = DAY_BITMASKS[normDay];
        if (!dayBitmask) throw new Error(`Dia desconhecido: ${normDay}`);
        const daysDefId = resolveDaysDefId(normDay, state.eduMetadata.daysdefs) || '*6';

        const periodValue = resolvePeriodValue(normPeriod, state.eduMetadata.periods, state.clickData ? state.clickData.periodTimes : {});

        const { teacherIds, missing } = resolveTeacherIds(professorNames, state.eduMetadata.teachers);
        if (missing.length > 0) {
            ui.addLog('warn', `[${normDay} ${normPeriod}] Professores não encontrados no EduPage: ${missing.join(', ')}`);
            state.stats.warn += 1;
        }

        ui.addLog('info', `[${normDay} ${normPeriod}] Criando aula (${teacherIds.length} profs, daysdef: ${daysDefId}, período: ${periodValue})...`);

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
                                classids: Array.isArray(config.classIds) ? config.classIds : [config.classIds],
                                groupids: Array.isArray(config.groupIds) ? config.groupIds : [config.groupIds],
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

        const cardId = await extractCardId(addResponse, createdLessonId);
        let cardUpdateResponse = null;

        if (cardId) {
            ui.addLog('info', `[${normDay} ${normPeriod}] Alocando cartão ${cardId} no período ${periodValue}...`);
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
            ui.addLog('success', `[${normDay} ${normPeriod}] Aula ${createdLessonId || ''} e Cartão ${cardId} alocados com sucesso!`);
            state.stats.success += 1;
        } else {
            ui.addLog('warn', `[${normDay} ${normPeriod}] Aula criada (${createdLessonId}), mas o cartão não pôde ser identificado automaticamente.`);
            state.stats.warn += 1;
        }

        ui.updateStats();

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

    async function allocatePendingCard(dayCode = 'TER', periodCode = 'T3', specificCardId = null) {
        if (!state.eduMetadata) await fetchEduMetadata();
        const ttgpid = getTtgpid();
        const gsh = getGsh();

        const normDay = dayCode.toUpperCase().trim();
        const normPeriod = periodCode.toUpperCase().trim();
        const dayBitmask = DAY_BITMASKS[normDay];
        const periodValue = resolvePeriodValue(normPeriod, state.eduMetadata.periods, state.clickData ? state.clickData.periodTimes : {});

        let cardId = specificCardId;
        if (!cardId) {
            ui.addLog('info', `Buscando cartão não alocado para ${normDay} ${normPeriod}...`);
            const query = {
                __args: [null, ttgpid, { op: 'fetch', needed_part: { cards: ['id', 'lessonid', 'period', 'days'] }, needed_combos: {} }],
                __gsh: gsh
            };
            const queryRes = await sendDbiRequest(query);
            const allCards = extractRowsFromDbi(queryRes, 'cards');
            const unallocated = allCards.filter(c => !c.period || c.period === '' || c.period === '0');
            if (unallocated.length === 0) {
                ui.addLog('warn', 'Nenhum cartão pendente/não alocado encontrado no EduPage.');
                return null;
            }
            cardId = unallocated[unallocated.length - 1].id;
        }

        ui.addLog('info', `Alocando cartão pendente ${cardId} para ${normDay} ${normPeriod} (período: ${periodValue}, dias: ${dayBitmask})...`);
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
        ui.addLog('success', `Cartão ${cardId} alocado com sucesso em ${normDay} ${normPeriod}!`);
        state.stats.success += 1;
        ui.updateStats();
        return res;
    }

    // ============================================================
    // FLOATING UI CONTROLLER (SHADOW DOM)
    // ============================================================

    class TimetablesUI {
        constructor() {
            this.hostId = 'edupage-atendimentos-root';
            this.container = null;
            this.shadow = null;
            this.isMinimized = false;
        }

        mount() {
            const existing = document.getElementById(this.hostId);
            if (existing) existing.remove();

            const host = document.createElement('div');
            host.id = this.hostId;
            host.style.position = 'fixed';
            host.style.top = '16px';
            host.style.right = '16px';
            host.style.zIndex = '9999999';
            host.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

            this.shadow = host.attachShadow({ mode: 'open' });
            this.shadow.innerHTML = this.renderTemplate();
            document.body.appendChild(host);

            this.container = this.shadow.querySelector('.panel');
            this.bindEvents();
            this.setupDraggable();
            this.initSessionValues();
            this.addLog('info', 'Interface inicializada. Faça upload do click-data.json para começar.');
        }

        renderTemplate() {
            return `
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    .panel {
                        width: 440px;
                        max-height: calc(100vh - 32px);
                        background: #0f172a;
                        color: #f8fafc;
                        border-radius: 12px;
                        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5), 0 0 0 1px #334155;
                        display: flex;
                        flex-direction: column;
                        overflow: hidden;
                        font-size: 13px;
                    }
                    .header {
                        background: #1e293b;
                        padding: 12px 16px;
                        cursor: move;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        border-bottom: 1px solid #334155;
                        user-select: none;
                    }
                    .header-title {
                        font-weight: 700;
                        font-size: 14px;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        color: #38bdf8;
                    }
                    .header-actions { display: flex; gap: 6px; }
                    .icon-btn {
                        background: transparent;
                        border: none;
                        color: #94a3b8;
                        cursor: pointer;
                        padding: 4px;
                        border-radius: 4px;
                        font-size: 14px;
                        line-height: 1;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        width: 24px;
                        height: 24px;
                    }
                    .icon-btn:hover { background: #334155; color: #f8fafc; }
                    .content {
                        padding: 14px 16px;
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                        overflow-y: auto;
                        flex: 1;
                    }
                    .panel.minimized .content { display: none; }

                    /* Dropzone */
                    .dropzone {
                        border: 2px dashed #475569;
                        background: #1e293b;
                        border-radius: 8px;
                        padding: 14px;
                        text-align: center;
                        cursor: pointer;
                        transition: all 0.2s;
                    }
                    .dropzone:hover, .dropzone.dragover {
                        border-color: #38bdf8;
                        background: #1e293b;
                    }
                    .dropzone-text { color: #cbd5e1; font-weight: 500; font-size: 12px; }
                    .dropzone-sub { color: #64748b; font-size: 11px; margin-top: 4px; }
                    .dropzone.loaded {
                        border-style: solid;
                        border-color: #22c55e;
                        background: rgba(34, 197, 94, 0.1);
                    }
                    .dropzone.loaded .dropzone-text { color: #4ade80; }

                    /* Config details */
                    details {
                        background: #1e293b;
                        border: 1px solid #334155;
                        border-radius: 6px;
                        padding: 8px 12px;
                    }
                    summary {
                        font-weight: 600;
                        color: #94a3b8;
                        cursor: pointer;
                        font-size: 12px;
                        outline: none;
                    }
                    .config-grid {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 8px;
                        margin-top: 10px;
                    }
                    .field { display: flex; flex-direction: column; gap: 4px; }
                    .field label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 600; }
                    .field input, .field select {
                        background: #0f172a;
                        border: 1px solid #334155;
                        color: #f8fafc;
                        padding: 6px 8px;
                        border-radius: 4px;
                        font-size: 12px;
                    }
                    .field input:focus, .field select:focus {
                        border-color: #38bdf8;
                        outline: none;
                    }

                    /* Actions bar */
                    .actions-box {
                        background: #1e293b;
                        border: 1px solid #334155;
                        border-radius: 8px;
                        padding: 10px;
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                    }
                    .row { display: flex; gap: 8px; align-items: center; }
                    .btn {
                        background: #334155;
                        color: #f8fafc;
                        border: none;
                        padding: 8px 12px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 12px;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        transition: background 0.15s;
                    }
                    .btn:hover:not(:disabled) { background: #475569; }
                    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
                    .btn-primary { background: #0284c7; }
                    .btn-primary:hover:not(:disabled) { background: #0369a1; }
                    .btn-danger { background: #dc2626; }
                    .btn-danger:hover:not(:disabled) { background: #b91c1c; }
                    .btn-full { width: 100%; }

                    /* Progress Bar */
                    .progress-container {
                        background: #1e293b;
                        border-radius: 6px;
                        height: 8px;
                        overflow: hidden;
                        position: relative;
                    }
                    .progress-fill {
                        background: #38bdf8;
                        height: 100%;
                        width: 0%;
                        transition: width 0.2s ease-in-out;
                    }

                    /* Stats Badge Pill */
                    .stats-bar {
                        display: flex;
                        justify-content: space-between;
                        font-size: 11px;
                        color: #94a3b8;
                    }
                    .badge {
                        padding: 2px 6px;
                        border-radius: 4px;
                        font-weight: 600;
                    }
                    .badge-success { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
                    .badge-warn { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
                    .badge-error { background: rgba(239, 68, 68, 0.2); color: #f87171; }

                    /* Logs Console */
                    .log-box {
                        background: #090d16;
                        border: 1px solid #1e293b;
                        border-radius: 6px;
                        height: 160px;
                        overflow-y: auto;
                        padding: 8px;
                        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                        font-size: 11px;
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    .log-entry { display: flex; gap: 6px; line-height: 1.4; word-break: break-word; }
                    .log-time { color: #475569; flex-shrink: 0; }
                    .log-text { flex: 1; }
                    .log-info .log-text { color: #cbd5e1; }
                    .log-success .log-text { color: #4ade80; }
                    .log-warn .log-text { color: #fbbf24; }
                    .log-error .log-text { color: #f87171; font-weight: 600; }
                </style>

                <div class="panel">
                    <div class="header">
                        <div class="header-title">
                            <span>📅</span> Timetables Atendimentos
                        </div>
                        <div class="header-actions">
                            <button class="icon-btn" id="btn-minimize" title="Minimizar">_</button>
                            <button class="icon-btn" id="btn-close" title="Fechar">✕</button>
                        </div>
                    </div>

                    <div class="content">
                        <!-- Dropzone for click-data.json -->
                        <div class="dropzone" id="dropzone">
                            <div class="dropzone-text" id="dropzone-label">📁 Selecionar ou arrastar click-data.json</div>
                            <div class="dropzone-sub">Clique para escolher o arquivo gerado pelo build.sh</div>
                            <input type="file" id="file-input" accept=".json,application/json" style="display: none;">
                        </div>

                        <!-- Configs Accordion -->
                        <details id="config-details">
                            <summary>⚙️ Configurações e IDs do EduPage</summary>
                            <div class="config-grid">
                                <div class="field">
                                    <label>ttgpid (Projeto)</label>
                                    <input type="text" id="input-ttgpid" value="8588234">
                                </div>
                                <div class="field">
                                    <label>__gsh (Sessão)</label>
                                    <input type="text" id="input-gsh" placeholder="Detectando...">
                                </div>
                                <div class="field">
                                    <label>subjectId (Atendimento)</label>
                                    <input type="text" id="input-subjectId" value="*1">
                                </div>
                                <div class="field">
                                    <label>classIds (Turma)</label>
                                    <input type="text" id="input-classIds" value="*1">
                                </div>
                                <div class="field">
                                    <label>groupIds (Grupo)</label>
                                    <input type="text" id="input-groupIds" value="*217">
                                </div>
                                <div class="field">
                                    <label>weeksDefId</label>
                                    <input type="text" id="input-weeksDefId" value="*3">
                                </div>
                            </div>
                        </details>

                        <!-- Actions -->
                        <div class="actions-box">
                            <div class="row">
                                <button class="btn btn-full" id="btn-inspect">🔍 Inspecionar Metadados</button>
                            </div>

                            <div class="row">
                                <div class="field" style="width: 80px;">
                                    <select id="select-day">
                                        <option value="SEG">SEG</option>
                                        <option value="TER" selected>TER</option>
                                        <option value="QUA">QUA</option>
                                        <option value="QUI">QUI</option>
                                        <option value="SEX">SEX</option>
                                    </select>
                                </div>
                                <div class="field" style="width: 80px;">
                                    <select id="select-period">
                                        <option value="T3" selected>T3</option>
                                    </select>
                                </div>
                                <button class="btn" id="btn-test-slot" style="flex: 1;">🧪 Testar Slot</button>
                                <button class="btn" id="btn-allocate-pending" title="Alocar cartão existente na grade" style="flex: 1;">📌 Alocar</button>
                            </div>

                            <button class="btn btn-primary btn-full" id="btn-create-all">
                                🚀 Criar e Alocar Todas as Aulas
                            </button>
                        </div>

                        <!-- Progress Bar & Stats -->
                        <div class="stats-bar">
                            <span id="label-progress">Aguardando início</span>
                            <div>
                                <span class="badge badge-success" id="badge-success">0</span>
                                <span class="badge badge-warn" id="badge-warn">0</span>
                                <span class="badge badge-error" id="badge-error">0</span>
                            </div>
                        </div>
                        <div class="progress-container">
                            <div class="progress-fill" id="progress-fill"></div>
                        </div>

                        <!-- Live Streaming Log -->
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 11px; color: #64748b; font-weight: 600;">LOG DE EXECUÇÃO</span>
                            <div style="display: flex; gap: 4px;">
                                <button class="icon-btn" id="btn-copy-log" title="Copiar Logs" style="font-size: 11px; width: auto; padding: 2px 6px;">📋 Copiar</button>
                                <button class="icon-btn" id="btn-clear-log" title="Limpar Logs" style="font-size: 11px; width: auto; padding: 2px 6px;">🗑️</button>
                            </div>
                        </div>
                        <div class="log-box" id="log-box"></div>
                    </div>
                </div>
            `;
        }

        bindEvents() {
            const $ = (sel) => this.shadow.querySelector(sel);

            // Minimize / Close
            $('#btn-minimize').addEventListener('click', () => {
                this.isMinimized = !this.isMinimized;
                this.container.classList.toggle('minimized', this.isMinimized);
                $('#btn-minimize').textContent = this.isMinimized ? '□' : '_';
            });

            $('#btn-close').addEventListener('click', () => {
                document.getElementById(this.hostId)?.remove();
            });

            // Dropzone & File Input
            const dropzone = $('#dropzone');
            const fileInput = $('#file-input');

            dropzone.addEventListener('click', () => fileInput.click());
            dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.classList.remove('dragover');
                const file = e.dataTransfer.files && e.dataTransfer.files[0];
                if (file) this.handleLoadedFile(file);
            });

            fileInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) this.handleLoadedFile(file);
            });

            // Action Buttons
            $('#btn-inspect').addEventListener('click', async () => {
                try {
                    await fetchEduMetadata();
                } catch (err) {
                    this.addLog('error', `Erro na inspeção: ${err.message}`);
                }
            });

            $('#btn-test-slot').addEventListener('click', async () => {
                const day = $('#select-day').value;
                const period = $('#select-period').value;
                await this.runTestSlot(day, period);
            });

            $('#btn-allocate-pending').addEventListener('click', async () => {
                const day = $('#select-day').value;
                const period = $('#select-period').value;
                try {
                    await allocatePendingCard(day, period);
                } catch (err) {
                    this.addLog('error', `Erro ao alocar pendente: ${err.message}`);
                }
            });

            $('#btn-create-all').addEventListener('click', async () => {
                if (state.isRunning) {
                    state.abortRequested = true;
                    this.addLog('warn', 'Interrupção solicitada pelo usuário...');
                    return;
                }
                await this.runCreateAll();
            });

            $('#btn-copy-log').addEventListener('click', () => {
                const text = state.logs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.msg}`).join('\n');
                navigator.clipboard.writeText(text).then(() => {
                    this.addLog('info', 'Logs copiados para a área de transferência.');
                });
            });

            $('#btn-clear-log').addEventListener('click', () => {
                state.logs = [];
                $('#log-box').innerHTML = '';
            });
        }

        setupDraggable() {
            const header = this.shadow.querySelector('.header');
            const panel = this.container;
            let isDragging = false;
            let startX = 0;
            let startY = 0;

            header.addEventListener('mousedown', (e) => {
                if (e.target.closest('.header-actions')) return;
                isDragging = true;
                startX = e.clientX - panel.getBoundingClientRect().left;
                startY = e.clientY - panel.getBoundingClientRect().top;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const newLeft = e.clientX - startX;
                const newTop = e.clientY - startY;
                panel.style.position = 'fixed';
                panel.style.left = `${Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, newLeft))}px`;
                panel.style.top = `${Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, newTop))}px`;
                panel.style.right = 'auto';
            });

            document.addEventListener('mouseup', () => {
                isDragging = false;
            });
        }

        initSessionValues() {
            const ttgpid = getTtgpid();
            const gsh = detectGsh();
            this.shadow.querySelector('#input-ttgpid').value = ttgpid;
            const gshInput = this.shadow.querySelector('#input-gsh');
            if (gsh) {
                gshInput.value = gsh;
            } else {
                gshInput.placeholder = 'Insira o token (ex: ee1abf16)';
            }

            gshInput.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                if (val) {
                    sessionStorage.setItem('edupage_gsh', val);
                    window.__gsh = val;
                }
            });
        }

        handleLoadedFile(file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const parsed = JSON.parse(e.target.result);
                    if (!parsed.scheduleByDayAndPeriod || !parsed.periodTimes) {
                        throw new Error('Arquivo JSON inválido: chaves "periodTimes" e "scheduleByDayAndPeriod" são obrigatórias.');
                    }
                    state.clickData = parsed;
                    const periodCodes = Object.keys(parsed.periodTimes);
                    const totalSlots = Object.values(parsed.scheduleByDayAndPeriod).reduce((acc, periods) => {
                        return acc + Object.keys(periods).length;
                    }, 0);

                    // Update UI Dropzone
                    const dropzone = this.shadow.querySelector('#dropzone');
                    dropzone.classList.add('loaded');
                    this.shadow.querySelector('#dropzone-label').textContent = `✅ ${file.name}`;
                    dropzone.querySelector('.dropzone-sub').textContent = `${totalSlots} períodos configurados (${periodCodes.length} horários cadastrados)`;

                    // Update Periods dropdown
                    const periodSelect = this.shadow.querySelector('#select-period');
                    periodSelect.innerHTML = periodCodes.map(code => `<option value="${code}">${code}</option>`).join('');
                    if (periodCodes.includes('T3')) periodSelect.value = 'T3';

                    this.addLog('success', `${file.name} carregado com sucesso (${totalSlots} slots).`);
                } catch (err) {
                    this.addLog('error', `Falha ao ler arquivo: ${err.message}`);
                }
            };
            reader.readAsText(file);
        }

        updateConfigInput(key, value) {
            const el = this.shadow.querySelector(`#input-${key}`);
            if (el) el.value = value;
        }

        getConfig() {
            const $ = (sel) => this.shadow.querySelector(sel);
            return {
                subjectId: $('#input-subjectId').value.trim(),
                classIds: [$('#input-classIds').value.trim()],
                groupIds: [$('#input-groupIds').value.trim()],
                weeksDefId: $('#input-weeksDefId').value.trim()
            };
        }

        addLog(type, msg) {
            const time = new Date().toLocaleTimeString('pt-BR');
            state.logs.push({ type, msg, time });

            const logBox = this.shadow.querySelector('#log-box');
            if (!logBox) return;

            const div = document.createElement('div');
            div.className = `log-entry log-${type}`;
            div.innerHTML = `<span class="log-time">${time}</span><span class="log-text">${this.escapeHtml(msg)}</span>`;
            logBox.appendChild(div);
            logBox.scrollTop = logBox.scrollHeight;

            // Mirror to DevTools console
            const prefix = `[AtendimentosUI ${time}]`;
            if (type === 'error') console.error(prefix, msg);
            else if (type === 'warn') console.warn(prefix, msg);
            else console.log(prefix, msg);
        }

        updateProgress(current, total, label = '') {
            const pct = total > 0 ? Math.round((current / total) * 100) : 0;
            const fill = this.shadow.querySelector('#progress-fill');
            const progressLabel = this.shadow.querySelector('#label-progress');
            if (fill) fill.style.width = `${pct}%`;
            if (progressLabel) progressLabel.textContent = `${label} (${current}/${total} - ${pct}%)`;
        }

        updateStats() {
            const $ = (sel) => this.shadow.querySelector(sel);
            $('#badge-success').textContent = state.stats.success;
            $('#badge-warn').textContent = state.stats.warn;
            $('#badge-error').textContent = state.stats.error;
        }

        escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        async runTestSlot(day, period) {
            if (!state.clickData) {
                this.addLog('warn', 'Faça upload do click-data.json antes de testar.');
                return;
            }

            const professors = (state.clickData.scheduleByDayAndPeriod[day] && state.clickData.scheduleByDayAndPeriod[day][period])
                || state.clickData.professorsByPeriod[period]
                || ['Pablo', 'Rodrigo'];

            this.addLog('info', `Iniciando teste no slot ${day} ${period} (${professors.length} professores)...`);
            try {
                await createAndAssignSlot(day, period, professors);
            } catch (err) {
                this.addLog('error', `Erro ao testar ${day} ${period}: ${err.message}`);
                state.stats.error += 1;
                this.updateStats();
            }
        }

        async runCreateAll() {
            if (!state.clickData) {
                this.addLog('warn', 'Faça upload do click-data.json antes de executar.');
                return;
            }

            const dayOrder = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'];
            const periodOrder = Object.keys(state.clickData.periodTimes);

            const queue = [];
            for (const day of dayOrder) {
                const daySlots = state.clickData.scheduleByDayAndPeriod[day] || {};
                for (const period of periodOrder) {
                    const professors = daySlots[period];
                    if (Array.isArray(professors) && professors.length > 0) {
                        queue.push({ day, period, professors });
                    }
                }
            }

            if (queue.length === 0) {
                this.addLog('warn', 'Nenhum período com professores encontrado no click-data.json.');
                return;
            }

            state.isRunning = true;
            state.abortRequested = false;
            state.stats = { total: queue.length, success: 0, warn: 0, error: 0 };
            this.updateStats();

            const createAllBtn = this.shadow.querySelector('#btn-create-all');
            createAllBtn.textContent = '⏹ Interromper Execução';
            createAllBtn.classList.remove('btn-primary');
            createAllBtn.classList.add('btn-danger');

            this.addLog('info', `=== Iniciando criação de ${queue.length} aulas de atendimento ===`);

            for (let index = 0; index < queue.length; index += 1) {
                if (state.abortRequested) {
                    this.addLog('warn', 'Execução interrompida.');
                    break;
                }

                const item = queue[index];
                this.updateProgress(index + 1, queue.length, `${item.day} ${item.period}`);

                try {
                    await createAndAssignSlot(item.day, item.period, item.professors);
                } catch (err) {
                    this.addLog('error', `[${item.day} ${item.period}] Erro: ${err.message}`);
                    state.stats.error += 1;
                    this.updateStats();
                }

                // Short cooldown to prevent throttling
                await new Promise(res => setTimeout(res, 250));
            }

            state.isRunning = false;
            createAllBtn.textContent = '🚀 Criar e Alocar Todas as Aulas';
            createAllBtn.classList.add('btn-primary');
            createAllBtn.classList.remove('btn-danger');

            this.addLog('success', `=== Concluído! ${state.stats.success}/${queue.length} aulas alocadas com sucesso. ===`);
            this.addLog('info', 'Recarregue a página do EduPage para conferir a grade atualizada.');
        }
    }

    // ============================================================
    // MOUNT & EXPORT
    // ============================================================

    const ui = new TimetablesUI();
    ui.mount();

    // Global exports for console power-users
    window.EduPageUI = ui;
    window.inspect = fetchEduMetadata;
    window.testSlot = (day, period) => ui.runTestSlot(day, period);
    window.allocatePendingCard = allocatePendingCard;
    window.createAllSlots = () => ui.runCreateAll();

    console.log('%c[EduPage Atendimentos UI] Interface carregada com sucesso!', 'color: #38bdf8; font-weight: bold; font-size: 14px;');
    console.log('Você pode utilizar a interface flutuante ou os comandos no console:');
    console.log('  await inspect()');
    console.log('  await testSlot("TER", "T3")');
    console.log('  await allocatePendingCard("TER", "T3")');
    console.log('  await createAllSlots()');
})();

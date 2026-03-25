(async () => {
    function normalizeText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    function normalizeCompactText(value) {
        return normalizeText(value).replace(/\s+/g, '');
    }

    function extractCellText(cell) {
        const clone = cell.cloneNode(true);
        clone.querySelectorAll('style, script').forEach(node => node.remove());
        return String(clone.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function resolveProfessorFields(cellTexts) {
        const numericCellIndex = cellTexts.findIndex(value => /^\d+$/.test(value));
        if (numericCellIndex >= 3) {
            const candidateFields = cellTexts.slice(numericCellIndex - 3, numericCellIndex);
            if (candidateFields.every(Boolean)) {
                return {
                    lastName: candidateFields[0],
                    firstName: candidateFields[1],
                    short: candidateFields[2],
                };
            }
        }

        const nonEmptyTexts = cellTexts.filter(Boolean);
        if (nonEmptyTexts.length >= 3) {
            return {
                lastName: nonEmptyTexts[0],
                firstName: nonEmptyTexts[1],
                short: nonEmptyTexts[2],
            };
        }

        return null;
    }

    function buildProfessorFromRow(row) {
        const cellTexts = Array.from(row.querySelectorAll('td')).map(extractCellText);
        const fields = resolveProfessorFields(cellTexts);
        if (!fields) {
            return null;
        }

        const name = `${fields.firstName} ${fields.lastName}`.replace(/\s+/g, ' ').trim();
        if (!name || !fields.short) {
            return null;
        }

        return {
            name,
            short: fields.short,
            email: null,
        };
    }

    function getProfessorSignature(professor) {
        return `${normalizeCompactText(professor.short)}|${normalizeCompactText(professor.name)}`;
    }

    function isVisibleElement(element) {
        if (!element) {
            return false;
        }

        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function getTableHeaderText(table) {
        const container = table.closest('.dt-container');
        const headerSource = container ? container.querySelector('thead') : table.querySelector('thead');
        return normalizeText(headerSource ? headerSource.textContent : '');
    }

    function findProfessorTable() {
        const candidates = Array.from(new Set([
            ...document.querySelectorAll('.asc-dt'),
            ...document.querySelectorAll('table'),
        ]))
            .filter(table => isVisibleElement(table) && table.querySelectorAll('tbody tr.rec').length > 0)
            .map(table => {
                const rows = Array.from(table.querySelectorAll('tbody tr.rec'));
                const extractedRows = rows.filter(row => Boolean(buildProfessorFromRow(row))).length;
                const headerText = getTableHeaderText(table);
                let score = rows.length + extractedRows * 20;

                if (headerText.includes('abrevi')) {
                    score += 1000;
                }

                if (headerText.includes('ultimo nome')) {
                    score += 1000;
                }

                if (headerText.includes('primeiro nome')) {
                    score += 1000;
                }

                return { table, score };
            })
            .sort((candidateA, candidateB) => candidateB.score - candidateA.score);

        return candidates.length > 0 ? candidates[0].table : null;
    }

    function findScrollableParent(element) {
        let currentElement = element.parentElement;

        while (currentElement) {
            const style = window.getComputedStyle(currentElement);
            const isScrollable = /(auto|scroll|overlay)/.test(style.overflowY || '');
            if (isScrollable && currentElement.scrollHeight > currentElement.clientHeight + 1) {
                return currentElement;
            }
            currentElement = currentElement.parentElement;
        }

        return null;
    }

    function sleep(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    async function collectProfessorRows(table) {
        const scrollContainer = findScrollableParent(table);
        const rowsBySignature = new Map();
        const collectVisibleRows = () => {
            Array.from(table.querySelectorAll('tbody tr.rec')).forEach(row => {
                const professor = buildProfessorFromRow(row);
                if (!professor) {
                    return;
                }

                rowsBySignature.set(getProfessorSignature(professor), professor);
            });
        };

        collectVisibleRows();

        if (!scrollContainer) {
            return Array.from(rowsBySignature.values());
        }

        const initialScrollTop = scrollContainer.scrollTop;
        const step = Math.max(120, Math.floor(scrollContainer.clientHeight * 0.75));
        let previousCount = rowsBySignature.size;
        let stablePasses = 0;

        scrollContainer.scrollTop = 0;
        await sleep(150);
        collectVisibleRows();

        for (let iteration = 0; iteration < 250; iteration += 1) {
            const isAtBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 2;
            const currentCount = rowsBySignature.size;

            if (isAtBottom && currentCount === previousCount) {
                stablePasses += 1;
            } else {
                stablePasses = 0;
            }

            if (stablePasses >= 2) {
                break;
            }

            previousCount = currentCount;
            if (!isAtBottom) {
                scrollContainer.scrollTop = Math.min(scrollContainer.scrollTop + step, scrollContainer.scrollHeight);
                await sleep(150);
                collectVisibleRows();
            } else {
                await sleep(150);
                collectVisibleRows();
            }
        }

        scrollContainer.scrollTop = initialScrollTop;
        await sleep(60);

        return Array.from(rowsBySignature.values());
    }

    function normalizeProfessorRecord(record) {
        return {
            name: String(record && record.name ? record.name : record && record.short ? record.short : '').trim(),
            short: String(record && record.short ? record.short : '').trim(),
            email: record && record.email ? String(record.email).trim().toLowerCase() : null,
        };
    }

    function parseProfessorFileContent(text) {
        const parsed = JSON.parse(text);

        if (Array.isArray(parsed)) {
            return parsed.map(normalizeProfessorRecord).filter(record => record.short);
        }

        if (parsed && typeof parsed === 'object') {
            return Object.entries(parsed).map(([email, short]) => normalizeProfessorRecord({
                name: short,
                short,
                email,
            })).filter(record => record.short);
        }

        throw new Error('Unsupported professors.json format.');
    }

    async function loadExistingProfessors() {
        if (typeof window.showOpenFilePicker === 'function') {
            const [handle] = await window.showOpenFilePicker({
                multiple: false,
                types: [{
                    description: 'JSON data',
                    accept: { 'application/json': ['.json'] },
                }],
            });
            const file = await handle.getFile();
            return {
                handle,
                records: parseProfessorFileContent(await file.text()),
            };
        }

        const rawValue = window.prompt('Paste the current professors.json content. Leave empty to start from an empty list.', '[]');
        return {
            handle: null,
            records: rawValue ? parseProfessorFileContent(rawValue) : [],
        };
    }

    function buildLookupMap(records, keyResolver) {
        const lookup = new Map();

        records.forEach(record => {
            const key = keyResolver(record);
            if (!key) {
                return;
            }

            if (!lookup.has(key)) {
                lookup.set(key, []);
            }

            lookup.get(key).push(record);
        });

        return lookup;
    }

    function findUniqueRecord(lookup, key) {
        const matches = lookup.get(key) || [];
        return matches.length === 1 ? matches[0] : null;
    }

    function mergeProfessors(extractedProfessors, existingProfessors) {
        const existingByShort = buildLookupMap(existingProfessors, professor => normalizeCompactText(professor.short));
        const existingByName = buildLookupMap(existingProfessors, professor => normalizeCompactText(professor.name));

        return extractedProfessors.map(professor => {
            const matchingProfessor = findUniqueRecord(existingByShort, normalizeCompactText(professor.short))
                || findUniqueRecord(existingByName, normalizeCompactText(professor.name));

            return {
                name: professor.name,
                short: professor.short,
                email: matchingProfessor && matchingProfessor.email ? matchingProfessor.email : null,
            };
        });
    }

    async function saveUpdatedProfessors(handle, content) {
        if (handle && typeof handle.createWritable === 'function') {
            const writable = await handle.createWritable();
            await writable.write(content);
            await writable.close();
            return 'file';
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
                await navigator.clipboard.writeText(content);
            } catch (error) {
                console.warn('Could not copy JSON to clipboard:', error);
            }
        }

        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'professors.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        return 'download';
    }

    const table = findProfessorTable();
    if (!table) {
        throw new Error('No professor table was found on the current page.');
    }

    const extractedProfessors = await collectProfessorRows(table);
    if (extractedProfessors.length === 0) {
        throw new Error('No professor rows were extracted from the table.');
    }

    const { handle, records: existingProfessors } = await loadExistingProfessors();
    const updatedProfessors = mergeProfessors(extractedProfessors, existingProfessors);
    const content = `${JSON.stringify(updatedProfessors, null, 4)}\n`;
    const saveMode = await saveUpdatedProfessors(handle, content);

    const existingSignatures = new Set(existingProfessors.map(getProfessorSignature));
    const updatedSignatures = new Set(updatedProfessors.map(getProfessorSignature));
    const addedCount = updatedProfessors.filter(professor => !existingSignatures.has(getProfessorSignature(professor))).length;
    const removedCount = existingProfessors.filter(professor => !updatedSignatures.has(getProfessorSignature(professor))).length;
    const matchedEmailCount = updatedProfessors.filter(professor => professor.email).length;

    console.log(`Professor file updated via ${saveMode}. Rows found: ${updatedProfessors.length}. Added: ${addedCount}. Removed: ${removedCount}. With email preserved: ${matchedEmailCount}.`);
    console.log(updatedProfessors);

    return updatedProfessors;
})();
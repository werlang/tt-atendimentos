# EduPage Timetables Internal API Documentation

Comprehensive technical documentation for the internal aSc Applied Software Consultants / EduPage Timetables JSON-RPC API, based on reverse-engineered network contracts in `trocaaula` and `tt-atendimentos`.

---

## 1. Overview & Architecture

EduPage Timetables exposes a proprietary JSON-RPC-over-HTTP API. Instead of standard REST verbs, all read and write operations are routed as `POST` requests to specific server script endpoints with function dispatch query parameters (e.g. `?__func=ttuidocDBIAccessor`).

### Key Characteristics

* **Base URL**: `https://<school-subdomain>.edupage.org` (e.g., `https://ifsulcharq.edupage.org`).
* **Transport**: HTTP `POST` with `Content-Type: application/json; charset=UTF-8`.
* **State Management**: Dual-layer authentication requiring session cookies (`PHPSESSID`, `ASC`) combined with a per-session security token (`__gsh`).
* **Relational Table Architecture**: Timetable data is stored and exchanged as relational tables (`data_rows`), mirroring database tables (`teachers`, `classes`, `subjects`, `lessons`, `cards`, `periods`, `daysdefs`, etc.).

---

## 2. Authentication & Session Security

The API enforces session authentication through cookies and a security verification hash.

### 2.1 Essential Session Tokens

| Token | Type | Description |
| :--- | :--- | :--- |
| `PHPSESSID` | Cookie | Primary PHP session cookie. Mandatory for all requests. |
| `ASC` | Cookie | Auxiliary state cookie issued by aSc Timetables. |
| `__gsh` | Body Field | "Global Security Hash" (CSRF / request signing token). Hex string (e.g., `ee1abf16` or `00000000` fallback). |

### 2.2 Obtaining `__gsh`

When executing from within the browser (DevTools / user script):
1. **Window Objects**: Inspect `window.ASC?.gsechash`, `window.EduPage?.gsh`, or `window.g_data?.gsh`.
2. **Inline Script Parsing**: Scrape the active DOM for script tags containing `/(?:__)?gsh["']?\s*[:=]\s*["']([a-f0-9]{6,32})["']/i`.

When running in automated backend environments (e.g., `EdupageAuth` in `trocaaula`):
* The login flow at `/login/?cmd=MainLogin&cl=1` performs client-side password encryption before form submission.
* Use a headless browser (Puppeteer / Playwright) to execute the two-step login (username submit, then password submit) and capture authenticated cookies (`PHPSESSID`) and `window.ASC.gsechash`.

---

## 3. Wire Protocol Specification

Every request sent to the API follows a standard envelope structure.

### 3.1 Request Envelope

```json
{
  "__args": [
    null,
    "<targetIdOrContext>",
    {
      "op": "fetch | add | update | delete",
      ...operationPayload
    }
  ],
  "__gsh": "ee1abf16"
}
```

* `__args[0]`: Always `null` (reserved for internal request metadata).
* `__args[1]`: Context identifier:
  * For document operations (`ttdoc.js`): Database project/document ID (`ttgpid` or `documentId`, e.g. `8588234` or `114446217`).
  * For school database operations (`maindbi.js`): Academic year integer (e.g., `2026`).
* `__args[2]`: Operation descriptor object specifying the operation (`op`) and table filters/mutations.
* `__gsh`: Active session security hash.

### 3.2 Response Envelope

#### Success Response
```json
{
  "r": {
    "tables": [
      {
        "id": "teachers",
        "data_rows": [ ... ]
      },
      {
        "id": "cards",
        "data_rows": [ ... ]
      }
    ],
    "dbiAccessorRes": {
      "ttid": 114446217
    }
  }
}
```

#### Error Response
```json
{
  "en": 5096273150,
  "em": "Document was closed",
  "e": "document was closed"
}
```

---

## 4. Endpoints Reference

EduPage Timetables provides three primary RPC accessors:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            EduPage Timetables RPC                            │
├────────────────────────┬─────────────────────────────┬───────────────────────┤
│ Endpoint               │ Function Parameter          │ Primary Purpose       │
├────────────────────────┼─────────────────────────────┼───────────────────────┤
│ /timetable/app/server/ │ ?__func=ttuidocDBIAccessor │ Full Timetable Doc &  │
│ ttdoc.js               │                             │ CRUD Mutations        │
├────────────────────────┼─────────────────────────────┼───────────────────────┤
│ /rpr/server/           │ ?__func=mainDBIAccessor     │ Active Document ID &  │
│ maindbi.js             │                             │ Snapshot Metadata     │
├────────────────────────┼─────────────────────────────┼───────────────────────┤
│ /timetable/server/     │ ?__func=curentttGetData     │ Live View with Daily  │
│ currenttt.js           │                             │ Substitutions         │
└────────────────────────┴─────────────────────────────┴───────────────────────┘
```

---

### 4.1 Endpoint: `ttdoc.js` (`ttuidocDBIAccessor`)

The core accessor for reading complete timetables and executing mutations (adding lessons, moving/allocating cards).

* **URL**: `/timetable/app/server/ttdoc.js?__func=ttuidocDBIAccessor`
* **Method**: `POST`

#### A. Fetching Timetable Tables (`op: "fetch"`)

```json
{
  "__args": [
    null,
    8588234,
    {
      "op": "fetch",
      "needed_part": {
        "globals": ["tt_datefrom", "tt_year", "year", "tt_name", "tt_version"],
        "cards": ["id", "lessonid", "period", "days", "weeks", "locked", "classroomids"],
        "lessons": ["id", "subjectid", "classids", "teacherids", "durationperiods", "groupnames", "groupids", "daysdefid", "weeksdefid", "termsdefid"],
        "periods": ["id", "short", "name", "period", "starttime", "endtime"],
        "teachers": ["id", "short", "name", "edupageid", "firstname", "lastname", "email", "classroomids", "color"],
        "classes": ["id", "short", "name", "edupageid", "classroomids"],
        "classrooms": ["id", "short", "name", "edupageid"],
        "subjects": ["id", "short", "name", "edupageid", "metaclassroomids"],
        "groups": ["id", "classid", "name", "entireclass"],
        "daysdefs": ["id", "short", "name", "vals", "typ"],
        "weeksdefs": ["id", "short", "name", "vals", "typ"],
        "termsdefs": ["id", "short", "name", "vals", "typ"]
      },
      "needed_combos": {}
    }
  ],
  "__gsh": "ee1abf16"
}
```

#### B. Adding Lessons (`op: "add"`)

Creates a new lesson in the timetable database:

```json
{
  "__args": [
    null,
    8588234,
    {
      "op": "add",
      "data": {
        "table": "lessons",
        "rows": [
          {
            "subjectid": "*1",
            "teacherids": ["*12", "*34"],
            "metaclassroomidss": [["*teacher"]],
            "classids": ["*1"],
            "groupids": ["*217"],
            "seminargroup": null,
            "count": 1,
            "durationperiods": 1,
            "daysdefid": "*6",
            "weeksdefid": "*3",
            "termsdefid": "*5",
            "bell": "",
            "minstudents": null,
            "maxstudents": null,
            "distrib": "",
            "minutes": null,
            "_uial": null
          }
        ]
      }
    }
  ],
  "__gsh": "ee1abf16"
}
```

*Response*: Returns the created lesson in `r.tables` (e.g. `[ { "id": "lessons", "data_rows": [ { "id": "*142", ... } ] } ]`).

#### C. Updating Cards (`op: "update"`)

Allocates an unassigned card to a period, day, and room:

```json
{
  "__args": [
    null,
    8588234,
    {
      "op": "update",
      "data": {
        "table": "cards",
        "rows": [
          {
            "id": "*card123",
            "period": "3",
            "days": "01000",
            "weeks": "1",
            "locked": false,
            "classroomids": []
          }
        ]
      }
    }
  ],
  "__gsh": "ee1abf16"
}
```

---

### 4.2 Endpoint: `maindbi.js` (`mainDBIAccessor`)

Queries the school-wide master database to discover which timetable document is currently active and inspect snapshot revisions.

* **URL**: `/rpr/server/maindbi.js?__func=mainDBIAccessor`
* **Method**: `POST`

#### Active Document ID Discovery (`ttid`)

```json
{
  "__args": [
    null,
    2026,
    {
      "vt_filter": {
        "datefrom": "2026-03-16",
        "dateto": "2026-03-20"
      }
    },
    {
      "op": "fetch",
      "needed_part": {
        "teachers": ["short", "name", "firstname", "lastname", "email"]
      },
      "needed_combos": {}
    }
  ],
  "__gsh": "ee1abf16"
}
```

*Response*: Look for `response.r.dbiAccessorRes.ttid` to obtain the numeric document ID (e.g., `114446217`).

#### Snapshot Version & Metadata Inspection

```json
{
  "__args": [
    null,
    2026,
    {
      "vt_filter": {
        "date": "2026-03-16"
      }
    },
    {
      "op": "fetch",
      "needed_part": {
        "timetables": ["name", "year", "datefrom", "dateto", "tt_num", "filetime_int"],
        "tt_snapshots": ["tt_num", "backup", "ss_version", "num_current", "time_int"],
        "dates": ["tt_num"]
      },
      "needed_combos": {
        "timetables": ["stav", "importtype"]
      },
      "suspense": true
    }
  ],
  "__gsh": "ee1abf16"
}
```

---

### 4.3 Endpoint: `currenttt.js` (`curentttGetData`)

Fetches the live schedule for a specific class, teacher, or classroom for a given week interval. Unlike `ttdoc`, this endpoint reflects daily substitutions, cancellations, and temporary teacher replacements.

* **URL**: `/timetable/server/currenttt.js?__func=curentttGetData`
* **Method**: `POST`

```json
{
  "__args": [
    null,
    {
      "year": 2026,
      "datefrom": "2026-03-16",
      "dateto": "2026-03-20",
      "table": "classes",
      "id": "1",
      "showColors": true,
      "showIgroupsInClasses": false,
      "showOrig": true,
      "log_module": "CurrentTTView"
    }
  ],
  "__gsh": "ee1abf16"
}
```

*Target Tables for `table`*: `"classes"`, `"teachers"`, `"classrooms"`.
*Response*: Array of schedule cards in `response.r.ttitems`.

---

## 5. Relational Schema & Data Dictionary

### 5.1 Tables Overview

```
 ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
 │   teachers   │         │   classes    │         │  classrooms  │
 └──────┬───────┘         └──────┬───────┘         └──────┬───────┘
        │                        │                        │
        │ teacherids             │ classids               │ classroomids
        ▼                        ▼                        ▼
 ┌────────────────────────────────────────────────────────────────┐
 │                            lessons                             │
 └───────────────────────────────┬────────────────────────────────┘
                                 │ lessonid
                                 ▼
 ┌────────────────────────────────────────────────────────────────┐
 │                             cards                              │
 │  (period, days bitmask, weeks bitmask, locked, classroomids)   │
 └────────────────────────────────────────────────────────────────┘
```

### 5.2 Key Fields by Table

#### `teachers`
* `id`: Internal ID (integer or string with prefix `*`, e.g. `1` or `*12`).
* `edupageid`: External string identifier used across school systems (e.g. `"-212"`).
* `short`: Short abbreviation (e.g., `"Pablo"`).
* `name`: Full display name (e.g., `"Pablo Santos Werlang"`).
* `firstname`, `lastname`: Split name fields.
* `email`: Institutional email address (may be blank in local timetables).

#### `cards`
* `id`: Unique card identifier (e.g. `"card-1"` or `"*card142"`).
* `lessonid`: Foreign key referencing `lessons.id`.
* `period`: Numeric string indicating the scheduled period (e.g., `"1"`, `"2"`, `"3"`). When unallocated, this is empty or `"0"`.
* `days`: Day bitmask string (see section 6).
* `weeks`: Week bitmask string (typically `"1"` or `"10000"`).
* `classroomids`: Array of classroom IDs allocated to this specific card.
* `locked`: Boolean (`0` or `1`) indicating whether the card position is locked against auto-scheduling.

#### `lessons`
* `id`: Unique lesson identifier.
* `subjectid`: Foreign key referencing `subjects.id`.
* `teacherids`: Array of foreign keys referencing `teachers.id`.
* `classids`: Array of foreign keys referencing `classes.id`.
* `durationperiods`: Integer representing duration in periods (e.g., `1` or `2`).
* `groupnames`: Array of group names if split (e.g., `["G1"]` or `["Toda a turma"]`).

#### `periods`
* `id`: Unique period identifier.
* `period`: Sequence index (e.g. `1`, `2`, `3`).
* `starttime`: Start time string (e.g., `"07:30"`).
* `endtime`: End time string (e.g., `"08:15"`).

#### `daysdefs`
* `id`: Unique day definition ID (e.g. `"*6"`).
* `short`: Day abbreviation (e.g., `"SEG"`).
* `name`: Display name (e.g., `"Segunda-feira"`).
* `vals`: Array containing the matching 5-character bitmask (e.g., `["10000"]`).

---

## 6. Schedule Logic & Bitmask System

EduPage represents multi-day and multi-week availability using binary bitmasks:

### 6.1 Days Bitmask

A 5-character string corresponding to Monday through Friday:

| Day | Code | Bitmask |
| :--- | :--- | :--- |
| Segunda-feira (Monday) | `SEG` | `10000` |
| Terça-feira (Tuesday) | `TER` | `01000` |
| Quarta-feira (Wednesday) | `QUA` | `00100` |
| Quinta-feira (Thursday) | `QUI` | `00010` |
| Sexta-feira (Friday) | `SEX` | `00001` |

*Combinations*: A card valid for both Tuesday and Thursday uses `01010`.

### 6.2 Date Calculation from Base Date

When reading raw cards from `ttdoc.js`, the exact calendar date is computed from the timetable's base start date (`globals[0].tt_datefrom`):

```javascript
function buildCardDate(baseDateString, card) {
    const baseDate = new Date(baseDateString);
    const dayIndex = card.days.indexOf('1'); // 0 = Mon, 1 = Tue, 2 = Wed...
    const weekIndex = card.weeks.indexOf('1'); // 0 = Week 1

    const date = new Date(baseDate.getTime() + ((weekIndex * 7) + dayIndex) * 86400000);
    return date.toISOString().split('T')[0];
}
```

---

## 7. Error Handling & Edge Cases

| Error Code | Error Message | Cause & Recommended Recovery |
| :--- | :--- | :--- |
| `5096273150` | `Document was closed` | The requested `documentId` / `ttgpid` is obsolete or has been republished. Query `maindbi.js` to discover the fresh `ttid`. |
| `2500673596` | `Reload` / `Session error` | The `PHPSESSID` or `__gsh` token has expired. Trigger re-authentication to acquire a new session. |
| `HTTP 401/403` | Unauthorized | Missing session cookies or invalid origin. Include valid cookie headers. |

---

## 8. Integration Example: Node.js

```javascript
/**
 * Query the active EduPage Timetables document directly.
 */
async function fetchTimetableData({ schoolUrl, documentId, cookieHeader, gsh }) {
    const endpoint = `${schoolUrl}/timetable/app/server/ttdoc.js?__func=ttuidocDBIAccessor`;

    const payload = {
        __args: [
            null,
            documentId,
            {
                op: 'fetch',
                needed_part: {
                    globals: ['tt_datefrom', 'tt_name', 'tt_version'],
                    teachers: ['short', 'name', 'edupageid', 'email'],
                    classes: ['short', 'name'],
                    periods: ['starttime', 'endtime'],
                    lessons: ['subjectid', 'teacherids', 'classids'],
                    cards: ['lessonid', 'period', 'days', 'weeks']
                },
                needed_combos: {}
            }
        ],
        __gsh: gsh || '00000000'
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cookie': cookieHeader
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    return json.r?.tables || [];
}
```

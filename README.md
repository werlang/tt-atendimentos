# tt-atendimentos

Helper project to automate professor schedule generation, lesson creation, and card placement in aSc Timetables (EduPage).

## Files

- `build.sh`: automatically syncs professors from TrocaAula and generates `click-data.json` inside Docker.
- `sync-professors.sh`: standalone script to update `professors.json` from TrocaAula without rebuilding.
- `sync-professors.js`: Node script that queries TrocaAula API and correlates names/emails.
- `build-professor-schedule.js`: Node script that builds schedule click data from `form.csv` and `professors.json`.
- `form.csv`: latest Google Forms responses export.
- `professors.json`: professor list used to map form responses to Timetables abbreviations.
- `create-lessons.browser.js`: browser helper that creates lessons and assigns them to time slots directly via EduPage API.
- `docs/edupage-timetables-api.md`: complete technical documentation for the EduPage Timetables JSON-RPC API.

## Workflow

### 1. Update `form.csv`

1. Export the latest responses from Google Forms as CSV.
2. Replace the local `form.csv` with that file.

### 2. Build click data

Run:

```sh
./build.sh
```

By default, `./build.sh` automatically connects to TrocaAula (`https://trocaaula.sistemas.charqueadas.ifsul.edu.br/`), refreshes `professors.json`, matches professor emails with `form.csv`, and generates `click-data.json`.

#### Options:

- Pass `--no-sync` to skip the network call and build using local `professors.json`:
  ```sh
  ./build.sh --no-sync
  ```
- Pass a custom TrocaAula URL if needed:
  ```sh
  ./build.sh https://trocaaula.sistemas.charqueadas.ifsul.edu.br/
  ```

### Optional: Standalone Professor Sync

If you only want to refresh `professors.json` without regenerating `click-data.json`, run:

```sh
./sync-professors.sh
```

## Use in Timetables (EduPage)

1. Open your Timetables project in EduPage (`https://ifsulcharq.edupage.org/timetable/online.php?ttgpid=...`).
2. Open DevTools Console (`F12` or `Cmd+Option+I`).
3. Paste [`create-lessons.browser.js`](file:///Users/pablowerlang/Documents/Workspaces/ifsul/tt-atendimentos/create-lessons.browser.js) into the console.
4. A **floating control panel** will automatically appear over the timetable:
   - **Upload `click-data.json`**: Drag and drop the file directly onto the panel (or click to select).
   - **Configuration**: Displays and lets you customize `subjectId`, `classIds`, `groupIds`, and detected session parameters.
   - **🔍 Inspecionar Metadados**: Queries EduPage and logs all teachers, periods, and day definitions.
   - **🧪 Testar Slot**: Select a day and period to test creating and placing 1 slot.
   - **📌 Alocar**: Places an unallocated card directly onto the selected slot.
   - **🚀 Criar e Alocar Todas as Aulas**: Runs bulk creation across all slots.
   - **Live Progress & Streaming Logs**: Real-time progress bar, live success/warning/error counters, auto-scrolling log console, and copy logs button.

You can also use the console commands directly if preferred:
```js
await inspect()
await testSlot("TER", "T3")
await allocatePendingCard("TER", "T3")
await createAllSlots()
```

## Quick Summary

1. Replace `form.csv` with the latest Google Forms export.
2. Run `./build.sh`.
3. Paste [`create-lessons.browser.js`](file:///Users/pablowerlang/Documents/Workspaces/ifsul/tt-atendimentos/create-lessons.browser.js) in the EduPage console.
4. Drop `click-data.json` into the floating UI and click **Criar e Alocar Todas as Aulas**.

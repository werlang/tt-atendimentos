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
- `click-timetables.browser.js`: browser helper that automatically selects professors in the Timetables UI.

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

## Use in Timetables

### Option A: Fully Automated via API (Recommended)

1. Open your Timetables project in EduPage (`https://ifsulcharq.edupage.org/timetable/online.php?ttgpid=...`).
2. Open DevTools Console (`F12`).
3. Paste [`create-lessons.browser.js`](file:///Users/pablowerlang/Documents/Workspaces/ifsul/tt-atendimentos/create-lessons.browser.js) into the console.
4. (Optional) Run `await inspect()` to inspect the loaded EduPage teachers, daysdefs, and periods.
5. (Optional) Run `await testSlot("TER", "T3")` to test creating and placing a single slot.
6. (Optional) Run `await allocatePendingCard("TER", "T3")` to place an already created card onto its time slot.
7. Run:
   ```js
   await createAllSlots()
   ```
   Select `click-data.json` when prompted. The script will create all lessons and place their cards directly onto the schedule grid.

---

### Option B: UI Auto-Clicker Helper (Fallback)

If you already have created the lessons manually and only want to auto-select professors in the modal:

1. Open Timetables in the browser.
2. Paste [`click-timetables.browser.js`](file:///Users/pablowerlang/Documents/Workspaces/ifsul/tt-atendimentos/click-timetables.browser.js) into the console.
3. Choose the generated `click-data.json` when prompted.
4. Open the `Mais professores` dialog for the current slot, then run:
   ```js
   run()
   ```
5. Run `run()` again for each subsequent slot.

Useful commands:
```js
run()
run("T3", "TER")
resetRun()
```

## Quick Summary

1. Replace `form.csv` with the latest Google Forms export.
2. Run `./build.sh`.
3. Paste [`create-lessons.browser.js`](file:///Users/pablowerlang/Documents/Workspaces/ifsul/tt-atendimentos/create-lessons.browser.js) in the EduPage console.
4. Run `await createAllSlots()` to populate the timetable grid automatically.

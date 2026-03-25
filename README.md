# tt-atendimentos

Small helper project to automate professor selection in Timetables.

## Files

- `sync-professors.browser.js`: updates `professors.json` from the live professor table in the browser.
- `form.csv`: latest Google Forms responses.
- `professors.json`: professor list used to map form responses to Timetables names.
- `build.sh`: generates `click-data.json`.
- `click-timetables.browser.js`: browser helper that clicks professors automatically.

## Workflow

### 1. Sync professors

Use this when the professor list in Timetables changes.

1. Open the professor table in Timetables.
2. Paste `sync-professors.browser.js` into the browser console.
3. Choose the current `professors.json` when prompted.
4. Save the updated file if the browser asks, or use the downloaded replacement.

Result: `professors.json` is refreshed with current names and short labels.

### 2. Update `form.csv`

1. Export the latest responses from Google Forms as CSV.
2. Replace the local `form.csv` with that file.

Result: the build will use the latest availability answers.

### 3. Build click data

Run:

```sh
./build.sh
```

Result: `click-data.json` is regenerated.

## Use in Timetables

### 4. Load the click helper

1. Open Timetables in the browser.
2. Paste `click-timetables.browser.js` into the console.
3. Choose the generated `click-data.json`.

The helper will finish with: `Ready. Run run() or run("T3", "TER").`

### 5. Click professors automatically

Open the `Mais professores` dialog for the current slot, then run:

```js
run()
```

Run `run()` again for the next slot.
Run `run()` again for the next one.

Useful commands:

```js
run()
run("T3", "TER")
resetRun()
```

- `run()`: processes the next scheduled period.
- `run("T3", "TER")`: runs a specific period/day.
- `resetRun()`: restarts the queue from the beginning.

## Quick Summary

1. Sync professors with `sync-professors.browser.js`.
2. Replace `form.csv` with the latest Google Forms export.
3. Run `./build.sh`.
4. Paste `click-timetables.browser.js` in the browser.
5. Open `Mais professores` and call `run()` for each period.
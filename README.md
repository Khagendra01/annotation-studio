# social-media-data-LA-wildfires

## Annotation Studio setup (new machine)

The runtime data (`data_annotated/`, ~25 MB) is **gitignored** — cloning alone is not enough. Follow these steps:

1. **Clone**
   ```
   git clone https://github.com/deeplearning-lab-csueb/social-media-data-LA-wildfires.git
   ```

2. **Build the runtime data** (Python 3 stdlib only — no pip installs, no node; about 3 seconds):
   ```
   python3 build_annotator_data.py
   ```
   Run this from the repository root. Source and output paths are resolved relative to the script itself. The builder reads the tracked cleaned bundle `Linn-Reddit/cleaned/CALIFORNIA_WILDFIRE_451_FAST_CONTEXT.zip` (7.6 MB, SHA-256 verified against its manifest) and verifies all 451 targets and their text on every build — the old 77 MB → 464 MB archive extraction is no longer needed for the annotator.
   → creates `data_annotated/linn_451/index.js` + `c01.js…c240.js` (240 thread chunks, ~23 MB). Rows are stored once per thread (94,489 rows) and cloned per task when a project opens, replacing the previous on-disk expansion (1,092,419 rows, 447 MB, parsed from the 487 MB HTML archive). Verify with `ls data_annotated/linn_451/ | wc -l` (should be 241). Append `--csv` only if you need the old flat per-task CSV (214 MB) for external tools — the app does not read it.

3. **Open `annotator.html` in a browser** — double-click / `file://` works, no HTTP server needed. Name your project and choose **Start full annotation** or **Relabel 500 targets** (the guided Point flow). Keep the `annotator/` directory alongside the HTML file.

### Optional: Supabase sign-in and label sync

Without configuration the annotator runs exactly as before (local only, no login). To require sign-in and mirror labels to Supabase:

1. **Create a Supabase project** → Project Settings → API, copy the *Project URL* and *anon public* key.
2. **Fill in `.env`** (`cp .env.example .env`, then paste the two values) and generate the client config:
   ```
   python3 gen_config.py
   ```
   → writes `annotator/config.js` (gitignored, like `.env`). Placeholder values keep local mode.
3. **Create the tables and row-level security** — run `supabase/migrations/20261016120000_annotator_auth.sql` in the SQL editor (or `supabase db push` with the CLI).
4. **Add annotators**: Dashboard → Authentication → Users → *Add user* (set user metadata `{"access_code": "SMCADL"}` so the account-creation trigger accepts it), or let people self-register — the sign-in gate's **Create account** flow asks for the shared access code **SMCADL** and `SUPABASE_ALLOW_SIGNUP=true` must be on. The code is checked in the browser for instant feedback and again on `auth.users` by a trigger, so it is not enough to read it out of the page source.
5. **Reload `annotator.html`** — the gate blocks the workspace until the account signs in. Labels then sync continuously: projects, per-node annotations, and reading position, all scoped to the signed-in user by RLS. The status bar shows `cloud: synced hh:mm:ss`; click it to force a sync.

Notes:

- `localStorage` remains the source of truth the UI reads, so a failed or offline sync never blocks annotation — the status bar shows `cloud: sync error` and retries on the next change.
- Signing in first pulls everything for the account, then pushes local-only work. On a conflict the local edit wins; on a fresh browser the server copy is pulled in.
- **Imported CSV rows stay local** (`annotator.data.v1.*` is not synced), so an imported project only opens on the browser it was imported into. Skeleton projects sync everywhere.
- Reading position resolves to the furthest progress across devices.
- `file://` works (Supabase sends permissive CORS), but a local server avoids browser quirks: `python3 -m http.server`.

### Notes

- **Shortcut**: instead of step 2, copy the `data_annotated/` folder (~25 MB) from any machine that already has it. Older 447 MB builds also keep working — the loader falls back to the legacy layout automatically.
- Skipping step 2 → clicking Create gives "Could not load skeleton data" error.
- `Linn-Reddit/CALIFORNIA_WILDFIRE_451_ANNOTATION_COMPARISON.zip` stays as the provenance source archive (the cleaned bundle was derived from it). An extracted `Linn-Reddit/tasks/` (~465 MB) is no longer read by anything and can be deleted.
- `python3 make_relabel_template.py` only regenerates the already-committed `500-Reddit-with-annotations/relabel_500_template.csv` — skip it.
- The `iscram_2026_Reddit_Bluesky__Copy_.zip` and `reddit-viewer/` are **not** needed for the annotator.
- Keep `annotator.html` inside the repo root (relative data paths); projects/labels live in the browser's `localStorage`.

## Annotation workspace

The workspace includes a searchable queue of unique threads, a reading pane, the HumAID label guide, row review, and exports. Previous browser projects and labels use the same storage keys and continue to open.

There are exactly two project filters, available at creation and through **Filters**:

- **Reply depth:** per thread — 1 includes direct replies to the post; 2 also includes replies to those comments. Leave blank for unlimited.
- **Comment budget:** one strict pool for the whole project, shared across unique threads, after applying depth. Posts do not consume the budget. Threads use source order; comments use breadth-first order, sorted by timestamp and then ID. The last included thread can be partial. Repeated source tasks for the same thread share one budget allocation.

Projects created with **Relabel 500 targets** exempt every target and its reply chain from both limits: the chains stay in scope regardless of depth and never spend comment budget, so the budget only trims surrounding context and the full 500-target pass stays reachable. Full-pass projects apply both limits to everything, and depth can exclude some target rows there. Existing labels are retained when filters change. The removed per-thread comment cap is ignored in saved projects. Search only narrows the visible queue; it does not change project filters.

A live visual example appears beside the filters at creation and in the Filters dialog. Two sample conversations illustrate reply depth and the shared total budget. Green rows are included; dashed rows explain why they are hidden. The example presets fill the adjacent filters, and settings take effect when **Apply** is clicked. Example counts describe the six sample comments, not the size of the actual dataset.

Filters define the reading scope. Review can show labeled rows or all loaded source rows. Exports explicitly include saved labels, the entire source, or the original 500-row comparison, according to the selected format; they are not silently reduced to the reading scope.

## Code organization and future database integration

- `annotator.html`: semantic page structure and dialogs.
- `annotator/styles.css`: components, visual design, and responsive layouts.
- `annotator/app.js`: project lifecycle, lazy data loading, rendering, annotation, and navigation.
- `annotator/review.js` and `annotator/exports.js`: row review and export workflows.
- `annotator/reference-data.js`: the original annotations whose threads could not be recovered.
- `annotator/scope.js`: pure, independently tested depth and budget selection.
- `annotator/filter-preview.js`: interactive examples using the same scope selector as real threads.
- `annotator/repository.js`: browser persistence boundary; all project, label, filter, position, and imported-data storage goes through this class. Every write is announced through `window.__repoChanged`.
- `annotator/auth.js`: Supabase email + password gate (`window.AuthGate`) — config detection, sign-in/sign-up/sign-out, session persistence, and the blocking overlay.
- `annotator/sync.js`: cloud mirror (`window.RemoteSync`) — debounced diffs of projects, annotations, and positions against Supabase, with pull/merge at sign-in.
- `gen_config.py`: turns `.env` into `annotator/config.js` (`window.SUPABASE_CONFIG`), since a browser page cannot read `.env`.
- `supabase/migrations/20261016120000_annotator_auth.sql`: `projects`, `annotations`, `positions`, `updated_at` triggers, and the owner-only row-level policies.

Repository writes stay synchronous and local; `RemoteSync` mirrors them asynchronously, so the app needs no async storage boundaries. The migration plan's entities are in place — projects carry a stable UUID plus `meta`/`caps`, annotations key on `(project_id, node_id, reviewer_id)`, and RLS ties every row to `auth.uid()`. Imported source rows are deliberately not uploaded (they are large and reproducible from the CSV); projects created before syncing began are pushed on the next sign-in without a separate migration step. Chunked source loading and the pure scope selector are untouched.

## Verification

Run the scope regressions without dependencies:

```sh
node --test tests/annotator-scope.test.cjs
```

With runtime data built and Playwright available, run browser checks:

```sh
node tests/annotator-browser.cjs
node tests/annotator-auth.cjs
# Or set PLAYWRIGHT_MODULE to the absolute path of an installed Playwright package,
# and PLAYWRIGHT_EXECUTABLE_PATH to a system Chromium (e.g. /usr/bin/chromium) when
# Playwright's own browsers are not installed.
```

Browser checks use an isolated browser profile, exercise real data and a small imported fixture, and save desktop/mobile screenshots under `/tmp/annotator-*.png`. The auth checks cover local mode, the blocking gate when Supabase is configured, and the sign-in error path; they restore `annotator/config.js` afterwards and skip the last case when there is no network.

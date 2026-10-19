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
4. **Add annotators**: Dashboard → Authentication → Users → *Add user* (set user metadata `{"access_code": "SMCADL"}` so the account-creation trigger accepts it), or let people self-register — the sign-in gate's **Create account** flow asks for the shared access code **SMCADL** and `SUPABASE_ALLOW_SIGNUP=true` must be on. This shared code is visible in public source and is not a private invitation mechanism. For invite-only production use, disable new user sign-ups in Supabase Auth itself and provision accounts through an administrator; hiding the client sign-up button alone does not enforce this.
5. **Reload `annotator.html`** — the gate blocks the workspace until the account signs in. Labels then sync continuously: projects, per-node annotations, and reading position, all scoped to the signed-in user by RLS. The status bar shows `cloud: synced hh:mm:ss`; click it to force a sync.

Notes:

- `localStorage` remains the source of truth the UI reads, so a failed or offline sync never blocks annotation — the status bar shows `cloud: sync error` and retries on the next change.
- Signing in first pulls everything for the account, then pushes local-only work. On a conflict the local edit wins; on a fresh browser the server copy is pulled in.
- Browser workspaces are isolated by account. Existing browser work is reserved for the first account that signs in after the upgrade, without copying large imported files; subsequent accounts use separate stores. Signing out flushes local edits and closes the workspace. Responses from an earlier account cannot modify the next account's store.
- Clearing a label persists an explicit empty override, so source labels and subsequent cloud pulls cannot restore the cleared label. Project deletions are recorded explicitly before syncing; absent local projects alone never authorize deleting remote projects.
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

The workspace includes a searchable queue of posts (each post with its comment tree), a reading pane, the HumAID label guide, row review, and exports. Previous browser projects and labels use the same storage keys and continue to open.

There are exactly two project filters, available at creation and through **Filters**. Terminology: a **post** is the original submission, **comments** are the direct responses under it, and **replies** are nested responses under a comment.

- **Depth under the post:** how far down one post's conversation you see. 1 = only the comments directly under the post; 2 = also their replies; 3 = one level deeper. Leave blank for all levels.
- **Max comments per post:** a hard count per post. After depth filtering, each post keeps exactly its first N comments + replies — kept breadth-first, sorted by timestamp and then ID — so at N = 5 the 5th is kept and the 6th is cut, even if nothing follows. Each post has its own count: one post's size never affects another, and the post row itself is free. Repeated source tasks for the same post share one allocation, and every post stays in the queue.

Projects created with **Relabel 500 targets** exempt every target and its reply chain from both limits: the chains stay visible regardless of depth and sit outside the count, so the limits trim only surrounding context and the full 500-target pass stays reachable. Full-pass projects apply both limits to everything, and depth can exclude some target rows there. Existing labels are retained when filters change. The legacy `comments` storage key is ignored in saved projects. Search only narrows the visible queue; it does not change project filters.

Filters define the reading scope. Review can show labeled rows or all loaded source rows. The export dialog independently selects CSV or JSON, labeled rows or the full project, and one of four structures: original project columns, thread rows with parent IDs, the original relabeled 500 format, or a relabeled 500 format with a structured root-to-target tree path. CSV tree paths are JSON arrays stored in one cell; JSON exports keep them as arrays. Exports are not silently reduced to the reading scope.

**Labeled only means annotations explicitly saved or accepted by the annotator.** Original/reference labels do not qualify a row for this scope. Labeled exports contain each saved node once, even when the source contains repeated tasks for its thread. Target structures include only saved target nodes; use original/thread rows for saved annotations on other nodes. Full thread-row exports deduplicate node IDs, while full original-column exports preserve the source's per-task rows. Full exports merge saved changes, including explicit clears, over source labels. Labeled and full target exports have distinct filenames. Tree exports report missing parents or cycles instead of silently returning a truncated path.

## Code organization and future database integration

- `annotator.html`: semantic page structure and dialogs.
- `annotator/styles.css`: components, visual design, and responsive layouts.
- `annotator/app.js`: project lifecycle, lazy data loading, rendering, annotation, and navigation.
- `annotator/review.js` and `annotator/exports.js`: row review and export workflows.
- `annotator/reference-data.js`: the original annotations whose threads could not be recovered.
- `annotator/scope.js`: pure, independently tested depth and per-post max selection.
- `annotator/repository.js`: browser persistence boundary; all project, label, filter, position, and imported-data storage goes through this class. Every write is announced through `window.__repoChanged`.
- `annotator/auth.js`: Supabase email + password gate (`window.AuthGate`) — config detection, sign-in/sign-up/sign-out, session persistence, and the blocking overlay.
- `annotator/sync.js`: cloud mirror (`window.RemoteSync`) — debounced diffs of projects, annotations, and positions against Supabase, with pull/merge at sign-in.
- `gen_config.py`: turns `.env` into `annotator/config.js` (`window.SUPABASE_CONFIG`), since a browser page cannot read `.env`.
- `supabase/migrations/20261016120000_annotator_auth.sql`: `projects`, `annotations`, `positions`, `updated_at` triggers, and the owner-only row-level policies.

Repository writes stay synchronous and local; `RemoteSync` mirrors them asynchronously, so the app needs no async storage boundaries. The migration plan's entities are in place — projects carry a stable UUID plus `meta`/`caps`, annotations key on `(project_id, node_id, reviewer_id)`, and RLS ties every row to `auth.uid()`. Imported source rows are deliberately not uploaded (they are large and reproducible from the CSV); projects created before syncing began are pushed on the next sign-in without a separate migration step. Chunked source loading and the pure scope selector are untouched.

## Verification

Run the scope regressions without dependencies:

```sh
node --test tests/annotator-scope.test.cjs tests/annotator-sync.test.cjs
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

Export checks parse the downloaded files for all 16 format/scope/structure combinations, including repeated thread tasks, source labels, multiline Unicode text, explicit clears, imported targets, and the real 500-target dataset. Auth checks also use a simulated successful sign-in to verify account switching and immediate sign-out persistence. Sync regressions use an in-memory Supabase substitute to verify account separation, delayed responses, deletions, and offline retries. These tests do not establish that a live Supabase deployment has the intended RLS policies or enrollment configuration; verify those in the deployed project before approving a production rollout. CSV exports preserve source text, so untrusted cell text should be imported as text in spreadsheet applications rather than evaluated as formulas.

Pages deployment runs JavaScript syntax checks and the scope/sync regressions before publishing. The generated entry page uses content hashes in script and stylesheet URLs so browsers fetch the matching assets after an update. Browser/auth suites remain explicit pre-release checks because they need Chromium and a built dataset.

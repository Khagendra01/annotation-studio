# Annotation Studio — LA Wildfires (HumAID)

Browser annotator for Reddit disaster conversations: searchable thread queue,
HumAID label guide, filters, review, exports, and Point mode for the
original 500-target relabel. This repo is the **deployed site** for
`deeplearning-lab-csueb/social-media-data-LA-wildfires` (source of truth lives
there).

## Deploy

Pushes to `main` publish automatically (GitHub Actions → GitHub Pages).
The workflow:

1. generates `annotator/config.js` from the repo secrets
2. copies `annotator.html` to `index.html` and drops everything the site does not serve
3. publishes the static files

Repo secrets (Settings → Secrets → Actions):

| secret | value |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_ALLOW_SIGNUP` | `true` / `false` |

The Supabase tables, RLS, and the sign-up access-code trigger come from
`supabase/migrations/` in the source repo.

## Notes

- `data_annotated/` is committed here (the built ~23 MB thread dataset) so the
  deploy needs no build step; the source repo rebuilds it with
  `python3 build_annotator_data.py` from the tracked cleaned bundle.
- Sign-up requires the shared access code configured in
  `annotator/auth.js` (`SIGNUP_CODE`), enforced server-side by a trigger on
  `auth.users` — treat the code as semi-public, it ships in the page source.
- `annotator/config.js` and `.env` are generated/local and never committed.

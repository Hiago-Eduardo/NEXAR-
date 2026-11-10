# NEXAR

B2B supplier discovery platform built with React, Vite and Supabase.

## Structure

- `Web/` — frontend (React + Vite), unit tests (Vitest), e2e (Playwright) and helper scripts
- `Backend/supabase/` — SQL (RLS, RPCs, triggers), Edge Functions and email templates

## Prerequisites

1. Clone the repository
2. `cd Web` and install dependencies: `npm install`
3. Create `Web/.env.local` from `Web/.env.example` with your Supabase project credentials:

```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
VITE_SUPABASE_UPLOAD_BUCKET=uploads
```

4. Apply the SQL files in `Backend/supabase/` via the Supabase SQL Editor, starting with `rls-policies.sql`.

## Run the app (inside `Web/`)

```
npm run dev
```

## Other commands (inside `Web/`)

- `npm run build` — production build
- `npm run preview` — preview the production build
- `npm test` — unit tests (never write to the database)
- `npm run e2e` — Playwright
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run typecheck` — type-check with `tsc`

Supabase CLI commands (deploying Edge Functions) run from `Backend/`.

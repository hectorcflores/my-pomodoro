# Focus Sessions

A tiny local-first focus timer that syncs through Google sign-in.

## Run Locally

```bash
python3 -m http.server 8765
```

Then open:

```text
http://localhost:8765
```

## Sync Setup

Open the app and click the sync pill (top of the page) → **Sign in with
Google**. That's the whole setup, once per device. Sessions completed while
signed out stay local and are pushed to the account on the next sign-in.

Data lives in Firestore at `users/{uid}/focus_sessions`, in the same Firebase
project as my-reading-list and brain-gym; `firestore.rules` in this repo is
the versioned source of that project's ruleset (see this repo's history for
the bookmark-era Supabase setup this replaced).

## Weekly email

`scripts/weekly_email.py` sends the Saturday report. It reads Firestore with a
service account (`FIREBASE_SERVICE_ACCOUNT` secret, JSON) via a
collection-group query, so it needs no uid. Runs from
`.github/workflows/weekly-pomodoro-email.yml`; requires `google-auth`.

## GitHub Pages

Publish this repository with GitHub Pages from the root of the `main` branch. The root `index.html` redirects to `app/index.html`.

## Notes

- The Firebase web config in `app/index.html` is public by design; access
  control is Google sign-in plus Firestore rules keyed to `request.auth.uid`.
- Completed sessions are still cached locally so the app remains usable if
  sync is temporarily unavailable.

# HCP Google Calendar Sync

## Prereqs

- Node 18+
- A public HTTPS domain for webhooks
- Google Cloud project with Calendar API enabled
- HouseCall Pro API key (regenerate and share securely)

## Install

cp .env.example .env

# fill values in .env

npm install
npm start

## Authorize Google and start watch

Open:
https://YOUR_DOMAIN/oauth2/callback (after first going to /auth/google)

1. Visit https://YOUR_DOMAIN/auth/google
2. Approve access for `installation.king@gmail.com`
3. You will see "Google authorized. Watch channel set."

## Test flow

- Create a new event on `installation.king@gmail.com`
- Within seconds Google pushes to /webhook/google
- The service pulls changes and creates a Job in HCP
- Edit event time, verify the matching HCP job updates
- Delete event, verify job is deleted (or canceled if you prefer a status)

## Notes

- By default, if an event has no end time, we assume 60 minutes.
- Mapping is stored in SQLite data.sqlite
- The Google watch channel expires periodically. Call ensureWatchChannel on startup or via a daily cron to refresh.

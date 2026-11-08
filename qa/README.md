# Preview the real app with fixture accounts

This entry renders the production screens and session code with an in-memory
credential store and sanitized provider fixtures. It makes no provider calls.

In a separate checkout or disposable copy of this repository, run:

```sh
npm ci
npm pkg set main=qa/entry.tsx
npm run web
```

Use this preview to check populated lists, detail files, search, filters, sorting,
loading, retry, account controls, and the add dialog without provider credentials.
The Debrid-Link fixture fails its first list request so Retry can be checked.
The production entry remains `index.ts`; never publish the fixture entry as an app.
Native alerts, SecureStore, OS handlers, and live providers still require native
runtime tests.

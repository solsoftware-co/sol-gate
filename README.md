# sol-gate

The public front door for client websites. A website submits a form to Sol Gate; Sol Gate rate-limits it, checks its origin and Turnstile token, validates it against the form's schema, answers `202`, then (in a Cloudflare Workflow) runs the form's integrations through **sol-integrate** and notifies its channels through **sol-notify** — both internal-only, reached over service bindings.

```
POST /v1/clients/:clientId/forms/:formId/submissions
{ "fields": { "email": "jane@example.com", … }, "turnstileToken": "…" }
```

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev   # http://localhost:8790
npm test
```

See [CLAUDE.md](./CLAUDE.md) for the flow, environments and secrets.

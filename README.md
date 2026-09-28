# sol-gate

The front door for client-website form submissions. A client's server (e.g. a Next.js Server Action) submits a form to Sol Gate with an API key; Sol Gate rate-limits it, validates it against the form's schema, answers `202`, then (in a Cloudflare Workflow) runs the form's integrations through **sol-integrate** and notifies its channels through **sol-notify** — both internal-only, reached over service bindings.

```
POST /v1/clients/:clientId/forms/:formId/submissions
X-API-Key: <API_KEY>
{ "fields": { "email": "jane@example.com", … } }
```

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev   # http://localhost:8790
npm test
```

See [CLAUDE.md](./CLAUDE.md) for the flow, environments and secrets.

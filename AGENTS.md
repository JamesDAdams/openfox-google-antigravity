# AGENTS.md — openfox-google-antigravity

Paths relative to `openfox-plugins/openfox-google-antigravity/`.

## Purpose

OpenFox LLM provider leveraging a Google AI Pro subscription via Antigravity (Cloud Code Assist) as an LLM provider. OAuth authentication, model discovery, and transport to run Gemini/Claude models from OpenFox. **Warning**: using this plugin violates Google ToS (risk of account ban).

## Stack

- TypeScript, ESM, tsup, vitest 4.x
- peerDep: `openfox >=2.0.56 <3`
- Dependency: `undici ^7.30.0`

## Commands

```bash
npm run build      # tsup
npm test           # vitest run --passWithNoTests
npm run typecheck  # tsc --noEmit
```

## Project Map

```
src/
├── index.ts                     # Entry point (register, preset)
├── types/openfox.d.ts           # OpenFox types
├── constants.ts                 # Constants
├── settings.ts                  # Plugin configuration
├── ui.ts                        # Plugin UI
├── net.ts                       # Network layer
├── providers.ts                 # LLM providers
├── auth/
│   ├── antigravity-auth.ts      # Antigravity auth
│   └── google-oauth.ts          # Google OAuth auth
├── credentials/
│   └── file-credential-store.ts # File credential store
├── transport/
│   └── antigravity.ts           # Antigravity transport
├── quota/
│   ├── antigravity.ts           # Quota management
│   └── contract.ts              # Quota contract (shared)
├── routing/
│   └── routing-engine.ts        # Routing engine
└── catalog/
    ├── models-default.ts        # Default models catalog
    └── model-modes.ts           # Model modes
```

## Where to Look What

- **Modify HTTP transport** → `src/transport/antigravity.ts`
- **Modify authentication** → `src/auth/google-oauth.ts`
- **Modify quota handling** → `src/quota/antigravity.ts`
- **Modify routing** → `src/routing/routing-engine.ts`
- **Add a model** → `src/catalog/models-default.ts`

## Conventions

- `apiVersion: 2`, capabilities: `hooks`, `rpc`, `presets`, `settings`
- ESM build only via tsup
- `openfox` is externalized (provided by host)
- `.test.ts` files are co-located in `src/`

## Cross-Project Dependencies

**Consumes**: `openfox/provider` (ProviderPluginRegistry, ProviderPreset), `openfox-quota` contract via `src/quota/contract.ts`.

**Consumed by**: OpenFox (loaded as provider plugin).

**Touchpoints**:

- `src/index.ts` (register, preset)
- `src/quota/contract.ts` (quota contract)
- `src/transport/antigravity.ts` (HTTP transport)
- `src/auth/google-oauth.ts` (OAuth auth)
- `src/routing/routing-engine.ts` (routing)

## Known Gotchas

- `dist/index.js` is the entry point loaded by OpenFox, not `src/`.
- `credentials.json` and `credentials.key` must never be committed.
- The quota contract (`src/quota/contract.ts`) is shared across provider plugins.
- Violates Google ToS — account ban risk.

## Do Not Read / Do Not Touch

- `node_modules/`, `dist/`, `.git/`
- `credentials.json`, `credentials.key`

## Further Reading

- [README.md](README.md) — overview

---

> After any change affecting structure, a command, a convention, an inter-project contract, or a primary flow, update this file in the same commit. If any information here is inaccurate, fix it.

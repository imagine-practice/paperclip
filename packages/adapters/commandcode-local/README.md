# CommandCode local qualification adapter

Experimental external adapter for the OnisAll fork. Strict TypeScript in the pnpm workspace, inheriting the fork's base compiler settings. Build before registering this directory using Paperclip's **Settings → Adapters** local-package flow or `POST /api/adapters/install` with `isLocalPath: true`. The external loader reads compiled ESM from `dist`; SDK imports are type-only, with no added runtime library dependency.

## Current support

- Installed CommandCode **1.79.2**, with its public `dist/cli.mjs` SHA-256 pinned in `src/server/config.ts`; usage mapping also pins ai **6.0.302** and openai-compatible **2.0.81** source hashes.
- Local execution, explicit model, stdin prompt, headless NDJSON, fresh session and workspace.
- Company/agent/issue/run references in invocation and result metadata.
- Explicit `COMMAND_CODE_API_KEY` binding for `authMode=commandcode`, or provider keys for `authMode=byok` (adds `--local-only`). Credentials are resolved by Paperclip into `config.env`; do not store literal keys in examples.
- Output byte/line/depth/event limits, strict UTF-8, exactly one newline-terminated final result. Invalid or missing terminal output fails the run.
- Final-result-only accounting: when cache writes are zero, SDK input tokens exclude cache reads and cachedInputTokens records those reads separately. Source conversion and one native run confirm the mapping. Cache writes remain unsupported. Costs remain `unpriced`, usage completeness remains false; CLI model labels are observations, provider-side model identity remains unknown.
- Cancellation/timeout attempt to stop the owned process tree. Remote inference and external side effects remain unknown. No `executionRecovery` or `onProviderStopped` proof is emitted.
- `localProcess` records the child exit/close observation and stop attempt, without asserting that all descendants or remote requests stopped. The first board cancellation observation was rejected because the helper supplied native-only correlation to a legacy runtime run; normal completion is not cancellation proof. The helper was corrected; cancellation remains unqualified.
- Browser transcript parser and declarative configuration fields.

## Execution gate

Execution requires `qualificationMode: true`, an explicit `spendAuthorizationRef`, a prompt, model, isolated state root, and credentials. The reference must point to an approved experiment with account and spending terms. It is not a monetary limiter. Maximum turns and timeout are bounded separately.

The initial harness uses `--permission-mode plan`, disables skills, creates an empty per-run workspace, and does not inherit host credentials or user CLI configuration. These controls **do not provide an OS sandbox**. Two short live calls using `deepseek/deepseek-v4.1-flash` succeeded; the latest native token receipt matches the final CLI usage. Project discovery, tool behavior, complete billing, cancellation, and provider-side model identity still need qualification. Do not run customer code or unattended production work.

Remote targets and automatic resume are unsupported. Session IDs are retained as evidence; `sessionCodec.deserialize` deliberately cannot restore them. No model is queried by environment diagnostics: the probe uses `--version` with an empty credential environment. Diagnostics return `warn` after a successful version check because live capabilities remain unqualified.

## Development

From the fork root:

```powershell
pnpm --filter @onisall/adapter-commandcode-local typecheck
pnpm --filter @onisall/adapter-commandcode-local build
pnpm --filter @onisall/adapter-commandcode-local test
```

`src/server` owns execution/configuration/protocol/process code; `src/ui/parse-stdout.ts` is a self-contained browser parser. Type checking uses strict TypeScript and the current adapter SDK; build emits JS, declarations and source maps. Tests use synthetic protocol/process fixtures and do not call a model. Package exports point at compiled files because the external adapter loader and browser parser endpoint require runnable JavaScript. After rebuilding imported modules, restart the development server: the current loader's hot reload only invalidates the entry module, so child modules can remain cached.

Runtime qualification records remain in the parent workspace under `docs/work/tasks/ONS-0005-commandcode-adapter.md`. The TypeScript migration and its evidence are tracked in `docs/work/tasks/ONS-0013-commandcode-typescript.md` and `docs/work/evidence/ONS-0013/`.

# ApOps Agent

An autonomous accounts-payable operator. You give it a plain-English task; it works out the steps itself, operates a mock company ERP (FinDesk) through a real browser, asks a human before committing changes, and proves the outcome by checking the database independently of anything the agent claims.

Built with LangChain.js, LangGraph.js, OpenAI tool calling, Playwright, Express and SQLite.

## Setup

Requires Node.js 22 or newer (better-sqlite3 13 and the LangChain OpenAI package require it). Check with `node -v`.

```bash
npm install
npx playwright install chromium     # one-time browser download
cp .env.example .env                # set OPENAI_API_KEY (and optionally OPENAI_MODEL)
```

## Run

Terminal 1, the mock ERP (login admin / admin123):
```bash
npm run erp
```
Terminal 2, give the agent a task:
```bash
npm run agent -- "Enter the latest invoice from Acme Corp into FinDesk and tell me when it's done" --reset
```
Flags: `--chaos flakySubmit,renamedField,sessionExpiry,silentCorruption,duplicateExists` (comma-separated, space after `--chaos`), `--auto-approve`, `--headed`, `--max-steps 20` (default 20), `--reset`.
Other tasks on the same code: "Mark Globex Ltd invoice INV-7731 as paid", "Which invoices are overdue?".

To reset FinDesk to its seed data (4 invoices) without running a task: `npm run erp:reset`.

Every run writes a step-by-step trace (`runs/<time>/trace.jsonl`): each model decision, policy decision, tool result, verification and escalation.

### What the chaos toggles simulate

| Toggle | What FinDesk does | What the agent must do |
|---|---|---|
| `flakySubmit` | Returns HTTP 503 on the first invoice submission | Notice the error page and recover safely |
| `renamedField` | Renames the amount input and its label | Find the field by its label, not a hardcoded name |
| `sessionExpiry` | Expires the session after a few requests | Notice the sign-in page and sign in again |
| `silentCorruption` | Shows "saved" but stores amount ÷ 10 | Be caught by the verifier, then fix the record |
| `duplicateExists` | Invoice already exists (HTTP 409) | Stop without creating a duplicate |

## Web UI (easiest way to run and demo)

```bash
npm run ui        # starts FinDesk too if it is not already running 
                # use this command to run direclty it starts everything 
```
Open http://localhost:3000 (it listens on this machine only). Type a task (or pick an example) and press Run task. Test problems (the chaos toggles) and run options are under "Options and test problems".

The page is built to say plainly what is happening:
- **What the agent did** lists every action as a plain sentence ("Typed “42500” into Amount", "Read acme_invoice_april.pdf"), with a spinner while it runs, a tick when it worked, and a cross or warning when it did not. A page that reports an error (a 503, a duplicate, an expired session) is flagged even though the browser call itself succeeded. "Technical details" under each step holds the raw input and output.
- **Approval needed** appears the moment the agent wants to do something that changes data. It names the action, where the form goes, why you are being asked, and the values filled in on the page, with Approve and Deny buttons. The status chip and tab title change to "Waiting for you".
- **Questions** from the agent appear as an answer box in the same place.
- **The result card** (Done and verified, Could not complete, and so on) shows the summary, how many steps it took, whether FinDesk records changed, and a table of what the agent entered next to what the database stores.
- **FinDesk right now** shows the real database and highlights rows that just changed. **Past runs** replays any stored run, including every model call.

The UI runs the same agent runtime as the CLI and only reads the database; it does not change how the agent works. It uses no external fonts, scripts or images, so it works offline.

**Access control.** Any web page open in your browser can send requests to `localhost`, so the UI does not trust the network location. It binds to localhost, rejects foreign `Host` headers (DNS rebinding), hands a random per-server token to the page it serves as an HttpOnly `SameSite=Strict` cookie, and requires that cookie on every `/api` and `/runs` request (so the live stream and screenshots are protected too). Every state-changing request also needs the same token in an `x-ui-token` header, a matching `Origin`, and a JSON content type. Inputs are validated (types, task length, chaos allow-list), and a response only approves an action if it is the boolean `true`. **Auto-approve is off by default**: it only works if you start the UI with `UI_ALLOW_AUTO_APPROVE=1`. FinDesk's own admin endpoints (reset, chaos) also reject foreign hosts and need an `x-apops-admin` header.

## Logging and run history

Every run writes two logs on the server, in `runs/<timestamp>/`:
- `trace.jsonl`: the agent's actions in order: each decision (with model latency and token usage), each policy decision (risk, approved or denied), each tool result including failures, stuck escalations, verifier results, and the final result or error.
- `llm.jsonl`: written by a LangChain callback handler (`agent/logging.js`): for every model call, exactly what was sent (system prompt with company memory, the full message history, tool results), what the model answered, and how long it took.

The UI shows the live trace while a run is going, and a **Past runs** list below the database panel. Pressing View replays any stored run, including a table of every model call; open a row to see what the model was sent and what it answered. These endpoints need the same session as the rest of the UI, and raw log files are never served as static files.

## Tests and evals

```bash
npm test                  # runtime, LangChain/OpenAI request shape, logging, UI server (incl. access control), verifier edge cases, eval checkers (no key/browser)
npm run check:browser     # real Chromium: browser layer + approval boundary (start the ERP first)
npm run test:e2e          # real Chromium + real ERP with a scripted LLM, and the UI page in a real browser (no API key)
npm run eval              # live agent on every scenario; writes evals/RESULTS.md and evals/results.json
npm run eval -- --only chaos:silentCorruption --runs 3 --headed
```

The live eval takes a while and uses OpenAI credits. It auto-approves irreversible actions so it can run unattended (the approval gate is covered by the deterministic tests and the denial run described under Results).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | required | OpenAI key |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat model used by the agent |
| `ERP_URL` / `ERP_PORT` | `http://localhost:4000` / `4000` | Where FinDesk runs |
| `UI_PORT` | `3000` | Web UI port |
| `UI_ALLOW_AUTO_APPROVE` | off | Set to `1` to let the UI offer auto-approve |
| `FILES_DIR` | `samples/` | The only folder the file tools may read |
| `ALLOWED_ORIGINS` | the ERP URL | Origins the browser tools may visit |
| `COMPANY_MEMORY` | `agent/company_memory.md` | Persistent company knowledge file |
| `PLAYWRIGHT_CHROMIUM_PATH` | bundled Chromium | Use a different Chromium binary |

## Architecture

The agent is a **LangGraph.js state graph** that drives a **LangChain.js** chat model (`ChatOpenAI`) and LangChain tools.

```
START -> agent --(tool calls)--> act --> agent ...        loop until a node sets a result
           |                      |
           |--(prose only)--> nudge --> agent
           '--(result set)--> END     act --(result set)--> END

agent : LangChain ChatOpenAI (tools bound) decides the next action
act   : validate input (zod) -> policy / approval -> run the LangChain tool -> observe -> stuck check
        finish(claims) -> independent verifier reads the database -> pass: END / fail: back to the model
```

- **LLM is the planner; LangGraph owns the control flow; our code in the nodes is the runtime.** The prompt (`agent/prompt.js`) gives goals and rules, never a fixed sequence of tools. The runtime executes tools, enforces permissions, handles failures and verifies outcomes.
- **Tools** (`agent/tools.js`) are LangChain `DynamicStructuredTool`s with zod input schemas, and they are generic: `list_files`, `read_file`, `browser_open`, `browser_read`, `browser_type`, `browser_click`, `browser_screenshot`, `remember`, `ask_human`, `save_company_rule`, plus `finish`. Nothing in them is specific to invoices.
- **Policy** (`agent/policy.js`) lives outside the model. Default-deny: a click is only let through without approval if the real element is a plain navigation link or a sign-in form; every other button, unknown element, unknown tool, or action that cannot be assessed needs human approval. Memory writes need approval too. The browser may only visit allow-listed origins. A click is assessed against one pinned element; after approval the runtime revalidates that the same element is still attached and unchanged (text, target, form action, page), then clicks that exact element. If anything differs, nothing is clicked and the agent is told to re-read the page. An approval is single-use.
- **Verifier** (`agent/verifier.js`) reads the system of record directly (via a small adapter) and compares it with the agent's claims. It also checks values against the source document **next to the right label**, so a subtotal cannot pass as the total, nor an invoice date as the due date. If a document prints **several different values** next to the same label (an original and a revised total, two dates on the due-date line), verification fails with an "ambiguous source" message until the agent has actually consulted a human, and even then the claimed value must be one that appears in the document. After a state change, any claim that sets a document-derived field (amount, due date, PO number) must name its `source_file`; otherwise all of those document checks would be skipped. Status-only claims such as "mark as paid" need no document.
- **Stuck detection** (`agent/graph.js`, the `act` node): the same call failing 3 times stops the run and asks a human; a human reply lets it continue, "stop" aborts it. `maxSteps` is the hard ceiling.
- **Two kinds of state change** are tracked separately: changes to business records require verification claims; changes to persistent memory require approval (and are read back) but need no database claims.
- **Memory**: run notes (`remember`) are re-injected every step; `agent/company_memory.md` persists across runs and is loaded into every prompt.
- **Adapter** (`agent/adapters/findesk.js`): the only app-specific code (how to read FinDesk's database and which printed labels mark which field). A different app needs a new adapter and company knowledge, not new agent logic.

### Project layout

```
agent/      graph.js (LangGraph loop)  tools.js  policy.js  verifier.js  browser.js  memory.js
            prompt.js  llm.js  loop.js (runs the graph, writes the trace)  logging.js  cli.js
            adapters/findesk.js  company_memory.md
erp/        server.js (mock FinDesk with chaos toggles)  db.js (SQLite schema + seed data)
ui/         server.js (Express + SSE)  index.html
evals/      run.js (live-model scenarios and checkers)
samples/    invoice PDFs used as source documents
test/       deterministic suites, browser tests, scripted-model helper
```

## Design decisions

- **Why LangChain.js and LangGraph.js?** LangChain gives a provider-neutral chat model, tool and message interface (swap OpenAI for another tool-calling model by changing `agent/llm.js`); LangGraph gives an explicit, inspectable state machine instead of a hand-rolled `while` loop. The files that matter most (policy, verifier, pinned-click approval) are plain code that plugs into graph nodes, so they stay testable without any framework.
- **Why custom nodes instead of the prebuilt ReAct agent or `ToolNode`?** The prebuilt agents run tools as soon as the model asks. Here every call must pass input validation, the approval policy and failure accounting first, and `finish` must pass the independent verifier. Those are exactly the parts that need to be ours.
- **Why callbacks for human approval instead of LangGraph `interrupt()`?** Approvals are awaited inside the node, which is simple and works for a single local process. For production, `interrupt()` plus a persistent checkpointer would let a run pause for hours and resume after a restart (see "What I would build next").
- **Why an independent verifier?** Models can say "done" when nothing was saved. FinDesk's `silentCorruption` toggle shows "Invoice saved successfully" while storing a wrong amount; only reading the database catches it.
- **Why policy in code?** A prompt rule can be ignored or argued around; a runtime check cannot. The approval decision is based on the element that will actually be clicked, not the words the model used to describe it.
- **Why must claims name their source document?** The verifier can only compare against a document it is pointed at. The live run showed a model leaving `source_file` out, which skipped the document checks. Making it mandatory for document-derived fields closes that gap while keeping status-only changes simple.
- **Why page text and form fields instead of screenshots?** Cheaper, faster and more reliable for a form-based app. Screenshots are saved only as evidence.
- **Why SQLite and Express for the ERP?** Easy for the verifier to read directly, easy to run anywhere, and the chaos toggles are simple to add.

## Models, APIs and libraries

LangChain.js (`@langchain/core` tools and messages, `@langchain/openai` `ChatOpenAI`), LangGraph.js (`@langchain/langgraph`), zod, OpenAI tool calling (model set by `OPENAI_MODEL`, default `gpt-4o-mini`), Playwright (Chromium), Express 5, better-sqlite3, pdf-parse, dotenv. Sample PDFs were generated with reportlab. No real credentials or third-party systems are used; everything is a local sandbox.

## Assumptions

- Single user, local sandbox; FinDesk credentials live in company knowledge (a real system would use a secrets vault).
- Source documents are text-based PDFs in `samples/`; scanned documents would need OCR.
- "Latest invoice" is decided from dates printed in the documents.

## Results

Live run on `gpt-4o-mini` with `npm run eval -- --runs 3` (9 scenarios x 3 runs = 27 runs, isolated test database, real ERP and browser). **18 of 27 runs passed (67%).** These numbers were measured **before** the fixes listed below; they have not been re-run since.

| Scenario | Passed | Failure injected | What happened |
|---|---|---|---|
| `baseline` | 3/3 | none | Read the PDFs, chose the latest invoice, filled the form, verifier passed |
| `chaos:flakySubmit` | 1/3 | HTTP 503 on first submit | 1 run re-opened the form and resubmitted. 2 runs called `ask_human` instead of retrying (the eval answered "use your best judgment, else cannot_complete") and ended `cannot_complete`. Nothing was duplicated. |
| `chaos:renamedField` | 3/3 | amount field renamed | Found the field by its new label |
| `chaos:sessionExpiry` | 3/3 | session expired mid-task | Saw the sign-in page, signed in again, finished |
| `chaos:silentCorruption` | 1/3 | amount stored as ÷ 10 | The verifier rejected the wrong amount in all 3 runs. 1 run then edited the record and passed; 1 gave up with `cannot_complete`; 1 hit the step limit. |
| `chaos:duplicateExists` | 3/3 | invoice already present | Saw the 409, created no duplicate, ended `cannot_complete` |
| `task:markPaid` | 1/3 | none | 2 runs clicked the plain-text invoice number (not a link) instead of the ID link in the first column |
| `task:listOverdue` | 0/3 | none | The answer was correct (INV-1001, INV-0055, INV-7731; paid INV-7700 excluded) but sat in the model's prose while the structured `summary` was a one-liner, so the checker, which reads `summary`, failed |
| `memory:acrossRuns` | 3/3 | none | Saved a company rule and applied it in a later run |

Two extra single live runs outside the suite:
- **Approval denied** (human gate returns false on Submit): passed. The agent did not retry, asked what to do, ended `cannot_complete`, and nothing was written to the database.
- **Conflicting totals in the source PDF** (42,500 vs 40,000): **failed.** The agent picked the revised total without asking a human, and left `source_file` out of its claim, which skipped the document checks. This led to the first fix below.

What the live run showed:
- The verifier caught every injected corruption (3/3), and no run created a duplicate record or had a wrong value accepted as success.
- Most failures are the agent's persistence or choices (giving up, running out of steps, guessing between conflicting values, clicking text that is not a link), not verifier or policy failures.
- The eval auto-approves irreversible actions, so the approval gate itself is exercised by the deterministic tests and the single denial run, not by the 27-run suite.

### Defects found by the live run, and what changed

| ID | Problem | Change |
|---|---|---|
| D-1 | A claim without `source_file` skipped the document checks, including the ambiguous-source check | `verifier.js` now rejects document-derived claims (amount, due date, PO number) that have no `source_file` after a state change; status-only claims are exempt. Test added in `test/verifier.test.js`. |
| D-2 | `listOverdue` failed because the full answer was not in `summary` | The `finish` tool now says the summary must contain the complete answer, since it is all the user sees. The checker is unchanged on purpose: it should keep testing what the user is told. |
| D-3 | Agent clicked invoice numbers, which are plain text | Added a FinDesk note to `agent/company_memory.md`: click the ID in the first column or open `/invoices/<ID>` directly. |

Run `npm run eval -- --runs 3` again to measure the effect of these changes.

## Known limitations

- One mock app and a small task set. Generalization is shown by running different tasks on the same code, not by supporting many applications.
- A small model is not always persistent: on `silentCorruption` it sometimes stops instead of fixing the record, and on a transient 503 it often asks a human instead of retrying. Both are safe, but they are less autonomous than intended. A company rule such as "after a failed submit, check the invoice list for the record before resubmitting" would make retrying safe; it is not implemented.
- When a document is ambiguous, the model may still guess instead of asking. The verifier is the backstop: it now forces a source document and rejects ambiguous values until a human has been consulted.
- The approval gate is deliberately conservative: it may ask for approval on harmless buttons that are not links or sign-in forms.
- A page-level error (an HTTP 503 page, the sign-in redirect) comes back to the agent as normal page text, not as a tool failure. The agent notices it by reading the page, but the stuck counter only counts tool failures, so a loop of such pages would end at the step limit.
- If the model API fails after its retries, the run ends with an error in the trace instead of a graceful `failed` result.
- The verifier can only check what the adapter can read; read-only tasks (e.g. listing overdue invoices) have nothing to verify against the database, and their answers are checked only by the eval harness.
- Label-anchored source validation depends on the adapter's label list; documents with unusual labels fall back to "value appears in document" (recorded as `no_label_found`). Conflict detection is deliberately cautious: a late-fee date on the due-date line also triggers a human question. Dates like 05/06/2026 are read day-first. Scanned documents are not supported.
- The UI is a single-user local tool: its session token protects against other web pages, not against other users logged into the same machine.
- Approval and the stuck check are exact-match on the same call; a model that varies its arguments slightly can retry more times before the stuck check fires (the step limit still applies).
- A very small window remains between the final revalidation and the click itself (Playwright's own actionability checks cover part of it).
- Prompt injection from page or document content is only partly mitigated (policy gate, origin allow-list, approval for memory writes); it is not eliminated.
- Results depend on the model; the LLM is non-deterministic, so evals should be run several times (`--runs`).

## What I would build next

LangGraph checkpointing with `interrupt()` for durable, resumable human approvals; treating HTTP error pages and sign-in redirects as failures in the browser layer, with explicit "error detected" and "recovered" trace events that record the cause and the action taken; a graceful `failed` result when the model API is down; parallel/queued runs and scheduling; a real secrets vault and per-role permissions; vision fallback for non-form UIs; a second application through a second adapter; an approval UI instead of terminal prompts; optional LangSmith tracing (`LANGSMITH_TRACING=true`) alongside the JSONL trace; and CI-run evals with trend tracking.

## AI coding tools used

ChatGPT and Claude were used as AI coding assistants during this project.
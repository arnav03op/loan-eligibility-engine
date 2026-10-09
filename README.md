# Loan Eligibility Engine

This project takes a CSV of users, finds personal-loan products on Indian bank websites, works out
which loans each user probably qualifies for, and emails them the best ones.

It has two halves:

* **AWS (Python Lambdas)** receives the CSV and saves the users into a database.
* **n8n (self-hosted, in Docker)** runs the business logic: crawl loan sites → match users → send emails.
* **Gemini (AI)** is used only for the few cases where plain rules can't decide.

> **About the demo.** The demo is the recorded video. It shows the code, the AWS resources, every
> n8n workflow and a full run from CSV upload to email. Live use needs the author's laptop running n8n
> and the tunnel, and the database switched on (`scripts/resume.sh`). To save money the database is
> stopped between demos (`scripts/pause.sh`).

## How it works

```mermaid
flowchart LR
  subgraph Browser
    UI[Upload page]
  end
  subgraph AWS["AWS ap-south-1 (serverless.yml)"]
    APIGW[HTTP API Gateway<br/>throttled]
    PRE[presign λ]
    STAT[status λ · VPC]
    UIF[ui λ]
    S3[(S3 uploads<br/>private, SSE, 7-day expiry)]
    ING[ingest λ · VPC]
    NOT[notify λ]
    RDS[(RDS PostgreSQL 16<br/>TLS enforced)]
    SSM[SSM Parameter Store]
    SES[Amazon SES]
    VPCE[S3 gateway endpoint]
  end
  subgraph Laptop["Self-hosted (n8n/docker-compose.yml)"]
    TUN[cloudflared tunnel]
    subgraph N8N[n8n]
      WA[A · Product Discovery<br/>daily 02:00 IST]
      WB[B · User-Loan Matching<br/>signed webhook]
      WC[C · User Notification]
      WE[E · Error Alerts]
    end
  end
  SITES[BankBazaar · Tata Capital · IDFC FIRST]
  GEM[Gemini API]
  INBOX["Owner's Gmail + aliases"]

  UI -- "GET /" --> APIGW --> UIF
  UI -- "POST /uploads" --> APIGW --> PRE
  UI -- "GET /uploads/{id} (poll)" --> APIGW --> STAT --> RDS
  UI -- "presigned POST (file bytes)" --> S3
  S3 -- ObjectCreated --> ING
  ING -- "GetObject (stream)" --> VPCE --> S3
  ING -- "COPY + upsert" --> RDS
  ING -- "OnSuccess destination" --> NOT
  NOT -- "tunnel URL + secret" --> SSM
  NOT -- "HMAC-signed POST" --> TUN --> WB
  WA --> SITES
  WA --> GEM
  WB --> GEM
  WA & WB & WC -- "TLS, CA-verified" --> RDS
  WB -- "Execute Workflow" --> WC
  WC --> SES --> INBOX
  WA & WB & WC -. on error .-> WE
  WE --> SES
```

**The flow, step by step**

1. The upload page asks the API for a one-time S3 upload link and sends the CSV **straight to S3**. The file never goes through API Gateway or Lambda, so there are no size or time limits to worry about.
2. S3 triggers the **ingest Lambda**. It reads the CSV as a stream, checks every row and bulk-loads the good ones into PostgreSQL.
3. When ingest succeeds, AWS runs the **notify Lambda**. It sends a signed message (through a cloudflared tunnel) to **Workflow B** in n8n.
4. **Workflow B** matches the new users with the loan products, then starts **Workflow C**, which emails the results.
5. **Workflow A** runs every night and keeps the list of loan products fresh.
6. **Workflow E** emails the owner if A, B or C fails.

The upload page checks progress every few seconds and shows the status and the matching numbers live.

## What's in the repo

| Path | What it is |
|---|---|
| `serverless.yml` | All the AWS pieces: S3, 5 Lambdas, API, database, security groups, permissions |
| `backend/src/loan_engine/` | Lambda code, the upload page and helpers (CSV checks, loader, batch state, signing) |
| `backend/tests/` | Python tests |
| `db/migrations/` | Database tables |
| `n8n/docker-compose.yml` | n8n, the tunnel and a local dev database |
| `n8n/workflows/*.json` | **The n8n workflows to import** (generated, don't edit by hand) |
| `n8n/workflows/src/` + `n8n/code/` | The workflow templates and the JavaScript they are built from |
| `n8n/code/test/` | Tests for the n8n JavaScript |
| `sample-data/users.csv` | 10,000 sample users |
| `scripts/` | Helper scripts: deploy, migrate, tunnel, pause/resume, end-to-end test |

## Setup

Tested on Ubuntu 24.04 with Docker (Compose v2), Node 22, Python 3.12, AWS CLI v2, Serverless
Framework 3, n8n 2.42.4 and cloudflared 2026.10.0. You also need `psql`, `zip` and `curl`.

### 1. Prepare your machine

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
npm install
cp n8n/.env.example n8n/.env                        # set N8N_ENCRYPTION_KEY (openssl rand -hex 32), SES_FROM,
                                                    # TEST_INBOX_ALIASES and ADMIN_ALIAS (your Gmail + aliases)
cp n8n/credentials.env.example n8n/credentials.env  # put your Gemini key in GEMINI_API_KEY
scripts/fetch-rds-ca.sh                             # certificate bundle for secure database connections
```

`n8n/.env` has the settings the workflows use: `GEMINI_MODEL` (default `gemini-3.5-flash-lite`),
`LLM_MAX_CALLS` (20), `NOTIFY_MAX_EMAILS` (5) and the inbox addresses. `WEBHOOK_SECRET` is filled in
by a script in step 3. Both `.env` files are gitignored.

### 2. AWS account and email (SES)

1. Create an IAM user for deployment with an access key, then run `aws configure` (region `ap-south-1`).
2. Run `scripts/verify-ses-identities.sh`. It sends verification emails to your sender and test addresses. Click each link (check Spam), then run the script again until everything says `verified`. SES in sandbox mode only sends between verified addresses.
3. Run `scripts/create-ses-user.sh`. It creates a small IAM user that can only send email and saves its key in `n8n/credentials.env`.

### 3. Deploy to AWS

```bash
scripts/bootstrap-ssm.sh        # creates the DB password, webhook secret and URL parameters (never overwrites)
scripts/sync-n8n-secret.sh      # copies the webhook secret into n8n/.env and restarts n8n
scripts/deploy.sh               # builds the Lambda zip and runs serverless deploy
scripts/migrate.sh "$(scripts/rds-url.sh)"
```

The first deploy takes 10–20 minutes (mostly the database). It is safe to run again. The upload page
address is the stack's `ApiUrl` output:

```bash
aws cloudformation describe-stacks --region ap-south-1 --stack-name loan-eligibility-engine-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text
```

### 4. Set up n8n

n8n is running at http://localhost:5678 (localhost only). If not:
`docker compose -f n8n/docker-compose.yml up -d n8n`. Open it and create the owner account, then add the three credentials.

* **Scripted (recommended):** run `scripts/use-rds-in-n8n.sh`. It fills in the database details and imports the credentials with the IDs the workflows already expect, so nothing needs re-wiring. The generated file contains secrets, so it is gitignored and you can delete it after import.
* **By hand in the UI** (*Overview → Credentials → Create*), using these exact names. New credentials get new IDs, so afterwards open each workflow and re-select the credential on any node with a warning.

| Name | Type | Values |
|---|---|---|
| `Loan Engine Postgres` | Postgres | Host = `DatabaseHost` stack output, port `5432`, database `loan_engine`, user `loan_admin`, password from `aws ssm get-parameter --name /loan-engine/db-password --with-decryption`, SSL `require` |
| `Gemini API key` | Header Auth | Name `x-goog-api-key`, value = your key from https://aistudio.google.com/apikey |
| `Loan Engine AWS SES` | AWS | Region `ap-south-1`, plus the key of the send-only IAM user |

Import the workflows, then publish **A, B and C** and restart n8n:

```bash
N8N="docker compose -f n8n/docker-compose.yml"
for wf in E_error_handler C_notification B_user_matching A_product_discovery Z_runtime_check; do
  $N8N exec -T n8n n8n import:workflow --input=/import/workflows/$wf.json
done
$N8N exec -T n8n n8n publish:workflow --id=loanEngineWfA001   # nightly schedule
$N8N exec -T n8n n8n publish:workflow --id=loanEngineWfB001   # webhook
$N8N exec -T n8n n8n publish:workflow --id=loanEngineWfC001   # n8n 2.x only runs published sub-workflows
$N8N restart n8n
```

Importing a workflow un-publishes it, so publish again after re-importing. All three (A, B, C) must be published, because B starts C and n8n refuses to run an unpublished sub-workflow.

Run **Z · Runtime check** once to confirm everything is wired up:

```bash
docker compose -f n8n/docker-compose.yml exec -T -e N8N_RUNNERS_BROKER_PORT=5690 -e N8N_PORT=5699 \
  n8n n8n execute --id=loanEngineWfZ001
```

You should see `bundled_lib_hash_of_abc` = `e71fa2190541574b`, `crypto_node_matches_vector: true`,
`webhook_secret_configured: true`, your `gemini_model`, and `test_inbox_count` of at least 1.

### 5. Load products and run it

```bash
docker compose -f n8n/docker-compose.yml exec -T -e N8N_RUNNERS_BROKER_PORT=5690 -e N8N_PORT=5699 \
  n8n n8n execute --id=loanEngineWfA001   # first crawl (or click Execute on workflow A)
scripts/start-tunnel.sh                    # starts the tunnel and tells AWS its address
```

Now open the `ApiUrl`, upload `sample-data/users.csv` and watch the status and matching numbers update.
`scripts/e2e_upload.py` does the same from the command line.

**The emails will probably go to Gmail Spam.** The sender is a `gmail.com` address, but SES sends it
from Amazon's servers, so Gmail doesn't trust it. For the demo, open Spam and click *Not spam*. The real fix is
to verify your own domain in SES.

### Day-to-day

* **Tunnel restarted?** The free tunnel gets a new address each time. Run `scripts/start-tunnel.sh`. No redeploy needed.
* **Home IP changed?** Run `scripts/allow-my-ip.sh` (it redeploys with your new IP).
* **Pause between demos.** `scripts/pause.sh` stops the database (only storage is billed). AWS restarts a stopped database after 7 days, so pause it again then. `scripts/resume.sh` starts it, waits, and restarts the tunnel.

### Troubleshooting

| Problem | Fix |
|---|---|
| Tunnel dropped (cloudflared says `Tunnel not found`, notify Lambda can't connect) | Run `scripts/start-tunnel.sh`, then re-send the stuck batch: `aws lambda invoke --function-name loan-eligibility-engine-dev-notify --cli-binary-format raw-in-base64-out --payload '{"responsePayload":{"batch_ids":["<batch_id>"]}}' /dev/stdout`. Always run `start-tunnel.sh` just before a demo and keep the laptop awake. |
| Workflow C doesn't run: "Workflow is not active" | Publish C (`publish:workflow --id=loanEngineWfC001`) and restart n8n. |
| Gemini 404 or 503 | Some models are unavailable or busy. Set `GEMINI_MODEL` (default `gemini-3.5-flash-lite`) and restart n8n. |
| Emails in Spam | Expected with a gmail.com sender. Mark *Not spam*. |
| n8n or psql can't reach the database | Your home IP probably changed. Re-run `scripts/deploy.sh`. |

### Teardown

`scripts/teardown.sh` empties the bucket and deletes the whole stack, including the database (no backup).
Run it from the same checkout you deployed from. Add `--purge-params` to also delete the SSM parameters.

### Running without AWS

You can run everything locally with a Docker PostgreSQL. Do steps 1 and 4 (skip `use-rds-in-n8n.sh`), set
`WEBHOOK_SECRET` in `n8n/.env` yourself (`openssl rand -hex 32`), and recreate n8n with
`docker compose -f n8n/docker-compose.yml up -d n8n`. Then:

```bash
docker compose -f n8n/docker-compose.yml --profile dev up -d dev-db
scripts/migrate.sh postgresql://loan:loan@localhost:55432/loan_engine
python3 scripts/make-n8n-credentials.py
docker compose -f n8n/docker-compose.yml exec -T n8n n8n import:credentials --input=/import/credentials/credentials.json
.venv/bin/python scripts/load-local.py sample-data/users.csv   # prints a batch_id
.venv/bin/python scripts/sign-webhook.py <batch_id>            # sends what the notify Lambda would send
```

Emails still go through SES, so you need the SES credential and verified addresses for that step.

## Design decisions

### Uploading and loading users
* **Browser → S3 directly.** The upload link makes S3 itself enforce the 50 MB limit and the CSV file type. It expires after 10 minutes.
* **Streaming + `COPY`.** The Lambda reads the file as a stream, so memory stays small however big the file is. Good rows go in with PostgreSQL's fastest bulk load, then one `INSERT … ON CONFLICT` updates the users table. 10,000 rows take about 1.6 s.
* **Bad rows don't break the batch.** They are counted, and the first 50 are shown (line, field, reason). A broken header or a non-UTF-8 file fails the batch with a clear message.
* **Safe to repeat.** S3 can deliver the same event twice. A batch claim plus a lock makes the second one do nothing, so matching never runs twice.
* **Re-uploading a user re-checks them.** Their old matches are deleted in the same transaction, so they are matched and emailed again fresh.

### Cloud and security
* **No NAT Gateway (saves about $32/month).** The ingest Lambda sits in the VPC to reach the database and reads S3 through a free gateway endpoint. Anything that needs the internet is in a separate notify Lambda outside the VPC.
* **Locked-down database.** It is reachable from the Lambdas and from your IP only. TLS is required, and both the Lambdas and n8n verify its certificate.
* **Secrets.** The DB password and webhook secret live in SSM as encrypted parameters, and nothing secret is committed. One trade-off: the DB password is put into the VPC Lambdas' environment at deploy time (Lambda encrypts it at rest).
* **Least privilege.** Every Lambda has its own role with only what it needs.
* **Signed webhook.** Each call carries `X-Timestamp` and `X-Signature = HMAC-SHA256(secret, "{timestamp}.{batch_id}")`. Workflow B checks it with n8n's Crypto node, compares in constant time, and rejects anything older than 5 minutes (HTTP 401), which also blocks replays. A valid call gets an instant `202` and matching continues in the background. An unknown `batch_id` is harmless: nothing is saved and C never starts.
* **Retries.** The notify Lambda tries up to 3 times on network errors or 5xx. A 4xx (like a bad signature) fails at once.
* **n8n exposure.** n8n listens on localhost only, so the tunnel is the only public way in, and it exposes n8n behind its owner login. Use a strong password and stop the tunnel when you're not demoing. The API is throttled (burst 20, 10 requests/s).

### Workflow design
* **Logic lives in tested code.** Each Code node is a thin file. The real logic (SQL builders, matching rules, HTML cleaning, email rendering) is in `n8n/code/lib/` with tests, including SQL run against a real PostgreSQL. `scripts/build-workflows.py` bundles it into the workflow JSON, and a test fails if the JSON gets out of date.
* **One item, not ten thousand.** Postgres nodes run a single statement that returns one row of JSON. n8n gets slow with huge numbers of items, and a query that returns zero rows would silently stop a branch.
* **Safe SQL.** All values go through one tested module, and data is passed as escaped JSON.
* **Errors are visible.** A, B and C all use E as their error workflow. E emails the owner which workflow and node failed, the message and a link.

### AI usage
* Gemini is called from n8n HTTP Request nodes with a fixed answer format (`responseSchema`, temperature 0), one call at a time. Each call gets 3 tries. If it still fails, the workflow doesn't crash: A marks that source `failed`, and B falls back to a simple score rule.
* **Model: `gemini-3.5-flash-lite`** (change it with `GEMINI_MODEL`). On 2026-10-07 `gemini-2.5-flash` returned 404 for a new key, and bigger models were often busy or timed out. Flash-lite answered reliably, and our two jobs (pulling a list out of text, and yes/no judgements) are easy for it.

### Finding loans on the web (Workflow A)
* **Three sources:** BankBazaar (many lenders on one page), plus Tata Capital and IDFC FIRST Bank (exact eligibility rules). All three are plain server-rendered HTML, so a simple HTTP request works with no browser needed.
* **Cleaning:** drop scripts, styles, menus and footers; keep only lines about rates, CIBIL, income, age and employment (plus neighbours), capped at 15,000 characters. This cuts AI cost and noise.
* **Change detection:** a fingerprint of the cleaned text is saved. If a page hasn't changed, Gemini is skipped.
* **Clean data out:** Gemini returns structured JSON, and code then fixes it (yearly to monthly income, swapped min/max, standard job types, range checks, duplicates).
* **Missing rules:** filled with cautious defaults and marked `criteria_source = 'inferred'`.
* **Who owns a product:** a lender's own page always wins. A comparison site can add new products and update its own, but never overwrites a lender's.
* **Resilience:** requests are retried, and one site failing doesn't stop the others. If a page gives nothing, its old products are kept. A database error fails the run so E alerts you. Products a site stops listing are switched off, not deleted. If a product's rules change, its saved AI answers are thrown away.
* **Measured locally:** the first crawl stored 21 active products (19 BankBazaar, 1 Tata Capital, 1 IDFC FIRST). A second crawl found all three pages unchanged and made no Gemini calls.

### The matching funnel (Workflow B)

Matching every user with every product using AI would be hugely expensive. So each stage handles what it can and passes only the unclear pairs on:

| Stage | Where | What it does |
|---|---|---|
| **1. SQL filter** | PostgreSQL | One query drops every pair that can't qualify (income, CIBIL, age or job type doesn't fit). It returns one row per user with a list of products that remain. |
| **2. Rules and scoring** | n8n Code node | Scores each pair 0–100: half from how far the CIBIL score is above the minimum, half from how far income is above the minimum. **Below 25 is rejected.** Otherwise the pair is accepted, unless it has a doubt a rule can't settle: the loan would run past the maximum age, a young self-employed applicant with a lender that wants years in business, or estimated rules with a score under 50. Those become **borderline**. |
| **3. AI, borderline only** | Gemini | Similar users are grouped (income band × CIBIL band × job type × age band), so thousands of pairs become a few hundred questions. Answers are saved in a cache, so repeat questions are free. The rest go **40 per call**, with at most `LLM_MAX_CALLS` (20) calls. Anything over the limit, or in a failed call, uses a score rule (accept at 50 or more). |
| **4. Save** | PostgreSQL | One statement stores all matches, new cache entries and the funnel numbers (in `match_runs`, which the upload page reads). |

**Why these thresholds?** The first design was accept at 70+, reject below 30, borderline in between. But every pair that reaches Stage 2 already passed the hard minimums, so a wide middle band would send lots of clearly-fine pairs to the AI. With the thresholds above, the rules settle about 93% of pairs that survive the SQL filter (44,729 of 48,011 on AWS), and the AI only sees the genuinely unclear ones.

**Measured on AWS** (10,000 users). The *re-run* uploads the same file again: everyone is re-checked, but every question comes from the cache.

| | First run | Re-run |
|---|---:|---:|
| Active products | 14 | 14 |
| All user × product pairs | 140,000 | 140,000 |
| After SQL filter | 48,011 | 48,011 |
| Accepted by rules | 44,718 | 44,718 |
| Rejected by rules | 11 | 11 |
| Borderline pairs | 3,282 | 3,282 |
| Unique questions | 168 | 168 |
| Answered from cache | 0 | 168 |
| **Gemini calls** | **5** | **0** |
| Accepted by the AI | 2,546 | 2,546 (cache) |
| Matches stored | 47,264 | 47,264 |
| Time (Workflow B) | 34.5 s | 8.8 s |

Measured on 2026-10-07/08 with `gemini-3.5-flash-lite`. Loading the 10,000 rows on Lambda took 1.8 s. Each run emailed 5 users (`NOTIFY_MAX_EMAILS=5`).

**Measured locally** (dev database, same users, 21 products): 210,000 pairs → 92,973 after the SQL filter → 86,106 accepted, 11 rejected, 6,856 borderline → 321 questions → **9 Gemini calls** → 91,687 matches in 61 s (mostly the 7 s pause between Gemini calls). Re-running used the cache: 0 calls, 2.6 s. The product count differs from AWS (21 vs 14) because each run did its own crawl, and Gemini's reading of the BankBazaar page varies a little between crawls.

A naive design would make one AI call per pair, which is hundreds of thousands of calls. This one makes at most 20, and usually none on re-runs.

### Emails (Workflow C)
C finds users with un-emailed matches and picks each user's **top 5** products (by score, then lowest rate) with an "…and N more" line. It emails at most `NOTIFY_MAX_EMAILS` users (default 5, never above 200, since the SES sandbox allows 200 a day). Emails go **only to `TEST_INBOX_ALIASES`**, in rotation. The user's CSV address appears only in the footer. Emails are sent one at a time with a 1 s pause, and each result is logged in `notifications`. A failed send leaves the matches pending so it can be retried. Delivery is at-least-once: if SES accepts an email but logging fails, a retry could send it twice.

## Testing

```bash
docker compose -f n8n/docker-compose.yml --profile dev up -d dev-db   # throwaway PostgreSQL on :55432
.venv/bin/pytest backend/tests          # ingestion, handlers, idempotency, Excel BOM / non-UTF-8 files
npm run test:n8n                        # n8n logic + its SQL on PostgreSQL + bundle freshness
python3 scripts/build-workflows.py --check                                # workflow JSON matches the code
.venv/bin/python scripts/e2e_upload.py "$API_URL" sample-data/users.csv   # full test on the deployed stack
```

DB tests use the `loan_engine_test` database (override with `TEST_DATABASE_URL`). The test helpers refuse to wipe any database whose name doesn't end in `_test`.

## Cost

Built to stay at or near $0: no NAT Gateway, RDS `db.t4g.micro` with 20 GB and no backups, small Lambdas, logs and uploads kept 7 days, and Gemini on the free tier with a call limit. RDS is the only real hourly cost, so `scripts/pause.sh` stops it between demos. Run `scripts/teardown.sh` when you're done.

## Limitations and next steps
* For files with millions of rows, split the file into chunks and process them in parallel with SQS.
* Replace the quick tunnel with a named Cloudflare tunnel, or run n8n on a small cloud server, so nothing depends on the laptop.
* Verify a sending domain in SES (DKIM) so emails reach the inbox, then request SES production access and add an unsubscribe link.
* Read the DB password from SSM at runtime (or use IAM database login) and use a limited database user instead of the master user.

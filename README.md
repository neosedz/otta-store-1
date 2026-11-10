# Otta store

An online store on Cloudflare Workers: [EmDash](https://github.com/emdash-cms/emdash) for
content and [Otta](https://github.com/UrumiAI/otta.sh) for commerce (catalog, stock, cart,
checkout, orders, card payments with Stripe, cash on delivery). It runs as one Worker with
one D1 database.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/UrumiAI/otta-store-template)

This repository holds no store code. The store is the `@urumi.ai/otta-store` package, so an
update is a version bump, not a merge.

## Before you click

- **Workers Free: deploy with the button.** A new store's database needs 90 migrations (about
  590 statements). The deploy applies them from the build, before the Worker goes live, using
  the Cloudflare API token Workers Builds gives the build. In one real build that token could
  change D1 without any setup; if yours cannot, the build stops and says how to fix it (see
  "If the deploy or the first visit fails").
  What has been shown, and what has not: on a real Workers Free account a first start inside
  the Worker was cut off after 34 of 90 migrations and left that store stuck; the remaining 56
  were then applied by hand with `emdash migrate` and the store started. Separately, this
  template's script applied all 90 to a scratch D1 database from a local build, on a free
  account. The complete button flow with this script has not yet been run end to end on Workers
  Free. Do not deploy a new store with plain `wrangler deploy`: the Worker would set up the
  database itself and be cut off. The store's default collections and settings (up to 54
  more statements) are still set up on the first request; that step finished on Workers Free in
  the manual recovery above.
- **R2 needs a payment method on your Cloudflare account.** The free allowance still applies;
  the store's two buckets are created during deploy.
- **Have an encryption key ready.** The button asks for `EMDASH_ENCRYPTION_KEY`. Make one with
  `npx emdash secrets generate`, or, without Node:
  `printf 'emdash_enc_v1_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"`.
  **Keep a copy in your password manager.** It encrypts the payment keys you enter in the
  admin; if it is lost, they have to be entered again. If you leave it blank the store starts,
  but the admin refuses payment keys and says: "EMDASH_ENCRYPTION_KEY is not set, so keys
  entered under Payments & email are refused."
- **A second store in the same Cloudflare account:** give each resource the deploy page
  offers its own name. Then change both rate-limit ids in `wrangler.jsonc` in your new
  repository.
  Each store uses one cron trigger, and Workers Free allows 5 per account.

## What the button creates

A copy of this repository in your GitHub account, and on Cloudflare:

| Binding | What | Notes |
|---|---|---|
| `DB` | D1 database | Your content and every order, cart and customer. |
| `MEDIA` | R2 bucket | Product images. Served publicly. |
| `DOWNLOADS` | R2 bucket | Files buyers pay for. **Keep it private**: never turn on its r2.dev URL or connect a domain to it. It must be a different bucket from `MEDIA` (the build refuses one shared bucket). |
| `SESSION` | KV namespace | Admin sign-in sessions. |
| `IMAGES` | Images | Resizes product photos. |
| `RATE_LIMIT_AUTH`, `RATE_LIMIT_WRITES` | Rate limits | Per-visitor limits on sign-in and on cart and checkout writes. Cash on delivery is only offered with `RATE_LIMIT_WRITES`. Their `namespace_id`s (`1001`, `1002`) are set in `wrangler.jsonc`, and Workers in one Cloudflare account that use the same ids **share the counters**: give a second store in the same account its own ids. |

It also sets up **Workers Builds**: every push to your production branch runs `npm run build`
and `npm run deploy`. The deploy step (`scripts/deploy.mjs`) applies any new database migrations
and then deploys the Worker, so a new store is never live on an unmigrated database.

## After deploying

### 1. Turn off non-production branch builds

**Do this first.** Workers Builds also builds other branches, such as the weekly update
branch. Depending on how your Worker is set up, that build creates a Cloudflare Preview or
uploads a version with a Version URL. A Preview does not inherit your production bindings
unless they are declared for it, and this template declares no database or buckets for it. A Version URL runs the
uploaded version on your **production resources, including the live database**, so opening it
could run that version's database changes against your live data. We have not confirmed which
of the two your Worker gets, so turn the builds off. `wrangler.jsonc` already sets
`"preview_urls": false`, which disables Version URLs. In the Cloudflare dashboard: your Worker
→ **Settings** → **Build** → **Branch control** → clear **Enable Preview Builds**.

### 2. Claim your store

Until you claim it, the admin is locked for everyone. Claim it promptly: until then, anyone who
can read your Worker's logs can use the setup link, and the link does not expire. Use either
route:

- **From the logs.** In the dashboard, open your Worker → **Logs**. Visit
  `https://<your-worker>.<your-subdomain>.workers.dev/_emdash/admin` once, then search the
  logs for `[otta-setup]`. That line holds your setup link. Open it.
- **With your own token.** Add a secret named `OTTA_SETUP_TOKEN` (Worker → **Settings** → **Variables and Secrets**) of at least 32
  random characters (`A-Z a-z 0-9 - _`; `openssl rand -hex 32` makes one). It replaces the
  generated token, so a link already in the logs stops working. Then open
  `https://<your-site>/_emdash/admin/setup?setup_token=<your token>`. If you add it before the
  first visit, no link is written to the logs.

The link opens the setup wizard. Choose **Sample content** for three demo products, then
create your account and its passkey. After that, the link stops working and you sign in with
the passkey.

### 3. Take payments

In the admin, open **Store settings**:

- **Cards (Stripe):** first, in the Stripe Dashboard, add a webhook endpoint for
  `https://<your-site>/webhooks/stripe` and subscribe it to exactly two events:
  `payment_intent.succeeded` and `payment_intent.payment_failed`. Then enter your Stripe
  publishable key, secret key and the endpoint's signing secret (`whsec_…`) under Payments.
  Card checkout needs both the secret key and the signing secret. The admin does not show the
  URL or the events, so keep this note.
- **Cash on delivery:** turn on "Offer cash on delivery at checkout". It is offered for
  physical products, with the buyer's address and phone.

The demo products have no price until you give them one: open each product and fill in its
**Pricing & stock** cards.

### 4. Email (optional, Workers Paid)

Order and sign-in emails can go through Cloudflare Email Sending, which needs Workers Paid and
a sender domain on Cloudflare. In this order:

1. Onboard the domain for Email Sending and send a test email.
2. Uncomment `"send_email": [{ "name": "EMAIL" }]` in `wrangler.jsonc`.
3. Set the sender: `emailFrom: "store@mail.example.com"` in `astro.config.mjs`, or a build
   variable `OTTA_EMAIL_FROM` (Worker → Settings → Build → Variables). Push.

The build refuses a sender without the binding.

## Updates

Once a week Dependabot opens one pull request for Otta's packages (`@urumi.ai/*`), and a
separate one when Wrangler has an update. **Merging it deploys the update.** If the build
fails, no new Worker is deployed and the store keeps running the version before, though
migrations the build already applied stay applied (see "If the deploy or the first visit
fails"); the build log says why.

Two kinds of Otta release need more than merging:

- **A release that moves EmDash, Astro or React.** Otta declares the exact versions it works
  with, and Dependabot never touches them (a different one would install a second copy of
  EmDash). So this kind of release does **not** arrive as a working pull request: Dependabot
  holds back Otta's update, or its build stops at `npm install` with an `ERESOLVE` error,
  before Otta's own checks run. You hear about it from Otta's release notes or announcement.
  Then follow [UPGRADING.md](https://github.com/UrumiAI/otta.sh/blob/main/UPGRADING.md):
  change the pinned versions in `package.json` by hand, together with Otta's, and push.
- **A release that needs a change to this repository's other files** (a new binding in
  `wrangler.jsonc`, say). Its build fails with
  `@urumi.ai/otta-store <version> needs template contract <n> …`. Make the changes that
  section of UPGRADING.md lists, set `otta({ template: <n> })` in `astro.config.mjs`, and
  push.

## If the deploy or the first visit fails

The deploy sets up the database before the Worker goes live, so a problem usually shows up in
the build, not on the store. Open the failed build in your Worker's build history in the
Cloudflare dashboard. Its log ends with `Deploy stopped.` and what to do.

What a failed build has done depends on where it stopped. No new Worker is deployed, so a new
store stays offline and a running store keeps its current version. But if it stopped after
applying migrations, those stay applied: **deploying older code does not undo a migration**.

- "Another run took the database's migration lock": a build is running or one was cut off.
  Wait until the lock is 25 minutes old, then run the build again. A database with nothing
  applied yet is taken over automatically. On a store with applied migrations the build stops
  and shows a build variable to add: `OTTA_TAKE_OVER_LOCK=<lock id>`. Before adding it, check
  that no build or migration job is running for this store. Remove it afterwards.
- "Applying the database migrations failed": read the state line above it (applied, pending,
  lock). The build says which of these applies:
  - **"No migration completed"** after a clear error: retry the build. If it fails the same way
    again, see "A new store with no orders" below.
  - **Any migrations applied, or an ambiguous write** (even with none applied): **do not push,
    merge an update pull request, or retry the build in the dashboard** until someone has
    looked at it, because the failed migration may be partly applied and running it again can
    make that worse. Nothing prevents a later push from running it again, so hold off on all
    three. Get help. A brand-new store with no orders can use "A new store with no orders" below.
  - **`079_datetime_normalization` is next**: EmDash documents this as safe to run again after
    an ambiguous write, so the build says to retry; if it asks for manual review, correct the
    listed values first.
  - **"did not get the migration lock"**: another run held it, and this run applied nothing.
    Wait as described above, then run the build again.
- "permission denied" or a message about `D1 Edit`: the build's API token cannot change D1.
  Your Worker → **Settings** → **Build** shows which token the build uses. Edit that token
  (**Manage Account** → **Account API Tokens**, or **My Profile** → **API Tokens**), add
  **Account** → **D1** → **Edit**, save, and retry the build.
- "has no real database_id": the id in `wrangler.jsonc` is still the template's placeholder.
  Create the D1 database, put its id there and push.
- A message naming `CLOUDFLARE_ACCOUNT_ID`: add a build variable with that name holding your
  Cloudflare account id (Worker → **Settings** → **Build** → **Variables**), then retry.
- A pending migration that "must not run while older code serves traffic": follow the
  maintenance-window steps in
  [UPGRADING.md](https://github.com/UrumiAI/otta.sh/blob/main/UPGRADING.md).

### A new store with no orders

If a new store has no data worth keeping, the simplest recovery from a failed setup is to start
the database again: delete its D1 database, create a new one, put the new `database_id` in
`wrangler.jsonc` in your repository and push; the build sets it up again. Once the store holds
orders, do not delete anything: get help first. We have not tested this recovery on a Cloudflare
account.

### Restoring the database or the code

On a store with applied migrations, the build log records a D1 Time Travel bookmark and commit
before changing anything. **Use the bookmark from the first failed build:** a bookmark logged by
a later build was taken after the partial changes. To put the database back (Time Travel keeps
7 days on Workers Free, 30 on Paid):

```bash
npx wrangler d1 time-travel restore <database name> --bookmark=<bookmark from the log>
```

A restore removes everything written since that point. **Then check Stripe for payments made
since the bookmark:** a payment for an order the restore removed is acknowledged as
`ORDER_NOT_FOUND` and is not refunded automatically, so refund it from the Stripe dashboard.

To put the code back, use your Worker → **Deployments** in the dashboard and roll back. That
restores the previous Worker only. It does not reverse a migration; the database stays as it is
unless you restore it too.

### If the build succeeded but the first visit fails

The page usually says only "Database migrations are required. Apply the deployment migration
manifest and retry." or "This site's database has not been migrated yet". The specific reason
is in your Worker's **Logs**; look there for one of these:

- "Database initialization is backing off after a recent migration failure": the store tries
  again after about 30 seconds.
- "The migration lock has been held since …": the Worker started migrating itself and was cut
  off. Stores made before this template applied migrations in the build are the usual case.
  Such a store has no `scripts/deploy.mjs`, so first copy that file from this repository
  and the `"deploy": "node scripts/deploy.mjs"` line from its `package.json` into your repository.
  Then confirm your Worker → **Settings** → **Build** → **Deploy command** is `npm run deploy`,
  and push. The build then follows the lock steps above; the migration that was running when the
  Worker was cut off may be partly applied.
- **If it keeps failing:** see "A new store with no orders" above. Once the store holds orders,
  get help first.

## Adding your own code

You can add files under `src/`, but one is risky. **A `src/middleware.ts` of your own runs
before Otta's.** Otta's middleware holds the store's cross-site request check and, until the
store is claimed, the setup-link gate on the admin. If yours answers a request itself instead
of calling `next()`, those checks never run for it. Always call `next()` for paths you do not
own, and never answer `/_emdash/*` or the cart, checkout and account routes yourself.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in EMDASH_ENCRYPTION_KEY
npm run dev
```

Deploying from your own machine runs the same script, and needs an API token with D1 Edit in
`CLOUDFLARE_API_TOKEN` (`npm run build`, then `CLOUDFLARE_API_TOKEN=<token> npm run deploy`).
Add `-- --migrate-only` to apply migrations without deploying. The script takes the account id
from `account_id` in `wrangler.jsonc`, then `CLOUDFLARE_ACCOUNT_ID`, then the only account the
token can see, or, if it can see several, the one that holds this database. Workers Builds has
not been confirmed to provide the account id on a real build yet; the first lines of the build
log say whether `CLOUDFLARE_ACCOUNT_ID` was present.

## Files

| File | |
|---|---|
| `astro.config.mjs` | The Cloudflare adapter and `otta({ template: 1 })`. Your build options go here. |
| `wrangler.jsonc` | The Worker, its bindings, the cron and logging. |
| `.dev.vars.example` | The secret the button asks for. |
| `src/worker.ts`, `src/live.config.ts` | Wiring Cloudflare and Astro need to find in your repository. |
| `scripts/deploy.mjs` | `npm run deploy`: applies database migrations, then runs `wrangler deploy`. |
| `scripts/deploy.test.mjs` | `npm test`: tests that script against fake `emdash` and `wrangler` tools. It does not touch Cloudflare. |
| `.github/dependabot.yml` | The weekly update of Otta's packages and Wrangler. |

MIT licensed.

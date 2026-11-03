// A made-up project's notes and conversations, with a question for each.
//   exact     the question names something only that fact contains, like an error code
//   partial   the question shares some words with the fact
//   reworded  the question shares no searchable word with the fact, which bench/memory.ts checks
export type QueryClass = "exact" | "partial" | "reworded";

export interface Fact {
  id: number;
  /** a note, or a saved conversation when it's written as turns */
  text: string;
  question: string;
  queryClass: QueryClass;
  /** only on the questions the end-to-end run asks */
  answer?: RegExp;
}

export const FACTS: Fact[] = [
  { id: 1, queryClass: "exact", text: "The flaky test is checkout_retry_spec. It fails when TZ isn't UTC, so CI pins TZ=UTC.", question: "What's going on with checkout_retry_spec?" },
  { id: 2, queryClass: "exact", text: "user: the deploy died with ERR_LAYER_4471\nassistant: That happens when the builder image is older than the base image. Rebuilding builder-base fixed it.", question: "How did we fix ERR_LAYER_4471?", answer: /builder/i },
  { id: 3, queryClass: "exact", text: "FEATURE_LEDGER_V2 stays off in production until the backfill of old invoices finishes.", question: "Is FEATURE_LEDGER_V2 enabled in production?" },
  { id: 4, queryClass: "exact", text: "--no-parallel-sync is needed on the mirror job because the vendor's API rejects concurrent pulls.", question: "Why does the mirror job pass --no-parallel-sync?" },
  { id: 5, queryClass: "exact", text: "Use libvips 8.15.2 exactly. Version 8.16 breaks the thumbnailer with corrupt WebP output.", question: "Which libvips version can we use?" },
  { id: 6, queryClass: "exact", text: "user: what is orders_archive_2023 for?\nassistant: A read-only copy kept for the tax audit. Don't drop it before March 2028.", question: "When can orders_archive_2023 be dropped?", answer: /2028/ },
  { id: 7, queryClass: "exact", text: "The webhook signing header is X-Tally-Sig, and its secret rotates every 90 days.", question: "How often does the X-Tally-Sig secret change?" },
  { id: 8, queryClass: "exact", text: "pg_repack has to run with --wait-timeout=30 or it blocks the billing writers.", question: "What timeout should pg_repack use?" },
  { id: 9, queryClass: "exact", text: "make seed-demo loads 200 fake tenants. make seed-min loads 3 and is what the e2e tests use.", question: "What does make seed-min do?" },
  { id: 10, queryClass: "exact", text: "user: grafana panel 412 looks wrong\nassistant: Panel 412 double counts retries. Divide by the retry factor until the dashboard is rebuilt.", question: "Why is grafana panel 412 wrong?" },
  { id: 11, queryClass: "exact", text: "AWS_S3_ENDPOINT must point at minio locally, or boto talks to the real bucket.", question: "What should AWS_S3_ENDPOINT be set to locally?" },
  { id: 12, queryClass: "exact", text: "useCartSync has to be called above the router, or the guest cart is lost on redirect.", question: "Where does useCartSync need to be called?" },
  { id: 13, queryClass: "exact", text: "The Terraform module vpc_peer_eu is pinned to v3.2, as v4 recreates the route tables.", question: "Why is vpc_peer_eu pinned?" },
  { id: 14, queryClass: "exact", text: "Sentry issue AUTH-2291 is a known race in token refresh, safe to ignore until the auth rewrite.", question: "Is AUTH-2291 safe to ignore?" },
  { id: 15, queryClass: "exact", text: "user: nightly_rollup timed out again\nassistant: It needs the large runner. It runs out of memory on the default one at about 6 GB.", question: "What runner does nightly_rollup need?" },

  { id: 16, queryClass: "partial", text: "We chose Postgres over DynamoDB because reporting needs ad hoc joins.", question: "Why did we pick Postgres?" },
  { id: 17, queryClass: "partial", text: "user: should we keep using Jest?\nassistant: We're moving to Vitest, because the ESM transforms in Jest add about four minutes to CI.", question: "Why are we leaving Jest?" },
  { id: 18, queryClass: "partial", text: "Customer uploads over 25 MB go to the slow queue so they can't starve normal uploads.", question: "Where do large customer uploads go?" },
  { id: 19, queryClass: "partial", text: "The release freeze starts on the second Thursday of each month at noon UTC.", question: "When does the release freeze begin?", answer: /second Thursday/i },
  { id: 20, queryClass: "partial", text: "The mobile app still calls the v1 search endpoint, so it can't go until the iOS 14 users are gone.", question: "Can we remove the v1 search endpoint?" },
  { id: 21, queryClass: "partial", text: "user: who owns the payments service now?\nassistant: Priya's team took it over in June. Marco only handles the reconciliation job.", question: "Who is responsible for payments?", answer: /Priya/ },
  { id: 22, queryClass: "partial", text: "Staging emails go to a catch-all mailbox, never to real customers.", question: "Do staging emails reach customers?" },
  { id: 23, queryClass: "partial", text: "Rate limiting is per API key, not per IP, since most clients sit behind one NAT gateway.", question: "Is the rate limit based on IP address?" },
  { id: 24, queryClass: "partial", text: "Images are served from the CDN only after a 10 minute delay because of purge lag.", question: "How long before images appear on the CDN?", answer: /10[ -]?min/i },
  { id: 25, queryClass: "partial", text: "user: the search index is stale again\nassistant: The job only runs at 03:00. After a bulk import, run it by hand with the admin button.", question: "When does the search index get rebuilt?" },
  { id: 26, queryClass: "partial", text: "Dark mode colours come from the design tokens repo. Don't hardcode them in components.", question: "Where should dark mode colours be defined?" },
  { id: 27, queryClass: "partial", text: "Refunds over 500 euros need a second approver in the admin panel.", question: "Who has to approve large refunds?" },
  { id: 28, queryClass: "partial", text: "The analytics database is a replica and lags up to 15 minutes behind the primary.", question: "How far behind is the analytics replica?" },
  { id: 29, queryClass: "partial", text: "We don't support Safari older than 16, because it lacks CSS container queries.", question: "What is the oldest Safari we support?" },
  { id: 30, queryClass: "partial", text: "user: can I delete the legacy cron box?\nassistant: Not yet. It still sends the monthly invoices, so move that job first.", question: "Is it safe to delete the legacy cron box?" },

  { id: 31, queryClass: "reworded", text: "Postgres connections are capped at 40 per pod since PgBouncer was removed.", question: "What limit applies to database sessions from each container?", answer: /\b40\b/ },
  { id: 32, queryClass: "reworded", text: "Never force-push to main. A hook blocks it and pages whoever is on call.", question: "What occurs if someone overwrites the primary branch history?" },
  { id: 33, queryClass: "reworded", text: "The login page redirect loop came from a cookie set with SameSite=Strict.", question: "What caused users to bounce endlessly when signing in?", answer: /SameSite/i },
  { id: 34, queryClass: "reworded", text: "user: builds got way slower\nassistant: Docker layer caching broke after we changed the runner image. Restoring the cache key brought it back to six minutes.", question: "Why did compiling take so long recently, and what repaired it?" },
  { id: 35, queryClass: "reworded", text: "Invoices are generated in the customer's time zone, not UTC.", question: "Which clock do billing documents follow?" },
  { id: 36, queryClass: "reworded", text: "The team prefers small pull requests, under 300 changed lines.", question: "How big should a code review submission be?" },
  { id: 37, queryClass: "reworded", text: "Feature flags older than six months get deleted during the quarterly cleanup.", question: "When do we retire stale toggles?" },
  { id: 38, queryClass: "reworded", text: "user: memory keeps climbing on the worker\nassistant: It's a leak in the PDF renderer. As a workaround we restart the process every 200 jobs.", question: "How are we coping with the background processor's growing RAM usage?", answer: /\b200\b/ },
  { id: 39, queryClass: "reworded", text: "Use pnpm, not npm. The lockfile is pnpm-lock.yaml, and CI fails if package-lock.json appears.", question: "Which JavaScript dependency installer does this repository expect?" },
  { id: 40, queryClass: "reworded", text: "Passwords are hashed using argon2id with a 64 MB memory cost.", question: "How do we protect stored credentials?" },
  { id: 41, queryClass: "reworded", text: "Deployments happen only on weekdays before 3pm, so someone is around to roll back.", question: "What hours are allowed for shipping to production?" },
  { id: 42, queryClass: "reworded", text: "The French translation is maintained by an external agency, so don't edit fr.json by hand.", question: "Who looks after the localized strings for France?" },
  { id: 43, queryClass: "reworded", text: "user: the mobile build is failing on certificates\nassistant: The Apple signing certificate expires every January. Renew it through the shared developer account.", question: "What recurring yearly chore keeps iPhone releases working?" },
  { id: 44, queryClass: "reworded", text: "Logs are kept for 30 days, then moved to cold storage for a year.", question: "What's our retention policy for diagnostic output?" },
  { id: 45, queryClass: "reworded", text: "Customer data must stay in the Frankfurt region because of the contract with Helvetia Bank.", question: "Where are we obliged to host client records, and why?" },
];

/** Same subjects with different details, so that being on topic isn't enough. */
export const NEAR_MISSES = [
  "The test database allows 200 connections because it runs on one big shared instance.",
  "We used yarn in the old monorepo before the split.",
  "The admin panel's logout button sent people to the wrong page in last year's redesign.",
  "Receipts for in-person sales print with the store's local time.",
  "API tokens are hashed with SHA-256, since they're already random.",
  "Access logs from the CDN are deleted after seven days.",
  "Marketing emails go out on Tuesdays through the external agency.",
  "Hotfixes can ship outside the normal window with a manager's sign-off.",
  "Backups are stored in the Dublin region.",
  "The Android signing key lives in the shared vault and never expires.",
  "Bulk imports run in a separate worker so they don't slow down checkout.",
  "Documentation pull requests don't need a review.",
  "Experiment flags are reviewed by the growth team each week.",
  "The web build cache is stored in S3 and is safe to delete.",
  "Worker concurrency is set to 8 per pod.",
];

/** An identifier one step from each exact question's, which is where embeddings are expected to struggle. */
export const LOOKALIKES = [
  "checkout_retries_spec was deleted when the old payment flow went away.",
  "ERR_LAYER_4417 on deploy means the registry ran out of disk. Clearing old tags fixed it.",
  "FEATURE_LEDGER_V3 is enabled in production for all tenants since the pilot ended.",
  "--no-parallel-fetch is needed on the backup job because the disk can't keep up.",
  "libvips 8.14 is what the old image host still runs, so leave it alone.",
  "orders_archive_2022 can be dropped any time, as nothing reads from it.",
  "The webhook header X-Tally-Id holds the delivery id and never changes.",
  "pg_dump has to run with --lock-wait-timeout=120 on the billing replica.",
  "make seed-max loads 5000 tenants and takes about an hour.",
  "Grafana panel 421 reads straight from the billing table and is correct.",
  "AWS_S3_REGION must be eu-west-1 locally or presigned URLs fail.",
  "useCartMerge has to be called after login so the guest cart merges with the saved one.",
  "The Terraform module vpc_peer_us is pinned to v2.9 because of an old provider bug.",
  "Sentry issue AUTH-2219 is a real bug in session expiry and needs fixing before the next release.",
  "nightly_rollup_eu runs on the default runner and finishes in ten minutes.",
];

/** Nothing in the corpus answers these, so the right response is to say so. */
export const UNANSWERABLE = ["How long is the on-call rotation?", "Which message broker did we settle on?"];

/** Told in one session and asked in the next, to see whether the model saves it by itself. */
export const ROUND_TRIPS = [
  { tell: "Please remember for future sessions: hotfix branches here are prefixed maint-7.4/.", ask: "What prefix do hotfix branches use in this project?", answer: /maint-7\.4/ },
  { tell: "From now on, commit messages in this project must stay under 50 characters. Keep that in mind for later sessions.", ask: "How long can commit messages be in this project?", answer: /\b50\b/ },
  { tell: "Note for later: QA sign-off comes from Ingrid, not Tom.", ask: "Who gives QA sign-off here?", answer: /Ingrid/ },
];

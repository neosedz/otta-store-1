#!/usr/bin/env node
// `npm run deploy`: apply the store's database migrations from the build, then
// run `wrangler deploy`. `npm run deploy -- --migrate-only` stops before the
// deploy (for support and for testing against a scratch database).
//
// Why here and not in the Worker: a new database needs 90 migrations, and a
// Worker on the Free plan is cut off long before it finishes one first start
// (seen: 34 of 90, then a 503 forever because the cut-off run never released
// its lock). Migrations started from a build have no such limit.
//
// Order: migrate, check, deploy.
// - A first deploy never leaves a Worker in front of an unmigrated database,
//   because deploy only runs after the check passes.
// - On later pushes the Worker still running is unaffected: it counts applied
//   migrations and, seeing at least as many as it knows, skips migrating. If
//   the Worker were deployed first it would apply them itself, in the same
//   limits this script exists to avoid, on a store with real orders.
// - EmDash's docs order this as migrate, deploy, check; this script checks
//   before deploying so a failed check can stop the deploy. EmDash writes core
//   migrations to tolerate old and new code during a deploy, with documented
//   exceptions (MAINTENANCE_WINDOW below).
//
// Uses only Node built-ins and the `emdash` and `wrangler` that `npm run` puts
// on PATH. Secrets stay in the environment, never in arguments. Output from
// `emdash` and `wrangler whoami` is scrubbed of them before it reaches the
// build log; `wrangler deploy` writes straight to the log, exactly as it did
// before this script existed, and is not scrubbed.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = "wrangler.jsonc";
const MANIFEST = join(root, ".emdash", "migrations.json");
const API = "https://api.cloudflare.com/client/v4";
// A held lock younger than this may belong to a run that is still working.
// Workers Builds stops a build after 20 minutes and EmDash's lock has no
// heartbeat, so a lock older than this cannot belong to a live build.
const LOCK_TAKEOVER_AGE_MS = 25 * 60 * 1000;
const LOCK_RECHECK_MS = 60 * 1000;
// EmDash migrations that must not run from a pre-deploy job while older code
// serves traffic. A brand new database has no such traffic.
const MAINTENANCE_WINDOW = new Set(["095_plugin_storage_unique_scope"]);
// EmDash documents re-running this migration as safe after an ambiguous write.
const RESUMABLE_MIGRATION = "079_datetime_normalization";
// EmDash's messages when a run never obtained the lock.
const LOCK_NOT_OBTAINED =
	/migration lock has been held since|Timed out waiting for another instance's migrations|migration lock has a different id|migration lock is not held/i;
const NO_DATA_RECOVERY = "A new store with no orders";
const UPGRADING = "https://github.com/UrumiAI/otta.sh/blob/main/UPGRADING.md";
const HELP = "https://github.com/UrumiAI/otta.sh/issues";
const NOTHING_CHANGED =
	"This build changed nothing: no migrations ran and no Worker was deployed. A new store stays offline, and a running store keeps its current version.";
const NOT_UNDONE =
	"No new Worker was deployed: a running store keeps its current version, against this database. Migrations already applied stay applied; deploying older code does not undo them.";
const RETRY = "Retry the build from your Worker's build history in the Cloudflare dashboard, or push a new commit.";
const D1_EDIT_STEPS =
	"The build's API token needs the D1 Edit permission. In the Cloudflare dashboard, your Worker > Settings > Build shows which API token the build uses. Open Manage Account > Account API Tokens (or My Profile > API Tokens), edit that token, add the permission Account > D1 > Edit, and save. Then retry the build.";

class Stop extends Error {}

const log = (message) => console.log(`[otta-deploy] ${message}`);
const stop = (...lines) => {
	throw new Stop(lines.join("\n"));
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Every environment value that looks like a credential, longest first, so a
// value that contains another is replaced whole.
const secrets = Object.entries(process.env)
	.filter(([name, value]) => /token|secret|key|password|credential/i.test(name) && value?.length >= 8)
	.map(([, value]) => value)
	.sort((a, b) => b.length - a.length);

function scrub(text) {
	let clean = text;
	for (const secret of secrets) clean = clean.replaceAll(secret, "[redacted]");
	return clean;
}

// Runs a tool without a terminal. stderr is forwarded line by line, scrubbed,
// and returned; stdout is returned and never printed as it arrives.
function run(command, args) {
	return new Promise((done) => {
		const child = spawn(command, args, {
			cwd: root,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		let stdout = "";
		let stderr = "";
		let partial = "";
		const forward = (line) => {
			const clean = scrub(line);
			stderr += `${clean}\n`;
			console.error(clean);
		};
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			const lines = (partial + chunk).split("\n");
			partial = lines.pop();
			lines.forEach(forward);
		});
		child.on("error", (error) => {
			forward(`Could not start ${command}: ${error.message}`);
			done({ code: 127, stdout: "", stderr });
		});
		child.on("close", (code) => {
			if (partial) forward(partial);
			done({ code: code ?? 1, stdout, stderr });
		});
	});
}

function parseJson(stdout) {
	try {
		return JSON.parse(stdout.slice(stdout.indexOf("{")));
	} catch {
		return undefined;
	}
}

// wrangler.jsonc allows comments and trailing commas; JSON.parse does not.
function parseJsonc(source) {
	let out = "";
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '"') {
			const start = i;
			for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
			out += source.slice(start, i + 1);
		} else if (char === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && source[i + 1] === "*") {
			i = source.indexOf("*/", i + 2) + 1;
			if (i === 0) i = source.length;
		} else {
			out += char;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readConfig(binding) {
	let config;
	try {
		config = parseJsonc(readFileSync(join(root, WRANGLER_CONFIG), "utf8"));
	} catch {
		stop(`${WRANGLER_CONFIG} could not be read. Fix the file and push again.`, NOTHING_CHANGED);
	}
	const database = (config.d1_databases ?? []).find((entry) => entry.binding === binding);
	const id = database?.database_id;
	const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{12}$|^f{8}-f{4}-f{4}-f{4}-f{12}$/i;
	const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
	if (typeof id !== "string" || !uuid.test(id) || placeholder.test(id)) {
		stop(
			`The "${binding}" database in ${WRANGLER_CONFIG} has no real database_id (found: ${id ?? "none"}; a placeholder or missing id).`,
			"The Deploy to Cloudflare button normally writes the real id into your copy of this file.",
			`Create the D1 database in the Cloudflare dashboard, put its database_id in ${WRANGLER_CONFIG}, and push.`,
			NOTHING_CHANGED,
		);
	}
	return { config, databaseId: id, databaseName: database.database_name };
}

async function cloudflareGet(path) {
	return fetch(`${API}${path}`, {
		headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
		signal: AbortSignal.timeout(15_000),
	});
}

async function databaseAnswersIn(accountId, databaseId) {
	try {
		const response = await cloudflareGet(`/accounts/${accountId}/d1/database/${databaseId}`);
		return response.status === 200;
	} catch {
		return false;
	}
}

async function resolveAccountId(config, databaseId) {
	const valid = /^[a-f0-9]{32}$/i;
	const fix =
		"Add a build variable named CLOUDFLARE_ACCOUNT_ID, set to your Cloudflare account id: open your Worker > Settings > Build > Variables, add the variable, then retry. Your account id is in the dashboard URL (dash.cloudflare.com/<account id>).";
	const named = [
		["wrangler.jsonc", config.account_id],
		["the environment", process.env.CLOUDFLARE_ACCOUNT_ID],
	];
	for (const [source, candidate] of named) {
		if (candidate) {
			if (!valid.test(candidate)) {
				stop(`The Cloudflare account id from ${source} is not a 32-character id.`, fix, NOTHING_CHANGED);
			}
			log(`Account id from ${source}.`);
			return candidate;
		}
	}
	const { code, stdout } = await run("wrangler", ["whoami", "--json"]);
	const accounts = code === 0 ? parseJson(stdout)?.accounts : undefined;
	if (!Array.isArray(accounts) || accounts.length === 0) {
		stop("Could not work out which Cloudflare account this store belongs to.", fix, NOTHING_CHANGED);
	}
	if (accounts.length === 1) {
		if (!valid.test(accounts[0]?.id ?? "")) stop("Cloudflare returned an unexpected account id.", fix, NOTHING_CHANGED);
		log("Account id from wrangler whoami (one account visible).");
		return accounts[0].id;
	}
	const matches = [];
	for (const { id } of accounts) {
		if (valid.test(id ?? "") && (await databaseAnswersIn(id, databaseId))) matches.push(id);
	}
	if (matches.length !== 1) {
		stop(
			`This token can see ${accounts.length} Cloudflare accounts, and the database answered in ${matches.length} of them, so this script will not guess.`,
			fix,
			NOTHING_CHANGED,
		);
	}
	log(`Account id found by looking the database up across ${accounts.length} visible accounts.`);
	return matches[0];
}

async function emdashReport(args) {
	const { code, stdout, stderr } = await run("emdash", ["migrate", ...args]);
	return { code, report: parseJson(stdout), stdout, stderr };
}

const isPermissionError = (text) => /HTTP status 40[13]|not authori[sz]ed|authentication error/i.test(text);

function lockAgeMs(lock) {
	const age = Date.now() - Date.parse(lock.heldSince);
	return Number.isFinite(age) ? age : 0;
}

function commitSha() {
	if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return "unknown";
	}
}

// On a store that already has data, record where to restore to before changing
// it. Restore needs a bookmark or a time; Time Travel is always on for
// production D1 databases, and `emdash migrate` only accepts production ones,
// so a logged UTC time works even when the bookmark cannot be read.
async function logRestorePoint(accountId, databaseId, databaseName) {
	const when = new Date().toISOString();
	const name = databaseName ?? "<your database name>";
	log(`Restore point: commit ${commitSha()}, ${when} UTC.`);
	let bookmark;
	try {
		const response = await cloudflareGet(`/accounts/${accountId}/d1/database/${databaseId}/time_travel/bookmark`);
		if (response.ok) bookmark = (await response.json())?.result?.bookmark;
	} catch {
		// Falls through to the time-based restore below.
	}
	if (typeof bookmark === "string" && bookmark) {
		log(`D1 Time Travel bookmark before migrating: ${bookmark}`);
		log(`To restore: npx wrangler d1 time-travel restore ${name} --bookmark=${bookmark}`);
	} else {
		log("Could not read a D1 Time Travel bookmark. Continuing anyway: Time Travel keeps this database's history automatically, so it can still be restored to the time above.");
		log(`To restore: npx wrangler d1 time-travel restore ${name} --timestamp=${when}`);
	}
}

async function migrate(accountId, databaseId, databaseName) {
	const target = ["--d1", databaseId, "--account-id", accountId];

	log("Reading the database's migration status...");
	const status = await emdashReport([...target, "--status", "--json"]);
	if (status.code !== 0) {
		if (isPermissionError(status.stderr)) stop("The build could not reach this store's D1 database (permission denied).", D1_EDIT_STEPS, NOTHING_CHANGED);
		stop("Could not read the store database's migration status (see the message above).", RETRY, NOTHING_CHANGED);
	}
	const { report } = status;
	const fingerprint = report?.target?.fingerprint;
	if (
		!/^[a-f0-9]{64}$/.test(fingerprint ?? "") ||
		!Array.isArray(report.pending) ||
		!Array.isArray(report.unknownApplied) ||
		!Array.isArray(report.knownApplied)
	) {
		stop("The migration status could not be understood, so this script will not change the database.", RETRY, NOTHING_CHANGED);
	}
	if (report.unknownApplied.length > 0) {
		stop(
			`The database has migrations this build does not know (${report.unknownApplied.join(", ")}), so it is newer than this build or belongs to another store.`,
			"Update the Otta packages to at least the version that last deployed, or check that wrangler.jsonc points at the right database.",
			"To go back to an earlier version of the store, roll back from your Worker > Deployments in the dashboard; that restores the old code only, and never run older migrations by hand.",
			NOTHING_CHANGED,
		);
	}

	const known = report.knownApplied;
	const pending = report.pending;
	const existing = known.length > 0;
	log(`${known.length} migrations already applied, ${pending.length} pending.`);

	const windowed = pending.filter((name) => MAINTENANCE_WINDOW.has(name));
	if (existing && windowed.length > 0) {
		stop(
			`Pending migration ${windowed.join(", ")} must not run while older code serves traffic, so this build will not apply it.`,
			`Follow the maintenance-window steps in ${UPGRADING} and EmDash's docs on core migrations.`,
			NOTHING_CHANGED,
		);
	}

	let takeOver;
	if (report.lock) {
		const ageMs = lockAgeMs(report.lock);
		const minutes = Math.floor(ageMs / 60000);
		if (ageMs <= LOCK_TAKEOVER_AGE_MS) {
			if (pending.length > 0) {
				stop(
					`Another run took the database's migration lock ${minutes} minute(s) ago, so migrations were not started.`,
					"It is either still running, or it was cut off.",
					"Wait until the lock is 25 minutes old, then run the build again; it re-checks the lock and says what to do next.",
					NOTHING_CHANGED,
				);
			}
			log("A migration lock is held, but nothing is pending, so it does not affect this deploy.");
		} else if (pending.length === 0) {
			log(`Releasing a migration lock left behind ${minutes} minutes ago (nothing is pending).`);
			takeOver = report.lock.id;
		} else {
			const optIn = process.env.OTTA_TAKE_OVER_LOCK;
			if (existing && optIn !== report.lock.id) {
				stop(
					`The database has a migration lock that is ${minutes} minutes old and ${known.length} migrations are already applied, so this build will not take the lock over on its own.`,
					...(optIn ? ["OTTA_TAKE_OVER_LOCK is set but does not match this lock."] : []),
					"First confirm no build or migration job is running for this store (your Worker's build history in the dashboard). A run that was cut off may have left the first pending migration partly applied.",
					"Then add this build variable (your Worker > Settings > Build > Variables), retry the build, and remove the variable afterwards:",
					`  OTTA_TAKE_OVER_LOCK=${report.lock.id}`,
					NOTHING_CHANGED,
				);
			}
			log("The lock looks abandoned. Reading the database again in 60 seconds to make sure nothing is still running...");
			await sleep(LOCK_RECHECK_MS);
			const second = await emdashReport([...target, "--status", "--json"]);
			const appliedKey = (names) => JSON.stringify([...(names ?? [])].sort());
			if (
				second.code !== 0 ||
				second.report?.lock?.id !== report.lock.id ||
				appliedKey(second.report?.knownApplied) !== appliedKey(known)
			) {
				stop(
					"The database changed during the 60-second re-check, or could not be read again, so something may still be running.",
					"Wait 25 minutes, then run the build again.",
					NOTHING_CHANGED,
				);
			}
			log(`Taking over the migration lock left behind ${minutes} minutes ago.`);
			takeOver = report.lock.id;
		}
	}

	let migrationsRan = false;
	if (pending.length > 0 || takeOver) {
		if (pending.length > 0) {
			if (existing) await logRestorePoint(accountId, databaseId, databaseName);
			log(`Applying ${pending.length} migrations. This can take a few minutes...`);
		}
		const args = [...target, "--json", "--expected-target-fingerprint", fingerprint];
		if (takeOver) args.push("--take-over-lock", takeOver);
		const applied = await emdashReport(args);
		if (applied.code !== 0 && pending.length > 0) await failApply(target, applied);
		migrationsRan = pending.length > 0;
		if (applied.code !== 0) log("Warning: could not release the stale lock. Nothing is pending, so it does not affect this deploy.");
		else log(pending.length > 0 ? `Applied ${applied.report?.executed?.length ?? pending.length} migrations.` : "Lock released.");
	}

	const check = await emdashReport([...target, "--check", "--json"]);
	if (check.code !== 0) {
		const reason =
			check.code === 2
				? "Some migrations are still pending."
				: check.code === 3
					? "The database has migrations this build does not know."
					: "The check could not read the database (see the message above).";
		stop(
			"The database check after migrating did not pass, so this store was not deployed.",
			reason,
			migrationsRan
				? "Migrations from this build may already be applied, and deploying older code does not undo them. Get help before building again."
				: "This build applied no migrations.",
			migrationsRan ? NOT_UNDONE : NOTHING_CHANGED,
		);
	}
	if (check.report?.lock) log("Note: a migration lock is still held. It does not affect this deploy.");
	log("Database is up to date.");
	return migrationsRan;
}

async function failApply(target, applied) {
	if (applied.stdout) console.error(scrub(applied.stdout));
	const after = await emdashReport([...target, "--status", "--json"]);
	const state = after.code === 0 && Array.isArray(after.report?.knownApplied) && Array.isArray(after.report?.pending) ? after.report : undefined;
	const next = state?.pending[0];
	if (state) {
		log(
			`State after the failed run: ${state.knownApplied.length} applied, ${state.pending.length} pending, next: ${next ?? "none"}, lock: ${state.lock ? `held (id ${state.lock.id})` : "free"}.`,
		);
	} else {
		log("State after the failed run could not be read.");
	}

	const ambiguous = /ambiguous/i.test(applied.stderr);
	const header = "Applying the database migrations failed (see the message above).";

	// EmDash takes the lock before its first migration, so a run that lost the
	// lock applied nothing, and there is nothing partly applied to worry about.
	if (LOCK_NOT_OBTAINED.test(applied.stderr)) {
		stop(
			"This run did not get the migration lock, so it applied nothing: another run holds it or got there first.",
			"Wait until the lock is 25 minutes old, then run the build again; it re-checks the lock and says what to do next.",
			NOTHING_CHANGED,
		);
	}

	if (state && next === RESUMABLE_MIGRATION && ambiguous) {
		stop(header, `The next pending migration is ${RESUMABLE_MIGRATION}, which EmDash documents as safe to run again after an ambiguous write: it continues after the last rows it wrote.`, RETRY, NOT_UNDONE);
	}
	if (state && next === RESUMABLE_MIGRATION && /manual review/i.test(applied.stderr)) {
		stop(header, `${RESUMABLE_MIGRATION} needs the values listed above corrected: give each an explicit UTC offset, then run the build again.`, NOT_UNDONE);
	}
	if (state && state.knownApplied.length === 0 && !ambiguous) {
		stop(
			header,
			"No migration completed, though the first one may be partly applied. No Worker was deployed.",
			isPermissionError(applied.stderr) ? D1_EDIT_STEPS : RETRY,
			`If it fails the same way again, this store has no data yet: see "${NO_DATA_RECOVERY}" in README.md.`,
		);
	}
	stop(
		header,
		"Do not push, merge an update pull request, or retry the build in the dashboard until someone has looked at this: a run cut off part-way can leave the first pending migration partly applied, and running it again can make that worse. Nothing prevents a later push from running it again, so hold off on all of them.",
		"If the database has to be restored, use the bookmark from the first failed build: bookmarks logged by later builds were taken after partial changes.",
		...(isPermissionError(applied.stderr) ? [D1_EDIT_STEPS.replace(" Then retry the build.", "")] : []),
		`Get help (${HELP}) and include this log.`,
		`If this store has no orders yet, see "${NO_DATA_RECOVERY}" in README.md instead.`,
		NOT_UNDONE,
	);
}

function deploy() {
	return new Promise((done) => {
		// Same command as before this script existed, attached to the terminal.
		const child = spawn("wrangler", ["deploy"], {
			cwd: root,
			env: process.env,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", (error) => {
			console.error(`Could not start wrangler: ${error.message}`);
			done(1);
		});
		child.on("close", (code) => done(code ?? 1));
	});
}

async function main() {
	const args = process.argv.slice(2);
	const unknown = args.filter((arg) => arg !== "--migrate-only");
	if (unknown.length > 0) {
		stop(`Unknown argument: ${unknown.join(" ")}. This script only accepts --migrate-only. To pass options to Wrangler, run it directly.`);
	}

	if (!existsSync(MANIFEST)) {
		stop("The build output is missing (.emdash/migrations.json). Run `npm run build` first; `npm run deploy` needs what it produces.", NOTHING_CHANGED);
	}
	let binding = "DB";
	try {
		binding = JSON.parse(readFileSync(MANIFEST, "utf8"))?.database?.executorConfig?.binding ?? "DB";
	} catch {
		stop(".emdash/migrations.json could not be read. Run `npm run build` again.", NOTHING_CHANGED);
	}
	const { config, databaseId, databaseName } = readConfig(binding);

	// Names only: the first real build tells us what Workers Builds provides.
	log(`Build environment: CLOUDFLARE_ACCOUNT_ID: ${process.env.CLOUDFLARE_ACCOUNT_ID ? "present" : "not present"}; CLOUDFLARE_API_TOKEN: ${process.env.CLOUDFLARE_API_TOKEN ? "present" : "not present"}.`);

	if (!process.env.CLOUDFLARE_API_TOKEN) {
		stop(
			"CLOUDFLARE_API_TOKEN is not set, so this script cannot reach the store's database.",
			process.env.WORKERS_CI
				? D1_EDIT_STEPS
				: "Deploying from your own machine needs an API token with D1 Edit and your account id: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy",
			"Do not deploy a new store with plain `wrangler deploy`: the Worker would try to set up the database itself and be cut off.",
			NOTHING_CHANGED,
		);
	}

	const accountId = await resolveAccountId(config, databaseId);
	const migrationsRan = await migrate(accountId, databaseId, databaseName);

	if (args.includes("--migrate-only")) {
		log("--migrate-only: not deploying.");
		return 0;
	}
	log("Deploying...");
	const code = await deploy();
	if (code !== 0 && migrationsRan) {
		console.error(
			"\n`wrangler deploy` failed after this build applied database migrations.\nThose migrations are already applied, and deploying older code does not undo them. A running store keeps its current version, against the migrated database.\nFix the error above, then retry the build: the migrations are done, so it goes straight to deploying.\n",
		);
	}
	return code;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		if (error instanceof Stop) {
			console.error(`\nDeploy stopped.\n${error.message}\n`);
		} else {
			console.error(scrub(`\nDeploy stopped: unexpected error: ${error?.stack ?? error}\n`));
		}
		process.exit(1);
	},
);

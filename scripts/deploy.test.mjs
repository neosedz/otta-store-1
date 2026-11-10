// Tests for scripts/deploy.mjs. They run the real script against fake `emdash`
// and `wrangler` executables on PATH, so nothing touches Cloudflare:
//   node --test scripts/deploy.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "otta-deploy-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TOKEN = "cf-test-token-value-do-not-print-1234567890";
const ENCRYPTION_KEY = "emdash_enc_v1_never-print-this-either";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "ab".repeat(32);
const REAL_DB_ID = "12345678-1234-4234-8234-123456789012";
const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";
const COMMIT = "deadbeefcafe0123456789";
const PENDING = ["001_initial", "002_media_status", "091_redirect_artifacts"];

// One fake program, installed as both `emdash` and `wrangler`. It appends each
// call to FAKE_CALLS and behaves as the state file in FAKE_STATE says.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify([tool, ...args]) + "\\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const leak = () => {
	if (!state.leak) return;
	console.error("leak on stderr " + process.env.CLOUDFLARE_API_TOKEN + " " + process.env.EMDASH_ENCRYPTION_KEY);
};
const leakPartialStderr = () => {
	if (state.leakFinalLine) process.stderr.write("final line no newline " + process.env.CLOUDFLARE_API_TOKEN);
};
const report = () => ({
	target: { kind: "d1", label: "acct/db/id", fingerprint: state.fingerprint },
	knownApplied: state.applied,
	pending: state.pending,
	unknownApplied: state.unknownApplied,
	executed: [],
	...(state.lock ? { lock: state.lock } : {}),
});
if (tool === "wrangler") {
	if (args[0] === "whoami") {
		leak();
		if (state.whoamiExit) { console.error("whoami failed"); process.exit(state.whoamiExit); }
		console.log(JSON.stringify({ loggedIn: true, accounts: state.accounts }));
		process.exit(0);
	}
	if (args[0] === "deploy") {
		console.log("fake wrangler deployed");
		process.exit(state.deployExit ?? 0);
	}
	console.error("unexpected wrangler call");
	process.exit(99);
}
leak();
if (args.includes("--status")) {
	state.statusCount = (state.statusCount ?? 0) + 1;
	if (state.statusCount >= 2 && state.secondRead) Object.assign(state, state.secondRead);
	save();
	if (state.statusExit) { console.error(state.statusMessage ?? "status failed"); process.exit(state.statusExit); }
	console.log(JSON.stringify(report()));
	process.exit(0);
}
if (args.includes("--check")) {
	if (state.checkExit !== undefined) { console.log(JSON.stringify(report())); process.exit(state.checkExit); }
	const code = state.unknownApplied.length ? 3 : state.pending.length ? 2 : 0;
	console.log(JSON.stringify(report()));
	process.exit(code);
}
// apply
const fp = args[args.indexOf("--expected-target-fingerprint") + 1];
if (!args.includes("--expected-target-fingerprint") || fp !== state.fingerprint) {
	console.error("Noninteractive apply requires --expected-target-fingerprint");
	process.exit(4);
}
if (state.applyExit) {
	console.error(state.applyMessage ?? "apply failed part-way");
	if (state.leakStdout) process.stdout.write("leak on stdout " + process.env.CLOUDFLARE_API_TOKEN + "\\n");
	leakPartialStderr();
	if (state.afterApplyFail) Object.assign(state, state.afterApplyFail);
	save();
	process.exit(state.applyExit);
}
const executed = state.pending;
state.applied = [...state.applied, ...state.pending];
state.pending = [];
state.lock = null;
save();
console.log(JSON.stringify({ ...report(), executed }));
process.exit(0);
`;

// Loaded into the script with --import. Replaces fetch (no network in tests) and
// makes the 60-second lock re-read instant while recording that it was asked for.
const PRELOAD = `import fs from "node:fs";
const log = (entry) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(entry) + "\\n");
const state = () => JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
globalThis.fetch = async (url) => {
	const s = state();
	const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
	log(["fetch", path]);
	if (path.endsWith("/time_travel/bookmark")) {
		if (s.bookmarkFail) return new Response("{}", { status: 500 });
		return Response.json({ success: true, result: { bookmark: s.bookmark ?? "bookmark-before-migrating" } });
	}
	const match = path.match(/^\\/accounts\\/([^/]+)\\/d1\\/database\\/[^/]+$/);
	return new Response("{}", { status: match && (s.d1Access ?? []).includes(match[1]) ? 200 : 404 });
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
	if (ms === 60000) {
		log(["sleep", ms]);
		return realSetTimeout(fn, 0, ...rest);
	}
	return realSetTimeout(fn, ms, ...rest);
};
`;

const WRANGLER_JSONC = (dbId, extra = "") => `// a comment with "database_id": "11111111-1111-1111-1111-111111111111"
{
	"name": "otta-store", // trailing comment
	${extra}
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "otta-store-db",
			"database_id": "${dbId}",
		},
	],
	/* block comment */
}
`;

function defaultState(overrides = {}) {
	return {
		fingerprint: FINGERPRINT,
		applied: [],
		pending: PENDING,
		unknownApplied: [],
		lock: null,
		accounts: [{ id: ACCOUNT, name: "only" }],
		...overrides,
	};
}

let counter = 0;

function runDeploy({
	state: stateOverrides,
	env = {},
	args = [],
	databaseId = REAL_DB_ID,
	wranglerExtra = "",
	manifest = true,
	omit = [],
	wranglerFile,
} = {}) {
	const project = join(scratch, `p${++counter}`);
	const bin = join(project, ".fakebin");
	mkdirSync(join(project, "scripts"), { recursive: true });
	mkdirSync(bin);
	copyFileSync(join(here, "deploy.mjs"), join(project, "scripts", "deploy.mjs"));
	writeFileSync(join(project, "package.json"), '{"name":"t"}');
	writeFileSync(join(project, "wrangler.jsonc"), wranglerFile ?? WRANGLER_JSONC(databaseId, wranglerExtra));
	if (manifest) {
		mkdirSync(join(project, ".emdash"));
		writeFileSync(
			join(project, ".emdash", "migrations.json"),
			JSON.stringify({ database: { executorConfig: { binding: "DB" } } }),
		);
	}
	for (const name of ["emdash", "wrangler"]) {
		const file = join(bin, name);
		writeFileSync(file, FAKE);
		chmodSync(file, 0o755);
	}
	writeFileSync(join(bin, "preload.mjs"), PRELOAD);
	const statePath = join(project, "fake-state.json");
	const callsPath = join(project, "fake-calls.jsonl");
	writeFileSync(statePath, JSON.stringify(defaultState(stateOverrides)));
	writeFileSync(callsPath, "");

	// PATH holds only the fakes and the directory of node itself, so a real
	// `wrangler` can never be reached from a test.
	const childEnv = {
		PATH: `${bin}:${dirname(process.execPath)}`,
		FAKE_STATE: statePath,
		FAKE_CALLS: callsPath,
		NODE_OPTIONS: `--import=${pathToFileURL(join(bin, "preload.mjs")).href}`,
		WORKERS_CI_COMMIT_SHA: COMMIT,
		CLOUDFLARE_API_TOKEN: TOKEN,
		CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
		EMDASH_ENCRYPTION_KEY: ENCRYPTION_KEY,
		...env,
	};
	for (const name of omit) delete childEnv[name];

	const result = spawnSync(process.execPath, [join(project, "scripts", "deploy.mjs"), ...args], {
		cwd: project,
		env: childEnv,
		encoding: "utf8",
	});
	const all = readFileSync(callsPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const calls = all.filter(([tool]) => tool === "emdash" || tool === "wrangler");
	return {
		code: result.status,
		output: `${result.stdout}${result.stderr}`,
		calls,
		steps: calls.map(label),
		sleeps: all.filter(([tool]) => tool === "sleep").length,
		fetches: all.filter(([tool]) => tool === "fetch").map(([, path]) => path),
		state: JSON.parse(readFileSync(statePath, "utf8")),
		project,
	};
}

function label(call) {
	const [tool, ...args] = call;
	if (tool === "wrangler") return args[0] === "whoami" ? "whoami" : "deploy";
	if (args.includes("--status")) return "status";
	if (args.includes("--check")) return "check";
	return "apply";
}

const flagValue = (call, flag) => call[call.indexOf(flag) + 1];
const ago = (minutes) => {
	const heldSince = Date.now() - minutes * 60_000;
	return { id: String(heldSince), heldSince: new Date(heldSince).toISOString() };
};

describe("first deploy and later pushes", () => {
	test("fresh database: applies with the fingerprint, checks, then deploys", () => {
		const run = runDeploy();
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check", "deploy"]);
		const apply = run.calls[1];
		assert.equal(flagValue(apply, "--expected-target-fingerprint"), FINGERPRINT);
		assert.ok(!apply.includes("--take-over-lock"));
		assert.ok(!apply.includes("--wrangler-config"));
		assert.equal(flagValue(apply, "--d1"), REAL_DB_ID);
		assert.equal(flagValue(apply, "--account-id"), ACCOUNT);
		assert.deepEqual(run.state.pending, []);
	});

	test("nothing pending: no apply, still checks, then deploys", () => {
		const run = runDeploy({ state: { pending: [], applied: PENDING } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "check", "deploy"]);
	});

	test("wrangler deploy is run with exactly the arguments the template used", () => {
		const run = runDeploy();
		assert.deepEqual(run.calls.at(-1), ["wrangler", "deploy"]);
	});

	test("deploy exit code is propagated", () => {
		const run = runDeploy({ state: { deployExit: 7 } });
		assert.equal(run.code, 7, run.output);
		assert.equal(run.steps.at(-1), "deploy");
	});

	test("--migrate-only stops after the final check", () => {
		const run = runDeploy({ args: ["--migrate-only"] });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check"]);
	});

	test("an unknown argument is refused before anything runs", () => {
		const run = runDeploy({ args: ["--dry-run"] });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /--dry-run/);
	});
});

describe("migration lock", () => {
	const existing = { applied: ["001_initial"], pending: ["002_media_status"] };

	test("stale lock on an empty database is taken over after a second read", () => {
		const lock = ago(26);
		const run = runDeploy({ state: { lock } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "status", "apply", "check", "deploy"]);
		assert.equal(run.sleeps, 1);
		assert.equal(flagValue(run.calls[2], "--take-over-lock"), lock.id);
		assert.equal(flagValue(run.calls[2], "--expected-target-fingerprint"), FINGERPRINT);
	});

	test("lock just under 25 minutes is refused", () => {
		const run = runDeploy({ state: { lock: ago(24.5) } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /25 minutes/);
	});

	test("lock just over 25 minutes is taken over", () => {
		const run = runDeploy({ state: { lock: ago(25.5) } });
		assert.equal(run.code, 0, run.output);
		assert.ok(run.steps.includes("apply"));
		assert.ok(run.calls.some((call) => call.includes("--take-over-lock")));
	});

	test("fresh lock with pending migrations is refused, nothing applied or deployed", () => {
		const run = runDeploy({ state: { lock: ago(3) } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /25 minutes/);
		assert.match(run.output, /changed nothing/);
	});

	test("a lock with an unreadable time is treated as fresh", () => {
		const run = runDeploy({ state: { lock: { id: "12345", heldSince: "garbage" } } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
	});

	test("stale lock with nothing pending is released without a second read", () => {
		const lock = ago(60);
		const run = runDeploy({ state: { lock, pending: [], applied: PENDING } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check", "deploy"]);
		assert.equal(run.sleeps, 0);
		assert.equal(flagValue(run.calls[1], "--take-over-lock"), lock.id);
	});

	test("a failed release with nothing pending warns and continues", () => {
		const run = runDeploy({ state: { lock: ago(60), pending: [], applied: PENDING, applyExit: 1 } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check", "deploy"]);
		assert.match(run.output, /could not release/i);
		assert.doesNotMatch(run.output, /Get help|Do not/);
	});

	test("fresh lock with nothing pending does not block the deploy", () => {
		const run = runDeploy({ state: { lock: ago(1), pending: [], applied: PENDING } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "check", "deploy"]);
	});

	test("second read refused when the applied set changed", () => {
		const run = runDeploy({
			state: { lock: ago(40), secondRead: { applied: ["001_initial"], pending: ["002_media_status"] } },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "status"]);
		assert.equal(run.sleeps, 1);
		assert.match(run.output, /changed/);
	});

	test("second read refused when the lock id changed", () => {
		const run = runDeploy({ state: { lock: ago(40), secondRead: { lock: ago(1) } } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "status"]);
	});

	test("second read refused when the lock disappeared", () => {
		const run = runDeploy({ state: { lock: ago(40), secondRead: { lock: null } } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "status"]);
	});

	test("stale lock on an existing database is not taken over without the opt-in", () => {
		const lock = ago(40);
		const run = runDeploy({ state: { ...existing, lock } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.equal(run.sleeps, 0);
		assert.ok(!run.calls.some((call) => call.includes("--take-over-lock")));
		assert.match(run.output, new RegExp(`OTTA_TAKE_OVER_LOCK=${lock.id}`));
		assert.match(run.output, /running/i);
	});

	test("opt-in with a different id is refused and shows the real one", () => {
		const lock = ago(40);
		const run = runDeploy({
			state: { ...existing, lock },
			env: { OTTA_TAKE_OVER_LOCK: "123456" },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /does not match/);
		assert.match(run.output, new RegExp(`OTTA_TAKE_OVER_LOCK=${lock.id}`));
	});

	test("opt-in with the exact id takes over after a second read", () => {
		const lock = ago(40);
		const run = runDeploy({
			state: { ...existing, lock },
			env: { OTTA_TAKE_OVER_LOCK: lock.id },
		});
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "status", "apply", "check", "deploy"]);
		assert.equal(run.sleeps, 1);
		assert.equal(flagValue(run.calls[2], "--take-over-lock"), lock.id);
	});

	test("opt-in still refuses when the second read shows the database changing", () => {
		const lock = ago(40);
		const run = runDeploy({
			state: { ...existing, lock, secondRead: { applied: ["001_initial", "002_media_status"], pending: [] } },
			env: { OTTA_TAKE_OVER_LOCK: lock.id },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "status"]);
	});
});

describe("a failed apply", () => {
	const applied = { applied: ["001_initial"], pending: ["002_media_status"] };

	test("nothing completed: no 'changed nothing', allows a retry, points to the recovery", () => {
		const run = runDeploy({ state: { applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "apply", "status"]);
		assert.match(run.output, /0 applied, 3 pending/);
		assert.match(run.output, /No migration completed/);
		assert.doesNotMatch(run.output, /changed nothing/);
		assert.match(run.output, /A new store with no orders/);
		assert.match(run.output, /Retry/);
		assert.doesNotMatch(run.output, /Get help/);
	});

	test("applied migrations on an existing store: stop and get help, no retry", () => {
		const run = runDeploy({ state: { ...applied, applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "apply", "status"]);
		assert.match(run.output, /Get help/);
		assert.doesNotMatch(run.output, /Retry the build from/);
		assert.match(run.output, /1 applied, 1 pending/);
	});

	test("migrations applied by the failed run itself: stop and get help", () => {
		const run = runDeploy({
			state: {
				applyExit: 1,
				afterApplyFail: { applied: ["001_initial"], pending: ["002_media_status", "091_redirect_artifacts"] },
			},
		});
		assert.match(run.output, /Get help/);
		assert.doesNotMatch(run.output, /Retry the build from/);
	});

	test("ambiguous write with nothing applied: stop and get help", () => {
		const run = runDeploy({
			state: { applyExit: 1, applyMessage: "The D1 write outcome is ambiguous because its response was not received safely." },
		});
		assert.match(run.output, /Get help/);
		assert.doesNotMatch(run.output, /Retry the build from/);
	});

	test("the stop names what not to do, and why a restore needs the first bookmark", () => {
		const run = runDeploy({ state: { ...applied, applyExit: 1 } });
		assert.match(run.output, /push, merge an update pull request, or retry the build in the dashboard/);
		assert.match(run.output, /Nothing prevents a later push/);
		assert.match(run.output, /first failed build/);
		assert.match(run.output, /A new store with no orders/);
	});

	for (const [name, message] of [
		["lock held by another run", "The migration lock has been held since 2026-09-01T12:00:00.000Z (lock 1788264000000). A migration may still be running"],
		["timed out waiting for another run", "Timed out waiting for another instance's migrations: the migration lock was still held after 10000ms."],
		["take-over lost", "The migration lock has a different id now. Check the status again."],
		["take-over lock gone", "The migration lock is not held."],
	]) {
		test(`this run never got the lock (${name}): a wait message, not a stop`, () => {
			const run = runDeploy({ state: { ...applied, applyExit: 1, applyMessage: message } });
			assert.notEqual(run.code, 0);
			assert.deepEqual(run.steps, ["status", "apply", "status"]);
			assert.match(run.output, /did not get the migration lock/);
			assert.match(run.output, /25 minutes/);
			assert.doesNotMatch(run.output, /partly applied/);
			assert.doesNotMatch(run.output, /Get help/);
		});
	}

	test("ambiguous write with 079 next: the documented exception, run again", () => {
		const run = runDeploy({
			state: {
				...applied,
				pending: ["079_datetime_normalization", "080_x"],
				applyExit: 1,
				applyMessage: "The D1 write outcome is ambiguous because its response was not received safely.",
			},
		});
		assert.notEqual(run.code, 0);
		assert.match(run.output, /079_datetime_normalization/);
		assert.match(run.output, /Retry/);
		assert.doesNotMatch(run.output, /Get help/);
	});

	test("079 needing manual review: correct the values, then run again", () => {
		const run = runDeploy({
			state: {
				...applied,
				pending: ["079_datetime_normalization"],
				applyExit: 1,
				applyMessage: "Datetime migration requires manual review: ec_posts/1 published_at",
			},
		});
		assert.match(run.output, /explicit UTC offset/);
		assert.doesNotMatch(run.output, /Get help/);
	});

	test("a failed status read afterwards: stop and get help", () => {
		const run = runDeploy({ state: { applyExit: 1, afterApplyFail: { statusExit: 1 } } });
		assert.match(run.output, /could not be read/i);
		assert.match(run.output, /Get help/);
	});

	test("the state is printed with the lock", () => {
		const run = runDeploy({ state: { ...applied, applyExit: 1, afterApplyFail: { lock: ago(0) } } });
		assert.match(run.output, /lock: held/);
	});

	test("permission failure on apply names D1 Edit", () => {
		const run = runDeploy({ state: { applyExit: 1, applyMessage: "D1 API request failed with HTTP status 403." } });
		assert.match(run.output, /D1 Edit/);
	});
});

describe("maintenance-window migrations", () => {
	test("refused on an existing store, pointing to UPGRADING", () => {
		const run = runDeploy({
			state: { applied: ["001_initial"], pending: ["095_plugin_storage_unique_scope"] },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /095_plugin_storage_unique_scope/);
		assert.match(run.output, /UPGRADING/);
	});

	test("applied normally on a fresh database", () => {
		const run = runDeploy({ state: { pending: ["001_initial", "095_plugin_storage_unique_scope"] } });
		assert.equal(run.code, 0, run.output);
		assert.ok(run.steps.includes("apply"));
	});
});

describe("restore point", () => {
	const existing = { applied: ["001_initial"], pending: ["002_media_status"] };

	test("existing store: bookmark and commit logged before applying", () => {
		const run = runDeploy({ state: existing });
		assert.equal(run.code, 0, run.output);
		assert.ok(run.fetches.some((path) => path.endsWith(`/d1/database/${REAL_DB_ID}/time_travel/bookmark`)));
		assert.match(run.output, /bookmark-before-migrating/);
		assert.match(run.output, new RegExp(COMMIT));
		assert.ok(run.output.indexOf("bookmark-before-migrating") < run.output.indexOf("Applied"));
	});

	test("fresh database: no restore point", () => {
		const run = runDeploy();
		assert.equal(run.fetches.length, 0);
		assert.doesNotMatch(run.output, /[Bb]ookmark/);
	});

	test("nothing pending: no restore point", () => {
		const run = runDeploy({ state: { applied: ["001_initial"], pending: [] } });
		assert.equal(run.fetches.length, 0);
	});

	test("unreadable bookmark: logs the UTC time, says why it is safe, and continues", () => {
		const run = runDeploy({ state: { ...existing, bookmarkFail: true } });
		assert.equal(run.code, 0, run.output);
		assert.match(run.output, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		assert.match(run.output, /--timestamp/);
		assert.match(run.output, /Time Travel/);
	});
});

describe("failures stop before deploy", () => {
	test("migrate failure stops before deploy", () => {
		const run = runDeploy({ state: { applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.ok(!run.steps.includes("deploy"));
	});

	test("final check failure after applying says migrations may be applied", () => {
		const run = runDeploy({ state: { checkExit: 2 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "apply", "check"]);
		assert.match(run.output, /may already be applied/);
		assert.match(run.output, /does not undo/);
		assert.doesNotMatch(run.output, /changed nothing/);
	});

	test("final check failure with nothing applied says nothing changed", () => {
		const run = runDeploy({ state: { pending: [], applied: PENDING, checkExit: 2 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "check"]);
		assert.match(run.output, /changed nothing/);
	});

	test("deploy failure after applying says migrations stay applied, keeps the code", () => {
		const run = runDeploy({ state: { deployExit: 5 } });
		assert.equal(run.code, 5, run.output);
		assert.match(run.output, /already applied/);
		assert.match(run.output, /does not undo/);
	});

	test("deploy failure with nothing applied adds no migration warning", () => {
		const run = runDeploy({ state: { pending: [], applied: PENDING, deployExit: 5 } });
		assert.equal(run.code, 5, run.output);
		assert.doesNotMatch(run.output, /does not undo/);
	});

	test("status failure stops before anything else", () => {
		const run = runDeploy({ state: { statusExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /changed nothing/);
	});

	test("unknown applied migrations: refused, mentions the dashboard rollback", () => {
		const run = runDeploy({ state: { unknownApplied: ["999_future"], pending: [] } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /newer/i);
		assert.match(run.output, /Deployments/);
	});

	test("a malformed fingerprint from status is refused", () => {
		const run = runDeploy({ state: { fingerprint: "nope" } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
	});

	test("a permission failure reading status names D1 Edit and the steps", () => {
		const run = runDeploy({ state: { statusExit: 1, statusMessage: "Cloudflare D1 metadata request failed with HTTP status 403." } });
		assert.notEqual(run.code, 0);
		assert.match(run.output, /D1 Edit/);
		assert.match(run.output, /API [Tt]oken/);
	});
});

describe("preflight refusals", () => {
	test("placeholder database id is refused without touching anything", () => {
		const run = runDeploy({ databaseId: PLACEHOLDER_DB_ID });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /placeholder/i);
		assert.match(run.output, /database_id/);
	});

	test("a non-UUID database id is refused", () => {
		const run = runDeploy({ databaseId: "your-database-id" });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
	});

	test("the real wrangler.jsonc parses: its placeholder is found", () => {
		const wranglerFile = readFileSync(join(here, "..", "wrangler.jsonc"), "utf8");
		const run = runDeploy({ wranglerFile });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /placeholder/i);
	});

	test("the real wrangler.jsonc with a real id passes that id with --d1", () => {
		const wranglerFile = readFileSync(join(here, "..", "wrangler.jsonc"), "utf8").replace(
			PLACEHOLDER_DB_ID,
			REAL_DB_ID,
		);
		const run = runDeploy({ wranglerFile });
		assert.equal(run.code, 0, run.output);
		assert.equal(flagValue(run.calls[0], "--d1"), REAL_DB_ID);
	});

	test("missing token: names the variable, where to set it, and stops", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_API_TOKEN"] });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /CLOUDFLARE_API_TOKEN/);
		assert.match(run.output, /D1/);
	});

	test("missing token inside Workers Builds says so", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_API_TOKEN"], env: { WORKERS_CI: "1" } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /Build/);
	});

	test("missing build manifest asks for npm run build", () => {
		const run = runDeploy({ manifest: false });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /npm run build/);
	});
});

describe("account id", () => {
	test("CLOUDFLARE_ACCOUNT_ID is used without calling whoami", () => {
		const run = runDeploy();
		assert.equal(run.code, 0, run.output);
		assert.ok(!run.steps.includes("whoami"));
	});

	test("wrangler.jsonc account_id beats CLOUDFLARE_ACCOUNT_ID", () => {
		const configured = "fedcba9876543210fedcba9876543210";
		const run = runDeploy({ wranglerExtra: `"account_id": "${configured}",` });
		assert.equal(run.code, 0, run.output);
		assert.equal(flagValue(run.calls[0], "--account-id"), configured);
	});

	test("logs whether the variable was present, without its value", () => {
		const present = runDeploy();
		assert.match(present.output, /CLOUDFLARE_ACCOUNT_ID: present/);
		const absent = runDeploy({ omit: ["CLOUDFLARE_ACCOUNT_ID"] });
		assert.match(absent.output, /CLOUDFLARE_ACCOUNT_ID: not present/);
	});

	test("account_id in wrangler.jsonc is used without calling whoami", () => {
		const configured = "fedcba9876543210fedcba9876543210";
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			wranglerExtra: `"account_id": "${configured}",`,
		});
		assert.equal(run.code, 0, run.output);
		assert.ok(!run.steps.includes("whoami"));
		assert.equal(flagValue(run.calls[0], "--account-id"), configured);
	});

	test("falls back to the single account wrangler can see", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_ACCOUNT_ID"] });
		assert.equal(run.code, 0, run.output);
		assert.equal(run.steps[0], "whoami");
		assert.equal(flagValue(run.calls[1], "--account-id"), ACCOUNT);
	});

	const SECOND = "fedcba9876543210fedcba9876543210";
	const twoAccounts = [
		{ id: ACCOUNT, name: "a" },
		{ id: SECOND, name: "b" },
	];

	test("several accounts: picks the one where the database answers", () => {
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			state: { accounts: twoAccounts, d1Access: [SECOND] },
		});
		assert.equal(run.code, 0, run.output);
		assert.equal(flagValue(run.calls[1], "--account-id"), SECOND);
		assert.equal(run.fetches.length, 2);
	});

	test("several accounts, database in none: refused with exact steps", () => {
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			state: { accounts: twoAccounts, d1Access: [] },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["whoami"]);
		assert.match(run.output, /CLOUDFLARE_ACCOUNT_ID/);
		assert.match(run.output, /Settings/);
	});

	test("several accounts, database in more than one: refused", () => {
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			state: { accounts: twoAccounts, d1Access: [ACCOUNT, SECOND] },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["whoami"]);
	});

	test("whoami failure names the variable to set", () => {
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			state: { whoamiExit: 1 },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["whoami"]);
		assert.match(run.output, /CLOUDFLARE_ACCOUNT_ID/);
	});
});

describe("secrets", () => {
	const assertClean = (run) => {
		assert.ok(!run.output.includes(TOKEN), "token printed");
		assert.ok(!run.output.includes(ENCRYPTION_KEY), "encryption key printed");
		for (const call of run.calls) {
			assert.ok(!call.join(" ").includes(TOKEN), "token passed as an argument");
		}
	};

	test("secrets echoed by a tool never reach the build log", () => {
		const run = runDeploy({ state: { leak: true } });
		assert.equal(run.code, 0, run.output);
		assert.match(run.output, /leak on stderr/);
		assertClean(run);
	});

	test("secrets echoed on a failed apply never reach the build log", () => {
		const run = runDeploy({ state: { leak: true, applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assertClean(run);
	});

	test("secrets on stdout of a failed apply never reach the build log", () => {
		const run = runDeploy({ state: { leakStdout: true, applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.match(run.output, /leak on stdout/);
		assertClean(run);
	});

	test("a secret on a final line without a newline is scrubbed", () => {
		const run = runDeploy({ state: { leakFinalLine: true, applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.match(run.output, /final line no newline/);
		assertClean(run);
	});

	test("secrets echoed by whoami never reach the build log", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_ACCOUNT_ID"], state: { leak: true, whoamiExit: 1 } });
		assert.notEqual(run.code, 0);
		assertClean(run);
	});
});

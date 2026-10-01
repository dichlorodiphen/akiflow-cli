import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GooglePlan {
	lists?: Record<string, unknown[]>;
	gets?: Record<string, unknown>;
	failure?: unknown;
	stderr?: string;
	exit?: number;
	raw?: string;
}

/** A fake executable implementing exactly the native list/get API JSON contract. */
export function makeGoogleReader(directory: string, plan: GooglePlan) {
	const executable = join(directory, "fake Google reader with spaces");
	const planPath = join(directory, "google-plan.json");
	const logPath = join(directory, "google-argv.jsonl");
	writeFileSync(planPath, JSON.stringify(plan));
	writeFileSync(
		executable,
		`#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync(process.env.AF_FAKE_GOOGLE_PLAN, 'utf8'));
const argv = process.argv.slice(2);
appendFileSync(process.env.AF_FAKE_GOOGLE_LOG, JSON.stringify({executable:process.argv[1],argv})+'\\n');
if (argv.length!==5 || argv[0]!=='calendar' || argv[1]!=='events' || !['list','get'].includes(argv[2]) || argv[3]!=='--params') throw new Error('non-read argv');
const params = JSON.parse(argv[4]);
if ('sendUpdates' in params) throw new Error('mutation parameter');
if (plan.stderr) console.error(plan.stderr);
if (plan.raw!==undefined) { console.log(plan.raw); process.exit(plan.exit??0); }
if (plan.failure) { console.log(JSON.stringify(plan.failure)); process.exit(plan.exit??1); }
let value;
if (argv[2]==='list') {
 const pages = plan.lists?.[params.calendarId] ?? [{kind:'calendar#events',items:[],timeZone:'America/Los_Angeles'}];
 const index = params.pageToken ? Number(params.pageToken.slice(5)) : 0;
 value = pages[index];
} else value = plan.gets?.[params.calendarId+':'+params.eventId] ?? {error:{code:404,message:'provider ID not found'}};
console.log(JSON.stringify(value));
process.exit(plan.exit??0);
`,
	);
	chmodSync(executable, 0o700);
	return {
		executable,
		planPath,
		logPath,
		env: {
			AF_FAKE_GOOGLE_PLAN: planPath,
			AF_FAKE_GOOGLE_LOG: logPath,
			HATCH_GWS_CLI: executable,
		},
	};
}

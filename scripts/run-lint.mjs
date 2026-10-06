import { spawnSync } from "node:child_process";

const npmCommand = process.env.npm_execpath ? process.execPath : "npm";
const npmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];

const tasks = [
	["run", "lint:ts"],
	["run", "lint:review-types"],
	["run", "lint:css"],
	["run", "lint:architecture"],
];

let failed = false;

for (const args of tasks) {
	const result = spawnSync(npmCommand, [...npmPrefix, ...args], {
		stdio: "inherit",
	});

	if (result.status !== 0) {
		failed = true;
	}
}

process.exit(failed ? 1 : 0);

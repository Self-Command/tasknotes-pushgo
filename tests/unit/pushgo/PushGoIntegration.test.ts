import { TFile, requestUrl } from "obsidian";
import type TaskNotesPlugin from "../../../src/main";
import { PushGoIntegration } from "../../../src/api/pushgo/PushGoIntegration";
import {
	defaultPushGoConfig,
	planPatch,
	validateAttachmentDir,
	checkinBlock,
	type PushGoPlan,
} from "../../../src/pushgo/model";
import type { TaskInfo } from "../../../src/types";

const plan: PushGoPlan = {
	title: "任务",
	scheduled: "2026-10-10T09:00",
	due: "2026-10-10T10:00",
	priority: "normal",
	status: "open",
	completed: false,
	archived: false,
	recurrence: null,
	timezone: "Asia/Shanghai",
	startLeadMinutes: null,
	endLeadMinutes: null,
	enabled: true,
};
test("failed local edits can be removed without submitting a server mutation", async () => {
	const { integration, task, original } = fixture();
	original.updateProperty.mockRejectedValueOnce(new Error("file write failed"));
	await expect(integration.uiService().updateProperty(task, "priority", "high")).rejects.toThrow(
		"file write failed"
	);
	expect(integration.state.operations[0].phase).toBe("prepared");
	const network = jest.spyOn(integration, "api");
	await integration.discardPrepared(integration.state.operations[0].operationId);
	expect(integration.state.operations).toHaveLength(0);
	expect(network).not.toHaveBeenCalled();
	expect(integration.state.tasks["task-id"].plan.priority).toBe("normal");
});
function fixture() {
	const files = new Map<string, string>();
	const file = new TFile("Tasks/a.md");
	const task = { ...plan, path: file.path, tags: [] } as unknown as TaskInfo;
	const original = {
		updateProperty: jest.fn(async (_task: TaskInfo, key: string, value: unknown) => ({
			...task,
			[key]: value,
		})),
		deleteTask: jest.fn(async () => {
			files.delete(file.path);
		}),
	};
	files.set(file.path, "# task");
	const plugin = {
		manifest: { dir: ".test/plugins/tasknotes" },
		settings: {
			tasksFolder: "Tasks",
			defaultTaskStatus: "open",
			defaultTaskPriority: "normal",
		},
		statusManager: {
			isCompletedStatus: (s: string) => s === "done",
			getCompletedStatuses: () => ["done"],
		},
		taskService: original,
		app: {
			vault: {
				configDir: ".test",
				adapter: {
					exists: async (p: string) => files.has(p),
					read: async (p: string) => files.get(p)!,
					write: async (p: string, s: string) => {
						files.set(p, s);
					},
					remove: async (p: string) => {
						files.delete(p);
					},
				},
				getAbstractFileByPath: (p: string) =>
					files.has(p) && p === file.path ? file : null,
			},
			cacheManager: { getTaskInfo: async () => task },
		},
	} as unknown as TaskNotesPlugin;
	const integration = new PushGoIntegration(plugin);
	integration.state.config = {
		...defaultPushGoConfig,
		enabled: true,
		serviceUrl: "http://localhost:8787",
		token: "test",
	};
	integration.state.tasks["task-id"] = {
		taskId: "task-id",
		path: file.path,
		version: 1,
		plan: { ...plan },
		cancelled: false,
	};
	return { integration, plugin, original, files, task, file };
}

describe("PushGo approved UI operation journal", () => {
	test("priority-only UI edit excludes earlier raw file date changes", async () => {
		const { integration, task, original } = fixture();
		const sync = jest.spyOn(integration, "sync").mockResolvedValue("offline");
		task.scheduled = "2030-01-01T00:00";
		await integration.uiService().updateProperty(task, "priority", "high");
		expect(integration.state.operations[0].changes).toEqual({ priority: "high" });
		expect(integration.state.tasks["task-id"].plan.scheduled).toBe(plan.scheduled);
		expect(original.updateProperty).toHaveBeenCalledTimes(1);
		expect(sync).toHaveBeenCalled();
	});
	test("raw service changes and file disappearance generate no operation", async () => {
		const { integration, task, original, files } = fixture();
		await original.updateProperty(task, "scheduled", "2030-01-01");
		files.delete(task.path);
		expect(integration.state.operations).toHaveLength(0);
		expect(integration.state.tasks["task-id"].cancelled).toBe(false);
	});
	test("UI delete persists cancellation before networking", async () => {
		const { integration, task, files } = fixture();
		jest.spyOn(integration, "sync").mockResolvedValue("offline");
		await integration.uiService().deleteTask(task);
		expect(integration.state.operations[0].action).toBe("cancel");
		expect(integration.state.tasks["task-id"].cancelled).toBe(true);
		expect(
			JSON.parse(files.get(".test/plugins/tasknotes/pushgo-state.json")!).operations[0].phase
		).toBe("queued");
	});
	test("timeout after server commit retries identical operation and version", async () => {
		const { integration, task } = fixture();
		const sync = jest.spyOn(integration, "sync").mockResolvedValue("offline");
		await integration.uiService().updateProperty(task, "priority", "high");
		sync.mockRestore();
		const bodies: unknown[] = [];
		let failed = false;
		jest.spyOn(integration, "api").mockImplementation(async (path, body) => {
			if (path.includes("mutations")) {
				bodies.push(JSON.parse(JSON.stringify(body)));
				if (!failed) {
					failed = true;
					throw new Error("timeout");
				}
				return {
					id: "task-id",
					version: 2,
					plan: { ...plan, priority: "high" },
					cancelled: false,
				};
			}
			return { cursor: 1, hasMore: false, changes: [] };
		});
		await expect(integration.sync()).rejects.toThrow("timeout");
		integration.state.tasks["task-id"].version = 99;
		await integration.sync();
		expect(bodies[0]).toEqual(bodies[1]);
		expect(integration.state.operations).toHaveLength(0);
	});
	test("multi-device conflict waits for user and retries against selected remote version", async () => {
		const { integration, task } = fixture();
		const sync = jest.spyOn(integration, "sync").mockResolvedValue("offline");
		await integration.uiService().updateProperty(task, "priority", "high");
		sync.mockRestore();
		let conflict = true;
		const bodies: Record<string, unknown>[] = [];
		jest.spyOn(integration, "api").mockImplementation(async (path, body) => {
			if (path.includes("mutations")) {
				bodies.push(body as Record<string, unknown>);
				if (conflict) throw new Error("409: version_conflict");
				return {
					id: "task-id",
					version: 5,
					plan: { ...plan, priority: "high" },
					cancelled: false,
				};
			}
			if (path.includes("instances"))
				return { id: "task-id", version: 4, plan, cancelled: false };
			return { cursor: 1, hasMore: false, changes: [] };
		});
		await integration.sync();
		expect(integration.state.operations[0].phase).toBe("conflict");
		const oldId = integration.state.operations[0].operationId;
		conflict = false;
		await integration.resolveConflict(oldId, true);
		expect(bodies[1].baseVersion).toBe(4);
		expect(bodies[1].operationId).not.toBe(oldId);
	});
	test("concurrent manual and resume pulls share one request", async () => {
		const { integration } = fixture();
		let finish: (value: unknown) => void = () => {};
		jest.spyOn(integration, "api").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const first = integration.sync(),
			second = integration.sync();
		expect(first).toBe(second);
		finish({ cursor: 0, hasMore: false, changes: [] });
		await first;
	});
	test("attachment path rejects nested task directories and configured metadata directory", () => {
		for (const p of ["Tasks", "Tasks/photos", "../photos", ".test/images", "photos[1]"])
			expect(() => validateAttachmentDir(p, "Tasks", ".test")).toThrow();
		expect(validateAttachmentDir("PushGo附件/", "Tasks", ".test")).toBe("PushGo附件");
	});
	test("patch clearing is explicit and managed block escapes note markup", () => {
		expect(planPatch({ due: undefined }, () => false)).toEqual({ due: null });
		const text = checkinBlock(
			{
				id: "record",
				taskId: "a",
				instanceId: "b",
				kind: "end",
				at: 0,
				mediaId: "m",
				note: "<!-- fake -->",
			},
			"PushGo附件/m.jpg"
		);
		expect(text).toContain("\\<");
		expect(text).toContain("![[PushGo附件/m.jpg]]");
	});
});

test("photo failure retries independently; missing local photo is downloaded once again", async () => {
	const { integration, plugin, files, file } = fixture();
	const record = {
		id: "record-id",
		taskId: "task-id",
		instanceId: "instance",
		kind: "end",
		at: 0,
		mediaId: "photo-id",
		note: "ok",
	};
	integration.state.records[record.id] = record as (typeof integration.state.records)[string];
	jest.spyOn(integration, "api").mockResolvedValue({ cursor: 1, hasMore: false, changes: [] });
	const createBinary = jest.fn(async (path: string) => {
		files.set(path, "[photo]");
		return new TFile(path);
	});
	Object.assign(plugin.app.vault, {
		createBinary,
		createFolder: async (path: string) => {
			files.set(path, "[folder]");
		},
		process: async (f: TFile, fn: (s: string) => string) => {
			files.set(f.path, fn(files.get(f.path)!));
		},
	});
	const network = jest.mocked(requestUrl);
	network
		.mockResolvedValueOnce({
			status: 503,
			json: {},
			text: "",
			headers: {},
			arrayBuffer: new ArrayBuffer(4),
		})
		.mockResolvedValue({
			status: 200,
			json: {},
			text: "",
			headers: {},
			arrayBuffer: new ArrayBuffer(4),
		});
	await integration.sync();
	expect(integration.state.records[record.id].error).toContain("503");
	expect(integration.state.cursor).toBe(1);
	await integration.sync();
	await integration.sync();
	expect(createBinary).toHaveBeenCalledTimes(1);
	expect(files.get(file.path)?.match(/<!-- pushgo-checkin:/g)).toHaveLength(1);
	files.delete("PushGo附件/photo-id.jpg");
	await integration.sync();
	expect(createBinary).toHaveBeenCalledTimes(2);
	files.delete(file.path);
	await integration.sync();
	expect(integration.state.records[record.id].error).toContain("待关联");
	expect(files.has(file.path)).toBe(false);
});

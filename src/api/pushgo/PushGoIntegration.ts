import { Notice, TFile, normalizePath, requestUrl } from "obsidian";
import type TaskNotesPlugin from "../../main";
import type { TaskService } from "../../services/TaskService";
import type { TaskInfo } from "../../types";
import {
	defaultPushGoConfig,
	validateAttachmentDir,
	planPatch,
	checkinBlock,
	type PushGoState,
	type PushGoPlan,
	type UiOperation,
	type CheckinRecord,
	type PushGoConfig,
} from "../../pushgo/model";

type RemoteTask = { id: string; version: number; plan: PushGoPlan; cancelled: boolean };
export class PushGoIntegration {
	state: PushGoState = {
		config: { ...defaultPushGoConfig },
		tasks: {},
		operations: [],
		cursor: 0,
		records: {},
	};
	private storageTail: Promise<void> = Promise.resolve();
	private commandTail: Promise<unknown> = Promise.resolve();
	private syncPromise: Promise<string> | null = null;
	private closed = false;
	private deviceId = "";
	private retryTimer: number | null = null;
	private retryDelay = 15000;
	private listeners = new Set<() => void>();
	constructor(public plugin: TaskNotesPlugin) {}
	get config() {
		return this.state.config;
	}
	private get path() {
		return normalizePath(
			`${this.plugin.manifest.dir}/pushgo-state${this.deviceId ? "." + this.deviceId : ""}.json`
		);
	}
	subscribe(fn: () => void) {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	private changed() {
		for (const fn of this.listeners) fn();
	}
	async initialize() {
		const adapter = this.plugin.app.vault.adapter;
		const localKey = "tasknotes.pushgo.device." + this.plugin.app.vault.getName();
		const savedDevice = window.localStorage.getItem(localKey);
		this.deviceId =
			savedDevice && /^[a-f0-9-]{36}$/.test(savedDevice) ? savedDevice : crypto.randomUUID();
		window.localStorage.setItem(localKey, this.deviceId);
		const candidates: PushGoState[] = [];
		const legacy = normalizePath(`${this.plugin.manifest.dir}/pushgo-state.json`);
		for (const path of [
			this.path,
			this.path + ".tmp",
			this.path + ".bak",
			...(!(await adapter.exists(this.path)) ? [legacy] : []),
		]) {
			if (await adapter.exists(path)) {
				try {
					candidates.push(JSON.parse(await adapter.read(path)) as PushGoState);
				} catch {
					new Notice("推送本地同步文件异常，尝试恢复备份");
				}
			}
		}
		const raw = candidates.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
		if (raw)
			this.state = {
				...this.state,
				...raw,
				config: { ...defaultPushGoConfig, ...raw.config },
			};
		this.plugin.addCommand({
			id: "pushgo-pull-checkins",
			name: "拉取打卡记录和照片",
			callback: () => {
				void this.sync()
					.then((text) => new Notice(text))
					.catch((error) => new Notice(this.message(error)));
			},
		});
		this.plugin.addCommand({
			id: "pushgo-settings",
			name: "推送设置和同步中心",
			callback: () => {
				void this.openPanel();
			},
		});
		this.plugin.addCommand({
			id: "pushgo-configure-current-task",
			name: "接入或设置当前任务的推送打卡",
			checkCallback: (checking) => {
				const file = this.plugin.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking)
					void this.plugin.cacheManager.getTaskInfo(file.path).then(async (task) => {
						if (task) await this.openPanel(task);
						else new Notice("当前笔记不是任务");
					});
				return true;
			},
		});
		this.plugin.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") void this.sync().catch(() => {});
		});
		this.plugin.registerDomEvent(window, "online", () => {
			void this.sync().catch(() => {});
		});
		this.scheduleRetry();
		this.plugin.registerEvent(
			this.plugin.app.vault.on("rename", (file, oldPath) => {
				for (const task of Object.values(this.state.tasks))
					if (task.path === oldPath) task.path = file.path;
					else if (task.path.startsWith(oldPath + "/"))
						task.path = file.path + task.path.slice(oldPath.length);
				void this.persist();
			})
		);
		this.plugin.app.workspace.onLayoutReady(() => {
			void this.plugin
				.onReady()
				.then(() => this.recoverPrepared())
				.then(() => this.sync())
				.catch((error) => new Notice(this.message(error)));
		});
	}
	close() {
		this.closed = true;
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.listeners.clear();
	}
	async openPanel(task?: TaskInfo) {
		const { PushGoModal } = await import("../../pushgo/PushGoPanel");
		new PushGoModal(this, task).open();
	}
	message(error: unknown) {
		return error instanceof Error ? error.message : "PushGo 操作失败";
	}
	private scheduleRetry() {
		if (this.closed) return;
		this.retryTimer = window.setTimeout(() => {
			if (document.visibilityState !== "visible") {
				this.scheduleRetry();
				return;
			}
			void this.sync()
				.then(
					() => {
						this.retryDelay = 60000;
					},
					() => {
						this.retryDelay = Math.min(300000, this.retryDelay * 2);
					}
				)
				.finally(() => this.scheduleRetry());
		}, this.retryDelay);
	}
	persist() {
		this.state.revision = (this.state.revision ?? 0) + 1;
		this.changed();
		const serialized = JSON.stringify(this.state);
		this.storageTail = this.storageTail
			.catch(() => {})
			.then(async () => {
				const adapter = this.plugin.app.vault.adapter;
				await adapter.write(this.path + ".tmp", serialized);
				if (await adapter.exists(this.path))
					await adapter.write(this.path + ".bak", await adapter.read(this.path));
				await adapter.write(this.path, serialized);
				await adapter.remove(this.path + ".tmp");
			});
		return this.storageTail;
	}
	async configure(config: PushGoConfig) {
		const dir = validateAttachmentDir(
			config.attachmentDir,
			this.plugin.settings.tasksFolder,
			this.plugin.app.vault.configDir
		);
		const url = new URL(config.serviceUrl);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error("服务地址必须是 HTTP/HTTPS，且不能包含密码、查询或片段");
		this.state.config = {
			...config,
			serviceUrl: url.toString().replace(/\/$/, ""),
			attachmentDir: dir,
		};
		await this.persist();
	}
	async api<T>(
		path: string,
		body?: unknown,
		method = body === undefined ? "GET" : "POST"
	): Promise<T> {
		if (!this.config.serviceUrl) throw new Error("请先配置 TaskNotes 业务服务");
		const response = await requestUrl({
			url: `${this.config.serviceUrl}/tasknotes/v1${path}`,
			method,
			headers: {
				"Content-Type": "application/json",
				...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});
		if (response.status >= 400) {
			const code = String(response.json?.error ?? "request_failed");
			throw new Error(`${response.status}: ${code}`);
		}
		return response.json as T;
	}
	async disconnect() {
		if (this.config.token) await this.api("/auth/logout", {});
		this.config.token = "";
		this.config.enabled = false;
		await this.persist();
	}
	async login(password: string) {
		const result = await this.api<{ token: string; workspaceId: string }>("/auth/login", {
			password,
			client: "plugin",
		});
		this.config.token = result.token;
		this.config.workspaceId = result.workspaceId;
		await this.persist();
	}
	async saveDefaults() {
		const c = this.config;
		await this.api(
			"/settings",
			{
				timezone: c.timezone,
				startLeadMinutes: c.startLeadMinutes,
				endLeadMinutes: c.endLeadMinutes,
				morningTime: c.morningTime,
				eveningTime: c.eveningTime,
				reportSeverity: c.reportSeverity,
				reportEmpty: c.reportEmpty,
				reportsEnabled: c.reportsEnabled,
				retentionDays: c.retentionDays,
				priorityMap: c.priorityMap,
			},
			"PUT"
		);
	}
	private taskByPath(path: string) {
		return Object.values(this.state.tasks).find((t) => t.path === path);
	}
	uiService(): TaskService {
		const target = this.plugin.taskService;
		return new Proxy(target, {
			get: (obj, key) => {
				const value = Reflect.get(obj, key) as unknown;
				const names = [
					"createTask",
					"updateTask",
					"updateProperty",
					"toggleStatus",
					"toggleArchive",
					"deleteTask",
				];
				if (typeof key === "string" && names.includes(key) && typeof value === "function")
					return (...args: unknown[]) => {
						const run = () =>
							this.runUi(key, args, () => Reflect.apply(value, obj, args));
						const work = this.commandTail.then(run, run);
						this.commandTail = work.catch(() => {});
						return work;
					};
				return typeof value === "function" ? value.bind(obj) : value;
			},
		});
	}
	private snapshot(task: TaskInfo): PushGoPlan {
		return {
			title: task.title,
			scheduled: task.scheduled ?? null,
			due: task.due ?? null,
			priority: task.priority,
			status: task.status,
			completed: this.plugin.statusManager.isCompletedStatus(task.status),
			archived: task.archived,
			recurrence: task.recurrence ?? null,
			timezone: this.config.timezone,
			startLeadMinutes: null,
			endLeadMinutes: null,
			enabled: true,
		};
	}
	private async runUi(
		method: string,
		args: unknown[],
		execute: () => Promise<unknown>,
		overrides?: Partial<PushGoPlan>
	) {
		if (!this.config.enabled) return execute();
		const source = args[0] as TaskInfo;
		const approved = method === "createTask" ? undefined : this.taskByPath(source.path);
		if (method !== "createTask" && !approved) return execute();
		const taskId = approved?.taskId ?? crypto.randomUUID();
		let changes: Partial<PushGoPlan> = {};
		if (method === "createTask")
			changes = this.snapshot({
				...source,
				path: "",
				title: source.title ?? "",
				status: source.status ?? this.plugin.settings.defaultTaskStatus,
				priority: source.priority ?? this.plugin.settings.defaultTaskPriority,
				archived: false,
			});
		if (method === "updateTask")
			changes = planPatch(args[1] as Record<string, unknown>, (s) =>
				this.plugin.statusManager.isCompletedStatus(s)
			);
		if (method === "updateProperty")
			changes = planPatch({ [String(args[1])]: args[2] }, (s) =>
				this.plugin.statusManager.isCompletedStatus(s)
			);
		if (method === "toggleStatus")
			changes = {
				status: this.plugin.statusManager.isCompletedStatus(source.status)
					? this.plugin.settings.defaultTaskStatus
					: (this.plugin.statusManager.getCompletedStatuses()[0] ?? "done"),
			};
		if (method === "toggleArchive") changes = { archived: !source.archived };
		changes = { ...changes, ...overrides };
		if (Object.keys(changes).length === 0 && method !== "deleteTask") return execute();
		const operation: UiOperation = {
			operationId: crypto.randomUUID(),
			taskId,
			baseVersion: approved?.version ?? 0,
			action:
				method === "createTask" ? "create" : method === "deleteTask" ? "cancel" : "update",
			changes,
			origin: "tasknotes_ui",
			phase: "prepared",
			path: approved?.path ?? "",
		};
		this.state.operations.push(operation);
		await this.persist();
		if (method === "createTask")
			args[1] = {
				...(args[1] ?? {}),
				pushgoTaskId: taskId,
				pushgoPreparedPath: async (path: string) => {
					operation.path = path;
					await this.persist();
				},
			};
		let result: unknown;
		try {
			result = await execute();
		} catch (error) {
			operation.error = this.message(error);
			await this.persist();
			throw error;
		}
		const task =
			method === "createTask"
				? (result as { taskInfo: TaskInfo }).taskInfo
				: (result as TaskInfo | undefined);
		if (task) {
			operation.path = task.path;
			if (method === "createTask") operation.changes = this.snapshot(task);
			if (method === "toggleStatus")
				operation.changes = {
					status: task.status,
					completed: this.plugin.statusManager.isCompletedStatus(task.status),
				};
			if (method === "toggleArchive") operation.changes = { archived: task.archived };
		}
		operation.phase = "queued";
		const plan = { ...(approved?.plan ?? this.snapshot(task ?? source)), ...operation.changes };
		this.state.tasks[taskId] = {
			taskId,
			path: operation.path,
			version: approved?.version ?? 0,
			plan,
			cancelled: operation.action === "cancel" || !!approved?.cancelled,
		};
		await this.persist();
		void this.sync().catch(() => {});
		return result;
	}
	async saveTaskOptions(task: TaskInfo, overrides: Partial<PushGoPlan>) {
		const patch = {
			scheduled: overrides.scheduled ?? undefined,
			due: overrides.due ?? undefined,
		};
		const execute = () => this.plugin.taskService.updateTask(task, patch);
		const run = async () => {
			if (this.taskByPath(task.path))
				return this.runUi("updateTask", [task, patch], execute, overrides);
			const updated = await execute();
			return this.adopt(updated, overrides);
		};
		const work = this.commandTail.then(run, run);
		this.commandTail = work.catch(() => {});
		return work;
	}
	async adopt(task: TaskInfo, overrides: Partial<PushGoPlan> = {}) {
		if (this.taskByPath(task.path)) throw new Error("该任务已经接入");
		const taskId = crypto.randomUUID(),
			plan = { ...this.snapshot(task), ...overrides };
		const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) throw new Error("任务笔记不存在");
		const operation: UiOperation = {
			operationId: crypto.randomUUID(),
			taskId,
			baseVersion: 0,
			action: "create",
			changes: plan,
			origin: "tasknotes_ui",
			phase: "prepared",
			path: task.path,
		};
		this.state.operations.push(operation);
		await this.persist();
		await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
			(fm as Record<string, unknown>).pushgo_task_id = taskId;
		});
		operation.phase = "queued";
		this.state.tasks[taskId] = { taskId, path: task.path, version: 0, plan, cancelled: false };
		await this.persist();
		return this.sync();
	}
	async changePlan(
		taskId: string,
		changes: Partial<PushGoPlan>,
		action: "update" | "cancel" | "restore" = "update"
	) {
		const task = this.state.tasks[taskId];
		if (!task) throw new Error("任务未接入");
		this.state.operations.push({
			operationId: crypto.randomUUID(),
			taskId,
			baseVersion: task.version,
			action,
			changes,
			origin: "tasknotes_ui",
			phase: "queued",
			path: task.path,
		});
		task.plan = { ...task.plan, ...changes };
		task.cancelled = action === "cancel" || (task.cancelled && action !== "restore");
		await this.persist();
		return this.sync();
	}
	async discardPrepared(operationId: string) {
		const operation = this.state.operations.find((o) => o.operationId === operationId);
		if (!operation || operation.phase !== "prepared" || operation.submitted)
			throw new Error("只能移除未提交的本地失败操作");
		this.state.operations = this.state.operations.filter((o) => o !== operation);
		await this.persist();
		return "已移除未提交操作，请通过界面重新保存；服务器计划保持原状态。";
	}
	async resolveConflict(operationId: string, keepLocal: boolean) {
		const operation = this.state.operations.find((o) => o.operationId === operationId);
		if (!operation) return;
		const remote = await this.api<RemoteTask>(`/instances/${operation.taskId}`);
		if (keepLocal) {
			operation.operationId = crypto.randomUUID();
			operation.baseVersion = remote.version;
			this.state.tasks[operation.taskId].version = remote.version;
			operation.submitted = false;
			operation.phase = "queued";
			delete operation.error;
		} else {
			this.state.operations = this.state.operations.filter(
				(o) => o.taskId !== operation.taskId
			);
			this.state.tasks[remote.id] = {
				taskId: remote.id,
				path: operation.path,
				version: remote.version,
				plan: remote.plan,
				cancelled: remote.cancelled,
			};
		}
		await this.persist();
		return this.sync();
	}
	async link(taskId: string, path: string) {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || !(await this.plugin.cacheManager.getTaskInfo(path)))
			throw new Error("请选择已经存在的 TaskNotes 任务笔记");
		const other = this.taskByPath(path);
		if (other && other.taskId !== taskId) throw new Error("该笔记已经关联另一个计划");
		const task = this.state.tasks[taskId];
		if (!task) throw new Error("服务器任务未找到");
		task.path = path;
		await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
			(fm as Record<string, unknown>).pushgo_task_id = taskId;
		});
		await this.persist();
		return this.sync();
	}
	private async recoverPrepared() {
		for (const operation of this.state.operations.filter((o) => o.phase === "prepared")) {
			const file = this.plugin.app.vault.getAbstractFileByPath(operation.path);
			let valid = false;
			if (operation.action === "cancel") valid = !file;
			else if (file instanceof TFile) {
				const task = await this.plugin.cacheManager.getTaskInfo(file.path);
				const marker =
					this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.pushgo_task_id;
				valid =
					operation.action === "create"
						? marker === operation.taskId
						: !!task &&
							Object.entries(operation.changes).every(
								([key, value]) =>
									key === "completed" ||
									key === "timezone" ||
									key === "enabled" ||
									key.endsWith("LeadMinutes") ||
									JSON.stringify(
										(task as unknown as Record<string, unknown>)[key] ?? null
									) === JSON.stringify(value)
							);
				if (valid && !this.state.tasks[operation.taskId] && task)
					this.state.tasks[operation.taskId] = {
						taskId: operation.taskId,
						path: file.path,
						version: 0,
						plan: operation.changes as PushGoPlan,
						cancelled: false,
					};
			}
			if (valid) {
				operation.phase = "queued";
				delete operation.error;
			} else operation.error = "本地操作未确认完成，请检查任务后重新通过界面保存。";
		}
		await this.persist();
	}
	sync(): Promise<string> {
		if (this.syncPromise) return this.syncPromise;
		this.syncPromise = this.performSync().finally(() => {
			this.syncPromise = null;
			this.changed();
		});
		return this.syncPromise;
	}
	private async localPath(taskId: string): Promise<string> {
		const matches = this.plugin.app.vault
			.getMarkdownFiles()
			.filter(
				(file) =>
					this.plugin.app.metadataCache.getFileCache(file)?.frontmatter
						?.pushgo_task_id === taskId
			);
		if (matches.length !== 1 || !(await this.plugin.cacheManager.getTaskInfo(matches[0].path)))
			return "";
		return matches[0].path;
	}
	private async performSync() {
		if (this.closed || !this.config.enabled || !this.config.token)
			return "PushGo 同步未启用或尚未登录";
		for (const operation of [...this.state.operations]) {
			if (operation.phase !== "queued") continue;
			if (
				this.state.operations.some(
					(o) =>
						o.taskId === operation.taskId &&
						o !== operation &&
						this.state.operations.indexOf(o) < this.state.operations.indexOf(operation)
				)
			)
				continue;
			const task = this.state.tasks[operation.taskId];
			if (!operation.submitted) {
				operation.baseVersion = task?.version ?? operation.baseVersion;
				operation.submitted = true;
				await this.persist();
			}
			try {
				const { phase, path, error, submitted, ...body } = operation;
				void submitted;
				void phase;
				void path;
				void error;
				const remote = await this.api<RemoteTask>(
					`/workspaces/${this.config.workspaceId}/mutations`,
					body
				);
				if (task) {
					task.version = remote.version;
					const pending = this.state.operations.filter(
						(o) => o !== operation && o.taskId === operation.taskId
					);
					task.plan = pending.reduce((p, o) => ({ ...p, ...o.changes }), remote.plan);
					task.cancelled = remote.cancelled;
				}
				this.state.operations = this.state.operations.filter((o) => o !== operation);
				await this.persist();
			} catch (error) {
				operation.error = this.message(error);
				if (
					operation.error.startsWith("409:") ||
					operation.error.startsWith("410:") ||
					operation.error.startsWith("400:")
				)
					operation.phase = "conflict";
				await this.persist();
				if (operation.phase !== "conflict") throw error;
			}
		}
		let more = true;
		while (more && !this.closed) {
			const result = await this.api<{
				cursor: number;
				hasMore: boolean;
				changes: { kind: string; data: RemoteTask | CheckinRecord }[];
			}>(`/workspaces/${this.config.workspaceId}/sync?cursor=${this.state.cursor}`);
			for (const item of result.changes) {
				if (item.kind === "checkin") {
					const record = item.data as CheckinRecord;
					this.state.records[record.id] = { ...record, ...this.state.records[record.id] };
				} else {
					const remote = item.data as RemoteTask;
					const local = this.state.tasks[remote.id];
					if (
						!this.state.operations.some((o) => o.taskId === remote.id) &&
						(!local || remote.version > local.version)
					)
						this.state.tasks[remote.id] = {
							taskId: remote.id,
							path: local?.path || (await this.localPath(remote.id)),
							version: remote.version,
							plan: remote.plan,
							cancelled: remote.cancelled,
						};
				}
			}
			this.state.cursor = result.cursor;
			more = result.hasMore;
			await this.persist();
		}
		for (const task of Object.values(this.state.tasks)) {
			if (!task.path) task.path = await this.localPath(task.taskId);
		}
		let downloaded = 0,
			written = 0;
		for (const record of Object.values(this.state.records)) {
			if (this.closed) break;
			try {
				const task = this.state.tasks[record.taskId];
				if (
					!task?.path ||
					!(this.plugin.app.vault.getAbstractFileByPath(task.path) instanceof TFile)
				) {
					record.error = "任务笔记缺失，记录待关联";
					continue;
				}
				const dir = validateAttachmentDir(
					this.config.attachmentDir,
					this.plugin.settings.tasksFolder,
					this.plugin.app.vault.configDir
				);
				if (!record.path || !(await this.plugin.app.vault.adapter.exists(record.path))) {
					await this.ensureDir(dir);
					const path = normalizePath(`${dir}/${record.mediaId}.jpg`);
					if (!(await this.plugin.app.vault.adapter.exists(path))) {
						const response = await requestUrl({
							url: `${this.config.serviceUrl}/tasknotes/v1/media/${record.mediaId}`,
							headers: { Authorization: `Bearer ${this.config.token}` },
							throw: false,
						});
						if (response.status !== 200)
							throw new Error(`照片下载失败：${response.status}`);
						await this.verifyMedia(record, response.arrayBuffer);
						await this.plugin.app.vault.createBinary(path, response.arrayBuffer);
						downloaded++;
					} else
						await this.verifyMedia(
							record,
							await this.plugin.app.vault.adapter.readBinary(path)
						);
					record.path = path;
					await this.persist();
				}
				const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
				if (!(file instanceof TFile)) throw new Error("任务笔记已删除");
				const block = checkinBlock(record, record.path);
				let conflict = false;
				await this.plugin.app.vault.process(file, (text) => {
					const start = `<!-- pushgo-checkin:${record.id} -->`,
						end = `<!-- /pushgo-checkin:${record.id} -->`;
					const at = text.indexOf(start);
					if (at >= 0) {
						const until = text.indexOf(end, at);
						if (until < 0 || text.slice(at, until + end.length) !== block)
							conflict = true;
						return text;
					}
					if (record.written) {
						conflict = true;
						return text;
					}
					return text.trimEnd() + "\n\n" + block + "\n";
				});
				if (conflict) throw new Error("打卡区块已被手动修改，保留现有内容，请人工核对");
				if (!record.written) written++;
				record.written = true;
				delete record.error;
				await this.persist();
			} catch (error) {
				record.error = this.message(error);
				await this.persist();
			}
		}
		this.state.lastSync = Date.now();
		await this.persist();
		return `同步完成：下载 ${downloaded} 张照片，写入 ${written} 条记录；待同步 ${this.state.operations.length} 项。`;
	}
	private async verifyMedia(record: CheckinRecord, bytes: ArrayBuffer) {
		if (!record.mediaHash) return;
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const actual = Array.from(new Uint8Array(digest), (b) =>
			b.toString(16).padStart(2, "0")
		).join("");
		if (actual !== record.mediaHash) throw new Error("照片校验失败，保留现有文件，请人工核对");
	}
	private async ensureDir(dir: string) {
		let path = "";
		for (const part of dir.split("/")) {
			path = path ? `${path}/${part}` : part;
			if (!(await this.plugin.app.vault.adapter.exists(path)))
				await this.plugin.app.vault.createFolder(path);
		}
	}
}

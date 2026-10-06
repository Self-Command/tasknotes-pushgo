export type Severity = "low" | "normal" | "high" | "critical";
export type PushGoPlan = {
	title: string;
	scheduled: string | null;
	due: string | null;
	priority: string;
	status: string;
	completed: boolean;
	archived: boolean;
	recurrence: string | null;
	timezone: string;
	startLeadMinutes: number | null;
	endLeadMinutes: number | null;
	enabled: boolean;
};
export type PushGoConfig = {
	enabled: boolean;
	serviceUrl: string;
	token: string;
	workspaceId: string;
	attachmentDir: string;
	timezone: string;
	startLeadMinutes: number;
	endLeadMinutes: number;
	morningTime: string;
	eveningTime: string;
	reportSeverity: Severity;
	reportEmpty: boolean;
	reportsEnabled: boolean;
	retentionDays: number;
	priorityMap: Record<string, Severity>;
};
export const defaultPushGoConfig: PushGoConfig = {
	enabled: false,
	serviceUrl: "",
	token: "",
	workspaceId: "owner",
	attachmentDir: "PushGo附件",
	timezone: "Asia/Shanghai",
	startLeadMinutes: 10,
	endLeadMinutes: 10,
	morningTime: "07:00",
	eveningTime: "22:00",
	reportSeverity: "normal",
	reportEmpty: true,
	reportsEnabled: true,
	retentionDays: 90,
	priorityMap: { none: "normal", low: "low", normal: "normal", high: "high" },
};
export type ApprovedTask = {
	taskId: string;
	path: string;
	version: number;
	plan: PushGoPlan;
	cancelled: boolean;
};
export type UiOperation = {
	operationId: string;
	taskId: string;
	baseVersion: number;
	action: "create" | "update" | "cancel" | "restore";
	changes: Partial<PushGoPlan>;
	origin: "tasknotes_ui";
	phase: "prepared" | "queued" | "conflict";
	path: string;
	error?: string;
	submitted?: boolean;
};
export type CheckinRecord = {
	id: string;
	taskId: string;
	instanceId: string;
	kind: "start" | "end";
	at: number;
	mediaId: string;
	mediaHash?: string;
	note: string;
	path?: string;
	written?: boolean;
	error?: string;
};
export type PushGoState = {
	config: PushGoConfig;
	tasks: Record<string, ApprovedTask>;
	operations: UiOperation[];
	cursor: number;
	records: Record<string, CheckinRecord>;
	lastSync?: number;
	revision?: number;
};
export function validateAttachmentDir(
	raw: string,
	tasksFolder: string,
	configDir?: string
): string {
	const dir = raw.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
	if (
		!dir ||
		dir.startsWith("/") ||
		dir.split("/").some((p) => p === ".." || p === "." || !p) ||
		/[ :*?"<>|[\]]/.test(dir.replace(/ /g, "")) ||
		[...dir].some((c) => c.charCodeAt(0) < 32) ||
		(!!configDir &&
			(dir.toLowerCase() === configDir.toLowerCase() ||
				dir.toLowerCase().startsWith(configDir.toLowerCase() + "/")))
	)
		throw new Error("请使用 vault 内的独立附件目录");
	const tasks = tasksFolder.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
	const lower = dir.toLowerCase();
	if (!tasks || lower === tasks || lower.startsWith(tasks + "/") || tasks.startsWith(lower + "/"))
		throw new Error("附件目录不能与任务目录相同、互相包含或使用 vault 根目录");
	return dir;
}
export function planPatch(
	input: Record<string, unknown>,
	isComplete: (status: string) => boolean
): Partial<PushGoPlan> {
	const patch: Partial<PushGoPlan> = {};
	for (const k of ["title", "priority", "status"] as const)
		if (Object.prototype.hasOwnProperty.call(input, k))
			patch[k] = typeof input[k] === "string" ? input[k] : "";
	for (const k of ["scheduled", "due", "recurrence"] as const)
		if (Object.prototype.hasOwnProperty.call(input, k))
			patch[k] = typeof input[k] === "string" && input[k] ? input[k] : null;
	if (Object.prototype.hasOwnProperty.call(input, "status"))
		patch.completed = isComplete(typeof input.status === "string" ? input.status : "");
	if (Object.prototype.hasOwnProperty.call(input, "archived")) patch.archived = !!input.archived;
	return patch;
}
export function checkinBlock(record: CheckinRecord, path: string): string {
	const note = record.note.replace(/\r?\n/g, " ").replace(/[\\`*_{}[\]<>#|]/g, (c) => "\\" + c);
	return `<!-- pushgo-checkin:${record.id} -->\n### ${record.kind === "start" ? "开始" : "结束"}打卡\n\n- 打卡时间：${new Date(record.at).toISOString()}\n- 结果：成功\n${note ? `- 备注：${note}\n` : ""}\n![[${path}]]\n<!-- /pushgo-checkin:${record.id} -->`;
}

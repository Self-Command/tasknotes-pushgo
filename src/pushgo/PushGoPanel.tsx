import { Modal, TFile } from "obsidian";
import React, { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskInfo } from "../types";
import type { PushGoIntegration } from "../api/pushgo/PushGoIntegration";
import type { PushGoConfig, PushGoPlan } from "./model";
import { Button } from "./components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Badge } from "./components/ui/badge";
import { Switch } from "./components/ui/switch";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";

export class PushGoModal extends Modal {
	private root?: Root;
	constructor(
		private integration: PushGoIntegration,
		private task?: TaskInfo
	) {
		super(integration.plugin.app);
	}
	onOpen() {
		this.contentEl.addClass("tn-pushgo");
		this.root = createRoot(this.contentEl);
		this.root.render(<Panel integration={this.integration} task={this.task} />);
	}
	onClose() {
		this.root?.unmount();
		this.contentEl.empty();
	}
}
function Field({ title, ...props }: { title: string } & React.ComponentProps<typeof Input>) {
	return (
		<div className="space-y-2">
			<Label>{title}</Label>
			<Input aria-label={title} {...props} />
		</div>
	);
}
function Panel({ integration, task }: { integration: PushGoIntegration; task?: TaskInfo }) {
	const [config, setConfig] = useState<PushGoConfig>({ ...integration.config }),
		[password, setPassword] = useState(""),
		[binding, setBinding] = useState({ url: "", channelName: "", channelId: "", password: "" }),
		[message, setMessage] = useState(""),
		[busy, setBusy] = useState(false),
		[, redraw] = useState(0),
		[selected, setSelected] = useState<TaskInfo | undefined>(task);
	useEffect(() => integration.subscribe(() => redraw((v) => v + 1)), [integration]);
	useEffect(() => {
		if (integration.config.token)
			void integration
				.api<{ url?: string; channelName?: string; channelId?: string }>(
					"/integrations/pushgo"
				)
				.then((b) =>
					setBinding({
						url: b.url ?? "",
						channelName: b.channelName ?? "",
						channelId: b.channelId ?? "",
						password: "",
					})
				)
				.catch((error) => setMessage(integration.message(error)));
	}, [integration]);
	async function run(work: () => Promise<unknown>) {
		setBusy(true);
		try {
			const result = await work();
			setMessage(typeof result === "string" ? result : "操作完成");
		} catch (error) {
			setMessage(integration.message(error));
		} finally {
			setBusy(false);
		}
	}
	const update = (key: keyof PushGoConfig, value: unknown) =>
		setConfig({ ...config, [key]: value });
	return (
		<div className="space-y-5">
			<div>
				<h2 className="text-2xl font-semibold">TaskNotes × PushGo</h2>
				<p className="text-sm text-muted-foreground">定时通知 · 独立双卡 · 照片同步</p>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>服务连接</CardTitle>
					<CardDescription>
						先保存地址，再用独立服务账号密码登录。频道密码不作为打卡身份。
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex items-center justify-between">
						<Label>启用 PushGo 集成</Label>
						<Switch
							aria-label="启用 PushGo 集成"
							checked={config.enabled}
							onCheckedChange={(v) => update("enabled", v)}
						/>
					</div>
					<Field
						title="业务服务地址"
						placeholder="https://tasks.example.com"
						value={config.serviceUrl}
						onChange={(e) => update("serviceUrl", e.target.value)}
					/>
					<Field
						title="打卡附件目录（与任务目录分开）"
						value={config.attachmentDir}
						onChange={(e) => update("attachmentDir", e.target.value)}
					/>
					<Field
						title="服务账号密码（不保存）"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
					<div className="flex flex-wrap gap-3">
						<Button
							disabled={busy}
							onClick={() => void run(() => integration.configure(config))}
						>
							保存连接设置
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									await integration.configure(config);
									await integration.login(password);
									setPassword("");
									setConfig({ ...integration.config });
									return "登录成功，可保存默认值并绑定频道";
								})
							}
						>
							登录并配对
						</Button>
						<Button
							variant="outline"
							disabled={busy || !integration.config.token}
							onClick={() =>
								void run(async () => {
									await integration.disconnect();
									setConfig({ ...integration.config });
									return "当前设备令牌已撤销，服务器计划继续保留";
								})
							}
						>
							撤销当前配对
						</Button>
					</div>
					<p className="text-sm text-muted-foreground">
						{integration.config.token ? "已配对" : "尚未配对"} ·
						本地改动须收到服务器确认才算已安排。关闭集成不会取消服务器已有计划。
					</p>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>提醒和早晚统计</CardTitle>
					<CardDescription>
						开始 = scheduled；结束 = due。到点立即关闭，两张卡独立。
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4 sm:grid-cols-2">
					{(
						[
							["startLeadMinutes", "开始提前分钟", "number"],
							["endLeadMinutes", "结束提前分钟", "number"],
							["timezone", "时区", "text"],
							["morningTime", "早报时间", "time"],
							["eveningTime", "晚报时间", "time"],
							["retentionDays", "服务器照片保留天数", "number"],
						] as const
					).map(([key, title, type]) => (
						<Field
							key={key}
							title={title}
							type={type}
							min={1}
							value={String(config[key])}
							onChange={(e) =>
								update(
									key,
									type === "number" ? Number(e.target.value) : e.target.value
								)
							}
						/>
					))}
					<div className="flex items-center justify-between">
						<Label>启用早晚统计</Label>
						<Switch
							checked={config.reportsEnabled}
							onCheckedChange={(v) => update("reportsEnabled", v)}
						/>
					</div>
					<div className="flex items-center justify-between">
						<Label>无任务也发送统计</Label>
						<Switch
							checked={config.reportEmpty}
							onCheckedChange={(v) => update("reportEmpty", v)}
						/>
					</div>
					<div className="space-y-2">
						<Label>日报通知优先级</Label>
						<NativeSelect
							aria-label="日报通知优先级"
							value={config.reportSeverity}
							onChange={(e) => update("reportSeverity", e.target.value)}
						>
							{["low", "normal", "high", "critical"].map((level) => (
								<NativeSelectOption key={level} value={level}>
									{level}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div className="space-y-3">
						<Label>任务优先级 → 通知优先级</Label>
						{Array.from(
							new Set([
								...Object.keys(config.priorityMap),
								...integration.plugin.priorityManager
									.getAllPriorities()
									.map((p) => p.value),
							])
						).map((priority) => (
							<div key={priority} className="flex items-center justify-between gap-3">
								<Label>{priority}</Label>
								<NativeSelect
									aria-label={priority + " 通知级别"}
									value={config.priorityMap[priority] ?? "normal"}
									onChange={(e) =>
										update("priorityMap", {
											...config.priorityMap,
											[priority]: e.target.value,
										})
									}
								>
									{["low", "normal", "high", "critical"].map((level) => (
										<NativeSelectOption key={level} value={level}>
											{level}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</div>
						))}
					</div>
					<Button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								await integration.configure(config);
								await integration.saveDefaults();
								return "默认值已保存；已开放实例保留原窗口。";
							})
						}
					>
						保存默认值到服务器
					</Button>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>PushGo 网关和频道</CardTitle>
					<CardDescription>
						网关 token 由服务部署配置；频道 ID 从 PushGo
						复制。密码提交到服务端加密保存，不写入任务。
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{(["url", "channelName", "channelId", "password"] as const).map((key) => (
						<Field
							key={key}
							title={
								{
									url: "API 网关地址",
									channelName: "频道名称",
									channelId: "频道 ID",
									password: "频道密码",
								}[key]
							}
							type={key === "password" ? "password" : "text"}
							value={binding[key]}
							onChange={(e) => setBinding({ ...binding, [key]: e.target.value })}
						/>
					))}
					<div className="flex flex-wrap gap-3">
						<Button
							disabled={busy}
							onClick={() =>
								void run(async () => {
									await integration.api("/integrations/pushgo", binding, "PUT");
									setBinding({ ...binding, password: "" });
									return "频道已绑定，请点击发送测试验证发送权限。";
								})
							}
						>
							绑定频道
						</Button>
						<Button
							disabled={busy}
							variant="outline"
							onClick={() =>
								void run(() => integration.api("/integrations/pushgo/test", {}))
							}
						>
							发送测试通知
						</Button>
					</div>
				</CardContent>
			</Card>
			{selected && (
				<TaskOptions
					key={selected.path}
					integration={integration}
					task={selected}
					run={run}
					busy={busy}
				/>
			)}
			<Card>
				<CardHeader>
					<CardTitle>同步中心</CardTitle>
					<CardDescription>
						待同步 {integration.state.operations.length} 项 · 上次同步{" "}
						{integration.state.lastSync
							? new Date(integration.state.lastSync).toLocaleString()
							: "暂无"}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<Button disabled={busy} onClick={() => void run(() => integration.sync())}>
						拉取打卡记录和照片 / 重试同步
					</Button>
					{integration.state.operations.map((o) => (
						<div className="rounded-xl border p-3 space-y-2" key={o.operationId}>
							<p className="text-sm">
								{o.path || o.taskId} · {o.action} · {o.phase}
							</p>
							{o.error && <p className="text-sm text-destructive">{o.error}</p>}
							{o.phase === "prepared" && o.error && (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										void run(() => integration.discardPrepared(o.operationId))
									}
								>
									移除未提交操作后重新保存
								</Button>
							)}
							{o.phase === "conflict" && (
								<div className="flex gap-2">
									<Button
										size="sm"
										disabled={busy}
										onClick={() =>
											void run(() =>
												integration.resolveConflict(o.operationId, true)
											)
										}
									>
										按最新版本重试本次改动
									</Button>
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() =>
											void run(() =>
												integration.resolveConflict(o.operationId, false)
											)
										}
									>
										采用服务器计划
									</Button>
								</div>
							)}
						</div>
					))}
					{Object.values(integration.state.records)
						.filter((r) => r.error)
						.map((r) => (
							<p className="text-sm text-destructive" key={r.id}>
								{r.kind === "start" ? "开始" : "结束"}记录：{r.error}
							</p>
						))}
					<div className="space-y-3">
						{Object.values(integration.state.tasks).map((t) => (
							<div key={t.taskId} className="rounded-xl border p-3 space-y-2">
								<div className="flex justify-between gap-3">
									<p className="font-medium">{t.plan.title}</p>
									<Badge variant="secondary">
										{t.cancelled ? "已取消" : `版本 ${t.version}`}
									</Badge>
								</div>
								<p className="text-sm text-muted-foreground">
									{t.plan.scheduled ?? "开始待配置"} —{" "}
									{t.plan.due ?? "结束待配置"}
								</p>
								<div className="flex flex-wrap gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={busy}
										onClick={() =>
											void run(async () => {
												const current =
													await integration.plugin.cacheManager.getTaskInfo(
														t.path
													);
												if (!current)
													throw new Error(
														"笔记缺失，请打开要关联的任务，再点击关联当前笔记"
													);
												setSelected(current);
											})
										}
									>
										设置任务
									</Button>
									<Button
										variant="outline"
										size="sm"
										disabled={busy}
										onClick={() =>
											void run(() =>
												integration.changePlan(
													t.taskId,
													{},
													t.cancelled ? "restore" : "cancel"
												)
											)
										}
									>
										{t.cancelled ? "恢复计划" : "取消计划"}
									</Button>
									{!integration.plugin.app.vault.getAbstractFileByPath(
										t.path
									) && (
										<Button
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() =>
												void run(async () => {
													const current =
														integration.plugin.app.workspace.getActiveFile();
													if (!current)
														throw new Error("请先打开一个任务笔记");
													return integration.link(t.taskId, current.path);
												})
											}
										>
											关联当前笔记
										</Button>
									)}
								</div>
							</div>
						))}
					</div>
				</CardContent>
			</Card>
			{message && (
				<Alert>
					<AlertTitle>操作结果</AlertTitle>
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
function TaskOptions({
	integration,
	task,
	run,
	busy,
}: {
	integration: PushGoIntegration;
	task: TaskInfo;
	run: (work: () => Promise<unknown>) => Promise<void>;
	busy: boolean;
}) {
	const approved = Object.values(integration.state.tasks).find((t) => t.path === task.path);
	const source = approved?.plan;
	const [start, setStart] = useState(source?.scheduled ?? task.scheduled ?? ""),
		[end, setEnd] = useState(source?.due ?? task.due ?? ""),
		[startLead, setStartLead] = useState(source?.startLeadMinutes ?? null),
		[endLead, setEndLead] = useState(source?.endLeadMinutes ?? null);
	async function save() {
		const file = integration.plugin.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) throw new Error("任务笔记不存在");

		const overrides: Partial<PushGoPlan> = {
			scheduled: start || null,
			due: end || null,
			startLeadMinutes: startLead,
			endLeadMinutes: endLead,
		};
		return integration.saveTaskOptions(task, overrides);
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					{approved ? "任务打卡设置" : "接入已有任务"} · {task.title}
				</CardTitle>
				<CardDescription>
					此处显示服务器批准的计划。直接修改 MD
					不更新提醒；点击保存会明确提交这里的时间。循环任务首版不支持。
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4 sm:grid-cols-2">
				<Field
					title="开始时间（scheduled）"
					type="datetime-local"
					value={start}
					onChange={(e) => setStart(e.target.value)}
				/>
				<Field
					title="结束时间（due）"
					type="datetime-local"
					value={end}
					onChange={(e) => setEnd(e.target.value)}
				/>
				<Field
					title="开始提前分钟（留空用默认）"
					type="number"
					min={1}
					max={1440}
					value={startLead ?? ""}
					onChange={(e) => setStartLead(e.target.value ? Number(e.target.value) : null)}
				/>
				<Field
					title="结束提前分钟（留空用默认）"
					type="number"
					min={1}
					max={1440}
					value={endLead ?? ""}
					onChange={(e) => setEndLead(e.target.value ? Number(e.target.value) : null)}
				/>
				<p className="text-sm text-muted-foreground">
					开始窗口：
					{start
						? `${start} 前 ${startLead ?? integration.config.startLeadMinutes} 分钟至该时刻`
						: "待配置"}
					<br />
					结束窗口：
					{end
						? `${end} 前 ${endLead ?? integration.config.endLeadMinutes} 分钟至该时刻`
						: "待配置"}
				</p>
				<Button disabled={busy} onClick={() => void run(save)}>
					{approved ? "保存任务计划" : "确认接入并保存"}
				</Button>
			</CardContent>
		</Card>
	);
}

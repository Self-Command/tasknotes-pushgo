import type TaskNotesPlugin from "../main";
import type { TaskService } from "../services/TaskService";
/** This adapter is used only at reviewed TaskNotes visual interaction entry points. */
export function uiTaskService(plugin: TaskNotesPlugin): TaskService {
	return plugin.pushgo?.uiService() ?? plugin.taskService;
}
export function uiPlugin(plugin: TaskNotesPlugin): TaskNotesPlugin {
	if (!plugin.pushgo) return plugin;
	return new Proxy(plugin, {
		get(target, key) {
			const value = Reflect.get(target, key) as unknown;
			if (key === "updateTaskProperty")
				return (...args: unknown[]) => {
					args[3] = { ...(args[3] ?? {}), pushgoOrigin: "tasknotes_ui" };
					return Reflect.apply(value as (...items: unknown[]) => unknown, target, args);
				};
			if (key === "toggleTaskArchive" || key === "toggleTaskStatus")
				return (...args: unknown[]) =>
					Reflect.apply(value as (...items: unknown[]) => unknown, target, [
						args[0],
						true,
					]);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

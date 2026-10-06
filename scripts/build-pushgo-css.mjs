import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import postcss from "postcss";
execFileSync(
	process.execPath,
	[
		"node_modules/@tailwindcss/cli/dist/index.mjs",
		"-i",
		"src/pushgo/theme.css",
		"-o",
		".pushgo-build.css",
		"--minify",
	],
	{ stdio: "inherit" }
);
const root = postcss.parse(readFileSync(".pushgo-build.css", "utf8"));
root.walkRules((rule) => {
	let parent = rule.parent;
	while (parent) {
		if (parent.type === "atrule" && /keyframes$/.test(parent.name)) return;
		parent = parent.parent;
	}
	rule.selector = [
		...new Set(
			rule.selectors.map((s) =>
				s.includes(".tn-pushgo")
					? s
					: s === ":root" || s === ":host"
						? ".tn-pushgo"
						: `.tn-pushgo ${s}`
			)
		),
	].join(",");
});
root.walkDecls((d) => {
	if (d.prop === "text-decoration-line") d.prop = "text-decoration";
	if (d.prop === "text-decoration-thickness") {
		d.remove();
		return;
	}
	d.important = false;
	d.value = d.value.replace(
		/#([a-fA-F0-9]{3}|[a-fA-F0-9]{4})\b/g,
		(_, v) => "#" + [...v].map((c) => c + c).join("")
	);
});
function mergeDuplicates(container) {
	const seen = new Map();
	for (const node of [...(container.nodes ?? [])]) {
		if (node.type === "rule") {
			if (seen.has(node.selector)) {
				seen.get(node.selector).append(...node.nodes);
				node.remove();
			} else seen.set(node.selector, node);
		} else if (node.nodes) mergeDuplicates(node);
	}
}
mergeDuplicates(root);
writeFileSync(".pushgo-build.css", root.toString());

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const files = ["GeekDash.html", "project-detail.html", "data-manage.html", "settings.html", "project-status-summary.html", "chip-statistics.html"];
for (const name of files) {
  const source = fs.readFileSync(path.join(root, name), "utf8");
  for (const [, script] of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(script);
}
const values = new Map();
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-10-09T12:00:00"])); }
}
const context = { Date: TestDate, console, setTimeout, clearTimeout, localStorage: {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
} };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "projects-data.js"), "utf8"), context);
const db = context.PROJECT_DB;
assert.equal(db.APP_VERSION, "V1.051");
for (const [dueDate, status, expected] of [
  ["2026-10-08", "进行中", "overdue"], ["2026-10-09", "进行中", "normal"],
  ["2026-10-10", "暂缓", "normal"], ["2026-10-08", "提案中", "overdue"],
  ["", "进行中", "unknown"], ["-", "进行中", "unknown"],
  ["2026-02-30", "进行中", "unknown"], ["2026-10-08", "已结案", "closed"],
]) assert.equal(db.projectDelayState({ dueDate, status, isDelayed: true }), expected);
assert.equal(db.hasDelay({ status: "进行中", dueDate: "2026-10-10", delays: [{ id: 1 }], isDelayed: true }), false);
const project = { id: 9001, name: "1051 验证项目", summary: "简介\n第二行", status: "进行中", statusDesc: "旧状态", statusHistory: [{ date: "2026-09-01", text: "旧版混合原文" }] };
assert.equal(db.updateStatusDescription(project, "新状态\r\n第二行", "2026-10-09 12:00"), true);
assert.equal(project.statusDesc, "新状态\n第二行");
assert.equal(project.statusDescHistory.length, 2);
assert.equal(project.statusDescHistory[0].date, "");
assert.equal(project.statusDescLegacyHistoryCount, 1);
assert.equal(db.updateStatusDescription(project, "新状态\n第二行"), false);
assert.equal(db.updateStatusDescription(project, "", "2026-10-09 12:01"), true);
const restored = db.validateBackupData({ version: 2, projects: [project] }).projects[0];
assert.equal(restored.summary, project.summary);
assert.equal(restored.statusDescHistory.length, 3);
assert.equal(restored.statusDescHistory[2].text, "");
assert.equal(restored.statusHistory[0].text, "旧版混合原文");
const old = db.validateBackupData({ projects: [{ id: 2, name: "旧项目", statusDesc: "已有状态" }] }).projects[0];
assert.equal(old.summary, "");
assert.equal(db.statusDescriptionHistory(old)[0].text, "已有状态");
assert.equal(db.normalizeRisks([{ id: 1, content: "风险", updatedAt: "今天" }])[0].updatedAt, "今天");
assert.equal(db.normalizeChanges([{ id: 1, content: "变更", updatedAt: "今天" }])[0].updatedAt, "今天");
const build = spawnSync(process.execPath, [path.join(root, "scripts/build-standalone.mjs"), "--check", root], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr || build.stdout);
console.log("V1.051：六页语法、延期边界、状态历史、旧数据兼容和导出构建检查通过。");

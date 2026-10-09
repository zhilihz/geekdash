import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(process.env.USERPROFILE, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const releases = process.argv[2];
if (!releases) throw new Error("请传入附件解压后的 releases 目录");
const base = process.argv[3] || "http://127.0.0.1:41870";
const output = path.resolve(import.meta.dirname, "../../test-results/local-v1051-followup");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const checks = [];
try {
  for (const version of ["1049", "1050", ...(process.argv[4] ? ["1051"] : [])]) {
    const source = await fs.readFile(version === "1051" ? process.argv[4] : path.join(releases, "GeekDash" + version, "projects-data.js"), "utf8");
    const values = new Map();
    const legacy = { console, Date, setTimeout, clearTimeout, localStorage: {
      getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)
    } };
    legacy.window = legacy;
    vm.createContext(legacy); vm.runInContext(source, legacy);
    const old = legacy.PROJECT_DB;
    const project = { id: 910001, name: "旧版兼容验收", customer: "合成客户", status: "暂缓", priority: "高", signal: "黄灯", statusDesc: "原状态 @旧工程师", statusHistory: [{ date: "2026-08-01 10:00", text: "旧原文\n第二行" }],
      proposalDate: "2026-08-01", dueDate: "2026-10-08", chips: ["合成芯片"], hwOwner: "旧工程师", swOwner: "-", pm: "原经理", participants: ["旧工程师"],
      stages: old.normalizeStages([{ done: true, note: "原里程碑评述", doneDate: "2026-08-02", days: "19", startDate: "2026-08-01", expectedEndDate: "2026-08-20" }]),
      risks: [{ id: 1, content: "旧预警", level: "高", createdAt: "2026-08-01", resolved: true, resolvedAt: "2026-08-02", resolveMethod: "旧解除方法" }],
      changes: [{ id: 1, source: "客户", content: "旧需求变更", status: "拒绝", reason: "原理由", createdAt: "2026-08-01" }],
      delays: [{ id: 1, date: "2026-08-03", reason: "旧延期理由", newTargetDate: "2026-12-01" }], isDelayed: true, customLegacyField: "扩展字段保留" };
    // 用附件中相应版本的真实导出实现生成旧格式文件，业务内容均为合成夹具。
    old.saveBusinessDataAtomic({ projects: [project], engineers: [{ id: 1, name: "旧工程师", role: "硬件/软件" }, { id: 2, name: "旧自动新增工程师", role: "" }], customers: [{ id: 1, name: "合成客户", tags: ["ODM 工厂"] }], chips: [{ id: 1, name: "合成芯片" }] });
    const payload = JSON.parse(JSON.stringify(old.buildBackupData()));
    const expected = JSON.parse(JSON.stringify(old.validateBackupData(payload).projects[0]));
    // 1051新增编辑时间；旧记录没有编辑时间，规范化后应为空。
    expected.risks.forEach(r => r.updatedAt = "");
    expected.changes.forEach(c => c.updatedAt = "");
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(base + "/GeekDash.html");
    const filename = "compat-" + version + ".json";
    await page.evaluate(async ({ filename, payload }) => {
      localStorage.clear(); sessionStorage.clear();
      const handle = await (await navigator.storage.getDirectory()).getFileHandle(filename, { create: true });
      const writer = await handle.createWritable(); await writer.write(JSON.stringify(payload)); await writer.close();
      await PROJECT_DB.openProjectDatabaseHandle(handle);
      localStorage.setItem("hw_project_board_mode", "manage");
    }, { filename, payload });
    const loaded = await page.evaluate(() => PROJECT_DB.load()[0]);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(loaded[key], value, version + " 打开后字段 " + key);
    assert.equal(loaded.summary, "");
    await page.goto(base + "/project-detail.html?id=910001");
    await page.locator("#f-summary").fill("1051 新简介");
    await page.locator("#f-statusdesc").fill("新状态 @兼容新工程师");
    await page.locator("#f-statusdesc").press("Enter");
    await page.locator("#save-btn").click();
    await page.waitForFunction(() => PROJECT_DB.databaseSession()?.state === "saved");
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(base + "/GeekDash.html");
    await page.evaluate(async filename => PROJECT_DB.openProjectDatabaseHandle(await (await navigator.storage.getDirectory()).getFileHandle(filename)), filename);
    await page.reload();
    const readback = await page.evaluate(() => ({ project: PROJECT_DB.load()[0], engineers: PROJECT_DB.loadEngineers(), backup: PROJECT_DB.buildBackupData() }));
    for (const [key, value] of Object.entries(expected)) {
      if (!["summary", "statusDesc", "statusHistory"].includes(key)) assert.deepEqual(readback.project[key], value, version + " 回读字段 " + key);
    }
    assert.equal(readback.project.summary, "1051 新简介");
    assert.equal(readback.project.statusDescHistory[0].text, "原状态 @旧工程师");
    assert.deepEqual(readback.project.statusHistory[0], expected.statusHistory[0]);
    assert.equal(readback.engineers.find(e => e.name === "旧工程师").role, "硬件/软件");
    assert.equal(readback.engineers.some(e => e.name === "兼容新工程师"), false);
    assert.equal(readback.engineers.find(e => e.name === "旧自动新增工程师").role, "");
    assert.equal(readback.backup.projects[0].customLegacyField, "扩展字段保留");
    assert.deepEqual(errors, []);
    checks.push({ version: "V1." + version.slice(1), sourceSha256: createHash("sha256").update(source).digest("hex"), legacySchema: payload.version, projectFieldsPreserved: Object.keys(expected).length, opened: true, edited: true, savedToRealFile: true, clearedCacheAndReopened: true, oldRolesAndHistoryPreserved: true });
    await context.close();
  }
  await fs.writeFile(path.join(output, "legacy-compatibility.json"), JSON.stringify({ passed: true, browser: "Microsoft Edge", storage: "OPFS真实文件句柄", checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally { await browser.close(); }

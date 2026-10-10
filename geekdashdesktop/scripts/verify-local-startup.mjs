import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(process.env.USERPROFILE, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, "..");
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(import.meta.dirname, "../../test-results/local-v1051-startup");
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(output, "edge-profile-"));
await fs.mkdir(path.join(profile, "Default"));
// 只在独立验收profile预授文件读写权限，不改用户浏览器；文件API和磁盘写入均为真实调用。
await fs.writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({ profile: { default_content_setting_values: { file_system_write_guard: 1, file_system_read_guard: 1 } } }));
const filename = path.join(profile, "synthetic-database.json");
await fs.writeFile(filename, JSON.stringify({ version: 2, projects: [{ id: 980001, name: "1051直接HTML验收", status: "进行中", priority: "高", signal: "黄灯", summary: "磁盘原数据", statusDesc: "磁盘原状态 @验收人" }], engineers: [], customers: [], productLines: [], apps: [], tags: [], groups: [], chips: [], company: { namePrefix: "合成验收" } }));
let context;
const errors = [], checks = [];
const url = name => pathToFileURL(path.join(root, name)).href;
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: "msedge", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url("GeekDash.html"));
  await page.waitForFunction(() => document.querySelector("#welcome-version").textContent === PROJECT_DB.APP_VERSION);
  return page;
}
try {
  let page = await launch();
  assert.equal(await page.locator("#welcome-overlay").isVisible(), true);
  await page.evaluate(() => {
    document.addEventListener("dragover", event => event.preventDefault());
    document.addEventListener("drop", async event => {
      event.preventDefault();
      try {
        const handle = await event.dataTransfer.items[0].getAsFileSystemHandle();
        await PROJECT_DB.openProjectDatabaseHandle(handle);
        globalThis.testOpened = true;
      } catch (error) { globalThis.testOpenError = error.message; }
    });
  });
  const cdp = await context.newCDPSession(page);
  for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: 400, y: 400, data: { items: [], files: [filename], dragOperationsMask: 1 } });
  await page.waitForFunction(() => globalThis.testOpened || globalThis.testOpenError);
  assert.equal(await page.evaluate(() => globalThis.testOpenError), undefined);
  await page.evaluate(() => localStorage.setItem("hw_project_board_mode", "manage"));
  await page.reload();
  assert.equal(await page.locator("#welcome-overlay").isVisible(), false);
  await page.goto(url("project-detail.html") + "?id=980001");
  await page.locator("#f-summary").fill("直接HTML写入真实磁盘");
  await page.locator("#save-btn").click();
  await page.waitForFunction(() => PROJECT_DB.databaseSession().state === "saved");
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).projects[0].summary, "直接HTML写入真实磁盘");
  checks.push("直接file://首次选择真实磁盘文件，详情保存实际写回，跨HTML页面共享数据");
  const sameSession = JSON.parse(await fs.readFile(filename, "utf8"));
  sameSession.projects[0].summary = "原标签页重新读取磁盘";
  await fs.writeFile(filename, JSON.stringify(sameSession));
  await page.goto(url("GeekDash.html"));
  await page.waitForFunction(() => document.querySelector("#welcome-version").textContent === PROJECT_DB.APP_VERSION);
  assert.ok((await page.locator('.card[data-id="980001"]').innerText()).includes("原标签页重新读取磁盘"), JSON.stringify(await page.evaluate(() => ({ session: PROJECT_DB.databaseSession(), summary: PROJECT_DB.load()[0].summary }))));
  checks.push("原标签页返回首页仍读取文件最新内容，不被旧sessionStorage跳过");
  await context.close(); context = null;
  const external = JSON.parse(await fs.readFile(filename, "utf8"));
  external.projects[0].summary = "外部文件的新内容";
  await fs.writeFile(filename, JSON.stringify(external));
  page = await launch();
  assert.equal(await page.locator("#welcome-overlay").isVisible(), false);
  assert.ok((await page.locator('.card[data-id="980001"]').innerText()).includes("外部文件的新内容"));
  assert.ok((await page.locator("#database-status").innerText()).includes("synthetic-database.json"));
  await page.goto(url("project-status-summary.html"));
  assert.equal(await page.locator('#tbody tr[data-id="980001"]').count(), 1);
  checks.push("关闭整个Edge进程后重新启动，自动恢复同一文件并读取磁盘最新内容，报表消费一致");
  await page.goto(url("GeekDash.html"));
  await page.waitForFunction(() => document.querySelector("#welcome-version").textContent === PROJECT_DB.APP_VERSION);
  await page.evaluate(() => {
    const projects = PROJECT_DB.load(); projects[0].summary = "待恢复的本机修改";
    PROJECT_DB.saveBusinessDataAtomic({ projects });
    PROJECT_DB.databaseSession();
    // 模拟授权失效且页面结束时有未写回内容，保留产品实际持久缓存。
    const metadata = PROJECT_DB.databaseSession();
    metadata.writable = false; metadata.pendingChanges = true; metadata.state = "pending";
    localStorage.setItem("hw_project_board_database_last_v1", JSON.stringify(metadata));
  });
  // 立即关闭，避免500ms自动保存计时器完成；回读以实际文件为准。
  await context.close(); context = null;
  page = await launch();
  assert.ok((await page.locator('.card[data-id="980001"]').innerText()).includes("待恢复的本机修改"));
  assert.equal(await page.locator("#database-resume").isVisible(), true);
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).projects[0].summary, "外部文件的新内容");
  await page.locator("#database-resume").click();
  await page.waitForFunction(() => PROJECT_DB.databaseSession().state === "saved");
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).projects[0].summary, "待恢复的本机修改");
  checks.push("重启保留未写回修改，不用旧磁盘覆盖；明确继续保存后真实写回原文件");
  await page.waitForTimeout(300);
  await context.close(); context = null;
  const prefsPath = path.join(profile, "Default/Preferences");
  async function writeGuard(setting) {
    const prefs = JSON.parse(await fs.readFile(prefsPath, "utf8"));
    prefs.profile.default_content_setting_values.file_system_write_guard = setting;
    await fs.writeFile(prefsPath, JSON.stringify(prefs));
  }
  await writeGuard(2);
  page = await launch();
  assert.equal(await page.locator("#welcome-overlay").isVisible(), false);
  assert.equal(await page.locator("#database-resume").isVisible(), true);
  assert.equal(await page.evaluate(() => PROJECT_DB.databaseSession().writable), false);
  await page.goto(url("project-detail.html") + "?id=980001");
  await page.locator("#f-summary").fill("权限撤销后保留的修改");
  await page.locator("#save-btn").click();
  assert.equal(await page.evaluate(() => PROJECT_DB.databaseSession().state), "pending");
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).projects[0].summary, "待恢复的本机修改");
  await context.close(); context = null;
  page = await launch();
  assert.ok((await page.locator('.card[data-id="980001"]').innerText()).includes("权限撤销后保留的修改"));
  assert.equal(await page.locator("#database-resume").innerText(), "授权并保存到原文件");
  await context.close(); context = null;
  await writeGuard(1);
  page = await launch();
  await page.locator("#database-resume").click();
  await page.waitForFunction(() => PROJECT_DB.databaseSession().state === "saved");
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).projects[0].summary, "权限撤销后保留的修改");
  checks.push("实际撤销测试profile文件写权限仍进入原看板，编辑/重启保留待保存内容，恢复权限后写回原文件");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, "direct-html-board.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "startup.json"), JSON.stringify({ passed: true, protocol: "file://", browser: "Microsoft Edge", fileStorage: "真实Windows磁盘JSON与FileSystemFileHandle", permissions: "独立验收profile预授读写；实际首次文件选择/授权由用户完成", checks, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally { if (context) await context.close(); }

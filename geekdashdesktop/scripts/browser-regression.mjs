import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require("playwright"); }
  catch (firstError) {
    const bundled = path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright");
    try { return require(bundled); }
    catch { throw firstError; }
  }
}

const { chromium } = loadPlaywright();
const baseUrl = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const results = [];
async function launchLocalBrowser() {
  const attempts = [{ headless: true, channel: "msedge" }];
  let lastError;
  for (const options of attempts) {
    try { return await chromium.launch(options); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}
const browser = await launchLocalBrowser();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.setDefaultNavigationTimeout(7000);
page.on("dialog", (dialog) => dialog.accept());

async function run(name, work) {
  const pageErrors = [];
  const onError = (error) => pageErrors.push(error.message);
  page.on("pageerror", onError);
  try {
    await work();
    if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
    results.push({ name, status: "passed" });
  } catch (error) {
    results.push({ name, status: "failed", error: error.message });
  } finally {
    page.off("pageerror", onError);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReturnedFocus(source, label) {
  try {
    await page.waitForFunction(({ id, scrollY }) => document.activeElement?.dataset?.id === String(id) && window.scrollY >= scrollY - 2, source);
  } catch {
    const actual = await page.evaluate(() => ({ url: location.href, activeTag: document.activeElement?.tagName, activeId: document.activeElement?.dataset?.id, scrollY: window.scrollY, context: sessionStorage.getItem("hw_project_board_detail_return_context") }));
    throw new Error(`${label} 未恢复焦点或滚动位置：${JSON.stringify(actual)}`);
  }
}

async function resetMain() {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("hw_project_board_welcome_dismissed", "1");
    sessionStorage.setItem(PROJECT_DB.DATABASE_SESSION_KEY, JSON.stringify({ mode: "file", name: "自动化测试数据库.geekdash.json", state: "saved", openedAt: "测试会话" }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#card-grid .card").first().waitFor();
}

async function disableDirectoryPickerForDownloadTest() {
  await page.evaluate(() => {
    try { Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }); }
    catch { try { window.showDirectoryPicker = undefined; } catch {} }
  });
}

await run("欢迎页强制打开数据库且业务变更自动回写当前文件", async () => {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => sessionStorage.removeItem(PROJECT_DB.DATABASE_SESSION_KEY));
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await page.locator("#welcome-overlay").evaluate(element => getComputedStyle(element).display) === "flex", "新会话未强制显示项目数据库入口");
  expect(await page.locator("#database-open, #database-migrate, #database-new").count() === 3, "欢迎页缺少打开、迁移或新建数据库入口");
  const result = await page.evaluate(async () => {
    const writes = [];
    const initial = PROJECT_DB.buildBackupData();
    const handle = {
      name: "自动化打开数据库.geekdash.json",
      async getFile() { return { name: this.name, async text() { return JSON.stringify(initial); } }; },
      async createWritable() { return { async write(value) { writes.push(String(value)); }, async close() {} }; }
    };
    await PROJECT_DB.openProjectDatabaseHandle(handle);
    const projects = PROJECT_DB.load();
    projects[0].statusDesc = "数据库自动保存验证";
    PROJECT_DB.save(projects);
    await new Promise(resolve => setTimeout(resolve, 750));
    return { session: PROJECT_DB.databaseSession(), writes };
  });
  expect(result.session?.name === "自动化打开数据库.geekdash.json" && result.session?.state === "saved", "数据库会话状态未记录文件名或保存结果");
  expect(result.writes.some(text => text.includes("数据库自动保存验证")), "业务修改未自动回写当前数据库文件");
});

await run("首页加载、默认视图与版本", async () => {
  await resetMain();
  expect(await page.locator('#view-switch button[data-view="active"]').getAttribute("class").then((v) => v.includes("active")), "默认视图不是进行中");
  expect(await page.evaluate(() => window.APP_VERSION), "页面未加载共享版本");
  expect((await page.locator("#card-grid .card").count()) > 0, "首页没有项目卡片");
  const branding = await page.evaluate(() => {
    const company = PROJECT_DB.loadCompany();
    return { company, title: document.title, heading: document.querySelector("#board-title-text")?.textContent, subtitle: document.querySelector("#board-subtitle")?.textContent };
  });
  const expectedTitle = `${branding.company.namePrefix || "智能硬件"}项目看板系统`;
  expect(branding.title === expectedTitle && branding.heading === expectedTitle, "企业名称前缀没有应用到页面标题");
  expect(!branding.company.shortName || branding.subtitle.includes(branding.company.shortName), "企业简称没有应用到页面副标题");
});

await run("首页统计卡片快速筛选继承当前范围并显示量产维护标识", async () => {
  await resetMain();
  const expected = await page.evaluate(() => {
    const card = document.querySelector('#stats-bar .quick-stat[data-quick="priority-high"]');
    if (!card) throw new Error("未找到高优先级快速筛选卡片");
    return String(card.dataset.ids || "").split(",").filter(Boolean).map(Number);
  });
  await Promise.all([
    page.waitForURL(/project-status-summary\.html\?quick=priority-high/),
    page.locator('#stats-bar .quick-stat[data-quick="priority-high"]').click(),
  ]);
  expect(await page.locator("#quick-context.show").count() === 1, "快速筛选结果页未显示继承范围说明");
  const actual = await page.locator("#tbody tr[data-id]").evaluateAll(rows => rows.map(row => Number(row.dataset.id)).sort((a, b) => a - b));
  expect(JSON.stringify(actual) === JSON.stringify(expected.sort((a, b) => a - b)), "快速筛选结果未继承首页统计卡片命中范围");
  expect(await page.locator("#tbody .row-check:checked").count() === actual.length, "快速筛选结果未默认勾选全部命中项目");
  expect(await page.locator("#select-export-folder-btn, #export-image-btn, #export-md-btn, #export-csv-btn, #export-pdf-btn").count() === 5, "快速筛选结果缺少导出或一键存图操作");
  const quickRow = page.locator("#tbody tr[data-id]").first();
  const quickProjectId = await quickRow.getAttribute("data-id");
  await quickRow.locator(".hide-btn").click();
  expect(await page.locator("#tbody tr[data-id]").count() === actual.length - 1, "快速筛选的隐藏按钮未在当前结果页生效");
  await page.locator("#show-hidden").click();
  expect(await page.locator("#tbody tr[data-id]").count() === actual.length, "快速筛选的全部显示未恢复隐藏项目");
  await Promise.all([
    page.waitForURL(new RegExp(`project-detail\\.html\\?id=${quickProjectId}`)),
    page.locator(`#tbody tr[data-id="${quickProjectId}"] .project-detail-link`).click(),
  ]);
  await page.locator("#back-btn").click();
  await page.waitForURL(/project-status-summary\.html\?quick=priority-high/);
  expect(await page.locator(`#tbody tr[data-id="${quickProjectId}"]`).count() === 1, "从快速筛选项目详情返回后未回到原结果页");

  const maintenanceId = await page.evaluate(() => {
    const projects = PROJECT_DB.load();
    const target = projects.find(project => project.status === "已结案");
    if (!target) throw new Error("缺少已结案项目用于量产维护标识验证");
    target.isProductionMaintenance = true;
    PROJECT_DB.save(projects);
    return target.id;
  });
  await page.goto(`${baseUrl}/GeekDash.html?view=maintenance`, { waitUntil: "domcontentloaded" });
  const maintenanceCard = page.locator("#card-grid .card").first();
  expect(await maintenanceCard.locator(".maintenance-badge").textContent() === "量产维护", "首页量产维护项目未显示紫色维护标识");
  await page.goto(`${baseUrl}/project-detail.html?id=${maintenanceId}`, { waitUntil: "domcontentloaded" });
  expect(await page.locator(".status-with-maintenance .maintenance-badge").textContent() === "量产维护", "详情页量产维护项目未显示紫色维护标识");
  expect(await page.locator(".maintenance-badge").evaluate(element => getComputedStyle(element).fontSize) === "9px", "量产维护标识字体未缩小为 9px");
  await page.goto(`${baseUrl}/project-status-summary.html`, { waitUntil: "domcontentloaded" });
  const maintenanceRow = page.locator(`#tbody tr[data-id="${maintenanceId}"]`);
  expect(await maintenanceRow.locator(".cell-delay .maintenance-badge").textContent() === "量产维护", "状态简要未将量产维护标识放在已结案标签下方");
  expect(await maintenanceRow.locator(".cell-name .maintenance-badge").count() === 0, "状态简要仍在项目名称下方显示量产维护标识");
});

await run("主看板详情返回恢复来源视图、筛选、搜索、滚动与项目焦点", async () => {
  await resetMain();
  await page.locator('#view-switch button[data-view="proposal"]').click();
  await page.waitForURL(/view=proposal/);
  const source = await page.evaluate(() => {
    const initialCard = document.querySelector("#card-grid .card");
    const project = PROJECT_DB.load().find(item => String(item.id) === initialCard?.dataset.id);
    const customerChip = [...document.querySelectorAll('#filter-rows .chip[data-dim="customer"]')]
      .find(chip => chip.dataset.val === project.customer);
    if (!customerChip) throw new Error("未找到用于回归测试的客户筛选项");
    customerChip.click();
    const searchText = project.name.slice(0, Math.max(1, Math.ceil(project.name.length / 2)));
    const search = document.querySelector("#search");
    search.value = searchText;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    document.body.style.paddingBottom = "1600px";
    window.scrollTo(0, 260);
    const card = document.querySelector(`#card-grid .card[data-id="${CSS.escape(String(project.id))}"]`);
    return { id: card.dataset.id, customer: project.customer, searchText: searchText.toLowerCase(), resultCount: document.querySelectorAll("#card-grid .card").length, scrollY: window.scrollY };
  });
  await page.locator(`#card-grid .card[data-id="${source.id}"]`).click();
  await page.waitForURL(/project-detail\.html\?id=\d+&from=proposal/);
  await page.locator("#back-btn").click();
  await page.waitForURL(/GeekDash\.html\?view=proposal/);
  expect(await page.locator('#view-switch button[data-view="proposal"]').getAttribute("class").then((v) => v.includes("active")), "返回后未保持提案视图");
  expect(await page.locator("#search").inputValue() === source.searchText, "返回后未保持搜索词");
  expect(await page.locator('#filter-rows .chip[data-dim="customer"].active').evaluate(chip => chip.dataset.val) === source.customer, "返回后未保持客户筛选");
  expect(await page.locator("#card-grid .card").count() === source.resultCount, "返回后筛选结果与进入详情前不一致");
  await expectReturnedFocus(source, "主看板");
});

await run("系统管理菜单在窄视口完整显示", async () => {
  await resetMain();
  try {
    await page.setViewportSize({ width: 678, height: 720 });
    await page.locator("#sys-menu-btn").click();
    await page.waitForFunction(() => document.querySelector("#sys-menu").classList.contains("viewport-positioned"));
    const bounds = await page.locator("#sys-menu").evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
    });
    expect(bounds.left >= 12 && bounds.right <= bounds.width - 12, `系统管理菜单横向越界：${JSON.stringify(bounds)}`);
    expect(bounds.top >= 12 && bounds.bottom <= bounds.height - 12, `系统管理菜单纵向越界：${JSON.stringify(bounds)}`);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

await run("已结案项目可标记量产维护并独立展示", async () => {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  const target = await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("hw_project_board_welcome_dismissed", "1");
    localStorage.setItem("hw_project_board_mode", "manage");
    localStorage.setItem("hw_project_board_mode_user", JSON.stringify({ name: "自动测试", role: "测试" }));
    const projects = PROJECT_DB.load();
    projects[0].status = "已结案";
    projects[0].isProductionMaintenance = false;
    PROJECT_DB.save(projects);
    return { id: projects[0].id, name: projects[0].name };
  });
  await page.goto(`${baseUrl}/project-detail.html?id=${target.id}&from=closed`, { waitUntil: "domcontentloaded" });
  expect(await page.locator("#f-production-maintenance").isVisible(), "已结案项目未显示量产维护标识");
  await page.locator("#f-production-maintenance").check();
  await page.locator("#save-btn").click();
  const saved = await page.evaluate((id) => PROJECT_DB.load().find((item) => item.id === id), target.id);
  expect(saved?.status === "已结案" && saved?.isProductionMaintenance, "量产维护标识未按已结案项目保存");
  expect(saved.statusHistory.some((item) => item.text.includes("量产维护：已开启")), "量产维护变更未写入历史");
  await page.goto(`${baseUrl}/GeekDash.html?view=maintenance`, { waitUntil: "domcontentloaded" });
  expect(await page.locator('#view-switch button[data-view="maintenance"]').getAttribute("class").then((v) => v.includes("active")), "未进入量产维护看板");
  expect((await page.locator("#card-grid .card").filter({ hasText: target.name }).count()) === 1, "量产维护项目未独立展示");
  await page.locator("#card-grid .card").filter({ hasText: target.name }).click();
  await page.waitForURL(/project-detail\.html\?id=\d+&from=maintenance/);
  await page.locator("#back-btn").click();
  await page.waitForURL(/GeekDash\.html\?view=maintenance/);
  await page.goto(`${baseUrl}/GeekDash.html?view=closed`, { waitUntil: "domcontentloaded" });
  expect((await page.locator("#card-grid .card").filter({ hasText: target.name }).count()) === 0, "量产维护项目仍重复出现在已结案看板");
});

await run("项目人员仅能从基础库搜索选择并保留历史待入库值", async () => {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  const fixture = await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("hw_project_board_welcome_dismissed", "1");
    localStorage.setItem("hw_project_board_mode", "manage");
    localStorage.setItem("hw_project_board_mode_user", JSON.stringify({ name: "自动测试", role: "测试" }));
    const projects = PROJECT_DB.load();
    const engineers = PROJECT_DB.loadEngineers();
    projects[0].hwOwner = "1.028历史人员";
    projects[0].participants = ["1.028历史人员"];
    PROJECT_DB.save(projects);
    return { id: projects[0].id, engineer: engineers[0].name };
  });
  await page.goto(`${baseUrl}/project-detail.html?id=${fixture.id}`, { waitUntil: "domcontentloaded" });
  expect(await page.locator("#f-hw").getAttribute("type") === "hidden", "硬件负责人仍允许自由文本输入");
  expect(await page.locator('[data-target="f-hw"] .person-chip.legacy').count() === 1, "历史负责人未作为待入库值保留");
  const hwPicker = page.locator('[data-target="f-hw"]');
  await hwPicker.locator(".person-search").fill(fixture.engineer.slice(0, 1));
  await hwPicker.locator(`.person-option[data-name="${fixture.engineer}"]`).click();
  expect(await page.locator("#f-hw").inputValue() === fixture.engineer, "搜索候选后未写入受控负责人值");
  const participantPicker = page.locator('[data-target="f-participants"]');
  await participantPicker.locator(".person-search").fill(fixture.engineer.slice(0, 1));
  const participantName = await participantPicker.locator(".person-option").first().getAttribute("data-name");
  expect(!!participantName, "参与人搜索未显示基础库候选人员");
  await participantPicker.locator(".person-option").first().click();
  expect(await participantPicker.locator(".person-chip").count() === 2, "参与人多选未保留历史值并添加基础库人员");
  await page.locator("#save-btn").click();
  const saved = await page.evaluate((id) => PROJECT_DB.load().find(project => project.id === id), fixture.id);
  expect(saved.hwOwner === fixture.engineer && saved.participants.includes(participantName) && saved.participants.includes("1.028历史人员"), "人员选择保存后未保持受控值或历史兼容值");
});

await run("核心芯片只能从基础库选择，历史值保留且改名级联", async () => {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  const fixture = await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("hw_project_board_welcome_dismissed", "1");
    localStorage.setItem("hw_project_board_mode", "manage");
    localStorage.setItem("hw_project_board_mode_user", JSON.stringify({ name: "自动测试", role: "测试" }));
    const projects = PROJECT_DB.load();
    const library = PROJECT_DB.loadChips();
    projects[0].chips = [library[0].name, "1.028历史待入库芯片"];
    PROJECT_DB.save(projects);
    return { projectId: projects[0].id, oldName: library[0].name, addName: library[1].name, renamed: `${library[0].name}-回归改名` };
  });
  await page.goto(`${baseUrl}/project-detail.html?id=${fixture.projectId}&from=active`, { waitUntil: "domcontentloaded" });
  expect(await page.locator("#chip-picker input.chip-input").count() === 0, "项目详情仍提供芯片自由文本输入");
  expect(await page.locator(".project-chip-tag.unregistered").count() === 1, "1.028 库外芯片未显示待入库标识");
  await page.locator("#chip-select").selectOption(fixture.addName);
  await page.locator("#chip-select-add").click();
  await page.locator("#save-btn").click();
  const selected = await page.evaluate((id) => PROJECT_DB.load().find(item => item.id === id)?.chips, fixture.projectId);
  expect(selected.includes(fixture.oldName) && selected.includes(fixture.addName) && selected.includes("1.028历史待入库芯片"), "受控多选未保留已选及历史芯片");

  await page.goto(`${baseUrl}/data-manage.html?tab=chips`, { waitUntil: "domcontentloaded" });
  expect(await page.locator('.tab[data-tab="chips"]').getAttribute("class").then(value => value.includes("active")), "基础信息芯片直达链接未激活对应标签");
  const chipCard = page.locator("#chip-list .item-card").filter({ hasText: fixture.oldName }).first();
  await chipCard.locator('button[data-act="edit"]').click();
  await page.locator("#ech-name").fill(fixture.renamed);
  await page.locator('#chip-list button[data-act="save"]').click();
  const afterRename = await page.evaluate(({ id, name }) => ({
    project: PROJECT_DB.load().find(item => item.id === id),
    chip: PROJECT_DB.loadChips().find(item => item.name === name),
  }), { id: fixture.projectId, name: fixture.renamed });
  expect(afterRename.chip && afterRename.project.chips.includes(fixture.renamed) && !afterRename.project.chips.includes(fixture.oldName), "芯片改名未级联项目引用");
  const renamedCard = page.locator("#chip-list .item-card").filter({ hasText: fixture.renamed }).first();
  await renamedCard.locator('button[data-act="del"]').click();
  expect(await page.evaluate((name) => PROJECT_DB.loadChips().some(item => item.name === name), fixture.renamed), "使用中的芯片仍被删除");
});

await run("新建项目保留跨标签草稿并避免虚假历史", async () => {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("hw_project_board_welcome_dismissed", "1");
    localStorage.setItem("hw_project_board_mode", "manage");
    localStorage.setItem("hw_project_board_mode_user", JSON.stringify({ name: "自动测试", role: "测试" }));
  });
  await page.goto(`${baseUrl}/project-detail.html?id=new&from=proposal`, { waitUntil: "domcontentloaded" });
  await page.locator("#f-name").fill("自动回归项目");
  await page.locator("#f-group").selectOption({ label: "一组" });

  await page.locator('.dtab[data-tab="stages"]').click();
  await page.locator('.stage-days-input[data-idx="0"]').fill("9");

  await page.locator('.dtab[data-tab="nodes"]').click();
  await page.locator("#node-add").click();
  await page.locator("#node-name").fill("自动节点");
  await page.locator("#node-stage").selectOption("需求立项");
  await page.locator("#node-output").fill("自动输出");
  await page.locator("#node-confirm").click();
  const draftNodeVisible = await page.locator("#pane-nodes .node-list .node-item").count() === 1;

  await page.locator('.dtab[data-tab="custnodes"]').click();
  await page.locator("#custnode-add").click();
  await page.locator("#custnode-name").fill("客户自动节点");
  await page.locator("#custnode-note").fill("自动备注");
  await page.locator("#custnode-confirm").click();
  const draftCustomerNodeVisible = await page.locator("#pane-custnodes .node-list .node-item").count() === 1;

  await page.locator('.dtab[data-tab="info"]').click();
  await page.locator("#save-btn").click();
  await page.waitForURL(/project-detail\.html\?id=\d+/);
  const initial = await page.evaluate(() => {
    const projects = JSON.parse(localStorage.getItem(PROJECT_DB.STORAGE_KEY));
    const project = projects.find((item) => item.name === "自动回归项目");
    return project && {
      id: project.id, createdAt: project.createdAt, nodes: project.nodes, customerNodes: project.customerNodes,
      firstStageDays: project.stages?.[0]?.days, historyLength: project.statusHistory?.length || 0,
    };
  });
  await page.locator("#save-btn").click();
  const historyAfterNoopSave = await page.evaluate(() => {
    const projects = JSON.parse(localStorage.getItem(PROJECT_DB.STORAGE_KEY));
    return projects.find((item) => item.name === "自动回归项目")?.statusHistory?.length || 0;
  });

  expect(draftNodeVisible, "新建模式无法保存项目节点草稿");
  expect(draftCustomerNodeVisible, "新建模式无法保存客户节点草稿");
  expect(initial?.createdAt, "新项目缺少 createdAt");
  expect(initial?.nodes?.length === 1, "首次保存丢失项目节点");
  expect(initial?.customerNodes?.length === 1, "首次保存丢失客户节点");
  expect(initial?.firstStageDays === "9", "首次保存丢失阶段天数草稿");
  expect(historyAfterNoopSave === initial.historyLength, "无变更保存写入了虚假历史");
});

await run("完整备份 schema 与异常 ID 拒绝", async () => {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  const state = await page.evaluate(() => {
    const backup = PROJECT_DB.validateBackupData(PROJECT_DB.buildBackupData());
    let duplicateRejected = false;
    try { PROJECT_DB.validateBackupData({ projects: [{ id: 1, name: "A" }, { id: "1", name: "B" }] }); }
    catch (error) { duplicateRejected = /重复 id/.test(error.message); }
    const legacy = PROJECT_DB.validateBackupData({ version: 1, projects: [{ id: 9011, name: "1.028迁移项目", chips: ["旧版库外芯片"] }], chips: [] });
    const migration = buildChipMigration(legacy, "merge");
    renderChipMigration(migration);
    const createdData = applyChipMigrationSelections(migration);
    const createdOk = createdData.chips.some(item => item.name === "旧版库外芯片") && createdData.projects[0].chips.includes("旧版库外芯片");
    closeChipMigration(true);
    const mapTarget = PROJECT_DB.loadChips()[0].name;
    const mappingLegacy = PROJECT_DB.validateBackupData({ version: 1, projects: [{ id: 9012, name: "1.028映射项目", chips: ["旧版别名芯片"] }], chips: [] });
    const mapping = buildChipMigration(mappingLegacy, "merge");
    renderChipMigration(mapping);
    document.querySelector('[data-chip-migration-index="0"]').value = mapTarget;
    const mappedData = applyChipMigrationSelections(mapping);
    const mappedOk = mappedData.projects[0].chips[0] === mapTarget && !mappedData.chips.some(item => item.name === "旧版别名芯片");
    closeChipMigration(true);
    return { version: backup.version, hasCompany: !!backup.company, hasPreferences: !!backup.preferences, duplicateRejected, unresolvedChips: migration.unresolved.map(item => item.name), createdOk, mappedOk };
  });
  expect(state.version === 2, "备份 schema 版本不正确");
  expect(state.hasCompany && state.hasPreferences, "完整备份缺少企业信息或偏好");
  expect(state.duplicateRejected, "异常重复 ID 未被拒绝");
  expect(state.unresolvedChips.includes("旧版库外芯片"), "1.028 芯片迁移预检未识别库外引用");
  expect(state.createdOk && state.mappedOk, "1.028 芯片批量入库或映射未正确生成迁移数据");
});

await run("单文件导出版构建、执行与数据转义", async () => {
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  const html = await page.evaluate(() => buildStandaloneHTML([
    Object.assign({}, PROJECT_DB.DEFAULT_PROJECTS[0], { id: 901, name: "</script><img src=x onerror=alert(1)>导出测试", status: "已结案", isProductionMaintenance: true }),
    Object.assign({}, PROJECT_DB.DEFAULT_PROJECTS[1], { id: 902, name: "导出活动项目", status: "进行中", isProductionMaintenance: false }),
  ], true));
  expect(!/__GD_[A-Z_]+__/.test(html), "导出版仍包含未替换构建令牌");
  expect(!html.includes("</script><img src=x"), "导出数据未安全编码即进入 script");
  const exportPage = await context.newPage();
  const exportErrors = [];
  exportPage.on("pageerror", (error) => exportErrors.push(error.message));
  exportPage.on("console", (message) => { if (message.type() === "error") exportErrors.push(message.text()); });
  exportPage.on("dialog", (dialog) => dialog.dismiss());
  await exportPage.setContent(html, { waitUntil: "domcontentloaded" });
  try { await exportPage.locator("#card-grid .card").first().waitFor({ timeout: 5000 }); }
  catch {
    const bodyText = (await exportPage.locator("body").innerText()).slice(0, 300);
    throw new Error(`导出版未渲染卡片；错误：${exportErrors.join(" | ") || "无 pageerror"}；页面：${bodyText}`);
  }
  expect(await exportPage.locator("img").count() === 0, "恶意项目名被解析成 HTML 元素");
  await exportPage.locator('#view-switch button[data-view="maintenance"]').click();
  expect((await exportPage.locator(".card-name").first().textContent()).includes("导出测试"), "导出版没有在量产维护看板渲染项目数据");
  expect(exportErrors.length === 0, `导出版执行错误：${exportErrors.join(" | ")}`);
  await exportPage.close();

  const editableHtml = await page.evaluate(() => buildStandaloneHTML([
    Object.assign({}, PROJECT_DB.DEFAULT_PROJECTS[0], { id: 903, name: "可编辑量产维护项目", status: "已结案", isProductionMaintenance: true }),
  ], false));
  const editablePage = await context.newPage();
  await editablePage.setContent(editableHtml, { waitUntil: "domcontentloaded" });
  await editablePage.locator('#view-switch button[data-view="maintenance"]').click();
  await editablePage.locator("#card-grid .card").first().click();
  await editablePage.locator("#f-production-maintenance").waitFor();
  expect(await editablePage.locator("#f-production-maintenance").isChecked(), "可编辑导出版未读取量产维护标识");
  expect(await editablePage.locator("#chip-list select.chip-input").count() > 0 && await editablePage.locator("#chip-list input.chip-input").count() === 0, "可编辑导出版仍提供芯片自由文本输入");
  await editablePage.locator("#f-production-maintenance").uncheck();
  await editablePage.locator("#save-btn").click();
  expect(await editablePage.evaluate(() => PROJECTS.find((item) => item.id === 903)?.isProductionMaintenance === false), "可编辑导出版未保存量产维护标识");
  await editablePage.locator('#view-switch button[data-view="closed"]').click();
  expect((await editablePage.locator("#card-grid .card").count()) === 1, "可编辑导出版关闭标识后未回到已结案视图");
  await editablePage.close();
});

await run("项目状态描述保留多行并在报表导出中呈现", async () => {
  const multiline = "\n第一行状态\n第二行状态\n\n第三行状态\n";
  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  const target = await page.evaluate((text) => {
    localStorage.clear();
    localStorage.setItem("hw_project_board_welcome_dismissed", "1");
    localStorage.setItem("hw_project_board_mode", "manage");
    localStorage.setItem("hw_project_board_mode_user", JSON.stringify({ name: "自动测试", role: "测试" }));
    const projects = PROJECT_DB.load();
    projects[0].statusDesc = "";
    PROJECT_DB.save(projects);
    return { id: projects[0].id, text };
  }, multiline);
  await page.goto(`${baseUrl}/project-detail.html?id=${target.id}&from=active`, { waitUntil: "domcontentloaded" });
  await page.locator("#f-statusdesc").fill(target.text);
  await page.locator("#save-btn").click();
  expect(await page.locator("#f-statusdesc").inputValue() === target.text, "详情页保存后未保留项目状态描述的多行内容");
  expect(await page.evaluate(({ id, text }) => PROJECT_DB.load().find(item => item.id === id)?.statusDesc === text, target), "持久化数据未保留项目状态描述的多行内容");
  expect(await page.locator(".h-text").first().evaluate(element => getComputedStyle(element).whiteSpace === "pre-wrap"), "状态历史未按多行排版");

  await page.goto(`${baseUrl}/GeekDash.html`, { waitUntil: "domcontentloaded" });
  const card = page.locator(`#card-grid .card[data-id="${target.id}"]`);
  expect(await card.locator(".status-desc").evaluate(element => getComputedStyle(element).whiteSpace === "pre-wrap"), "首页状态卡片未按多行排版");

  await page.goto(`${baseUrl}/project-status-summary.html`, { waitUntil: "domcontentloaded" });
  const row = page.locator(`#tbody tr[data-id="${target.id}"]`);
  expect(await row.locator(".cell-status").textContent() === target.text, "状态简要未保留状态描述原始换行");
  expect(await row.locator(".cell-status").evaluate(element => getComputedStyle(element).whiteSpace === "pre-wrap"), "状态简要屏幕版未按多行排版");
  await page.emulateMedia({ media: "print" });
  expect(await row.locator(".cell-status").evaluate(element => getComputedStyle(element).whiteSpace === "pre-wrap"), "PDF 打印版未按多行排版");
  await page.emulateMedia({ media: "screen" });

  await row.locator(".row-check").check();
  await disableDirectoryPickerForDownloadTest();
  const markdownPromise = page.waitForEvent("download");
  await page.locator("#export-md-btn").click();
  const markdown = await fs.readFile(await (await markdownPromise).path(), "utf8");
  expect(markdown.includes("第一行状态<br>第二行状态<br><br>第三行状态"), "Markdown 未将状态描述换行保留为 <br>");
  const csvPromise = page.waitForEvent("download");
  await page.locator("#export-csv-btn").click();
  const csv = await fs.readFile(await (await csvPromise).path(), "utf8");
  expect(csv.includes('"\n第一行状态\n第二行状态\n\n第三行状态\n"'), "CSV 未以带引号字段保留状态描述换行");
});

await run("报表详情返回、Markdown 导出与芯片统计页面加载", async () => {
  await page.goto(`${baseUrl}/project-status-summary.html`, { waitUntil: "domcontentloaded" });
  await disableDirectoryPickerForDownloadTest();
  expect((await page.locator("#tbody tr[data-id]").count()) > 0, "状态简要没有数据行");
  expect((await page.locator("#column-controls button[data-column]").count()) === 9, "状态简要未提供全部字段（含工程师）显示开关");
  await page.locator('#column-controls button[data-column="note"]').click();
  expect(await page.locator(".table-card").evaluate((card) => card.classList.contains("hide-col-note")), "备注列开关未隐藏列表字段");
  const summarySource = await page.evaluate(() => {
    window.scrollTo(0, 50);
    const row = [...document.querySelectorAll("#tbody tr[data-id]")].find((item) => item.offsetParent !== null);
    return { id: row.dataset.id, scrollY: window.scrollY };
  });
  await Promise.all([
    page.waitForURL(/project-detail\.html\?id=\d+&tab=stages/),
    page.evaluate((id) => [...document.querySelectorAll("#tbody tr[data-id]")].find((row) => row.dataset.id === String(id) && row.offsetParent !== null).querySelector(".stage-link").click(), summarySource.id),
  ]);
  await page.locator("#back-btn").click();
  await page.waitForURL(/project-status-summary\.html/);
  await expectReturnedFocus(summarySource, "项目状态简要");
  await page.locator("#tbody .row-check").first().check();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-md-btn").click();
  const markdownDownload = await downloadPromise;
  expect(markdownDownload.suggestedFilename().endsWith(".md"), "状态简要未导出 Markdown 文件");
  const markdownPath = await markdownDownload.path();
  const markdown = await fs.readFile(markdownPath, "utf8");
  expect(markdown.includes("## AI 智能体使用说明"), "Markdown 缺少 AI 使用说明");
  expect(markdown.includes("## 原始项目数据（请勿改写）"), "Markdown 缺少原始数据边界");
  expect(markdown.includes("## 客户：") && markdown.includes("### 主要负责人："), "Markdown 未按客户和主要负责人分层");
  expect(markdown.includes("### 网页生成状态色规范") && markdown.includes("已延期｜红色（#DC2626）"), "Markdown 缺少网页状态色规范");
  expect(markdown.includes("| 网页展示状态 |") && markdown.includes("| 网页色彩标识 |"), "Markdown 缺少项目网页展示语义");
  expect(markdown.includes("### 网页生成与交付要求") && markdown.includes("一键保存图片") && markdown.includes("保存为 HTML") && markdown.includes("导出/保存为 PDF"), "Markdown 缺少网页保存与导出要求");
  expect(markdown.includes("# 项目状态纪要（") && markdown.includes("**网页状态颜色图例**"), "Markdown 未采用会议纪要标题和状态图例");
  expect(markdown.includes("→ **下一步：") && markdown.includes("#### 项目原始字段："), "Markdown 缺少项目纪要条目或原始字段追溯");
  expect(markdown.includes("保存到知识库") && markdown.includes("文件夹选择界面") && markdown.includes("项目状态纪要知识库_YYYY-MM-DD_HHmmss") && markdown.includes("复制项目内容"), "Markdown 缺少文件夹归档或项目复制要求");
  expect(!markdown.includes("| 备注 |"), "隐藏的备注列仍出现在 Markdown 导出中");
  await page.locator("#report-title").fill("自动化项目状态报告");
  const csvDownloadPromise = page.waitForEvent("download");
  await page.locator("#export-csv-btn").click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename().startsWith("自动化项目状态报告_"), "CSV 未使用自定义报告名称作为文件名");
  const csv = await fs.readFile(await csvDownload.path(), "utf8");
  expect(csv.includes("客户,") && csv.includes("项目名称") && csv.includes("项目最新状态"), "CSV 缺少项目状态导出列");
  expect(!csv.split(/\r?\n/, 1)[0].includes("备注"), "隐藏的备注列仍出现在 CSV 导出中");
  const printState = await page.evaluate(() => {
    const originalPrint = window.print;
    let state = null;
    window.print = () => {
      state = {
        title: document.title,
        reportTitle: document.querySelector("#print-report-title")?.textContent,
        filtersHiddenInPrint: [...document.styleSheets].some(sheet => [...sheet.cssRules].some(rule => rule.media?.mediaText === "print" && rule.cssRules?.[0]?.cssText.includes(".group-filter-bar")))
      };
    };
    document.querySelector("#export-pdf-btn").click();
    window.print = originalPrint;
    return state;
  });
  expect(printState?.title === "自动化项目状态报告" && printState?.reportTitle === "自动化项目状态报告", "PDF 未使用自定义报告名称作为标题");
  expect(printState?.filtersHiddenInPrint, "PDF 打印样式未隐藏筛选栏");
  await page.emulateMedia({ media: "print" });
  expect(await page.locator("#column-controls").evaluate(element => getComputedStyle(element).display === "none"), "PDF 打印样式仍显示字段控制区");
  await page.emulateMedia({ media: "screen" });
  await page.goto(`${baseUrl}/chip-statistics.html`, { waitUntil: "domcontentloaded" });
  expect((await page.locator("#tbody tr[data-id]").count()) > 0, "芯片统计没有数据行");
  const chipSource = await page.evaluate(() => {
    window.scrollTo(0, 50);
    const row = [...document.querySelectorAll("#tbody tr[data-id]")].find((item) => item.offsetParent !== null);
    return { id: row.dataset.id, scrollY: window.scrollY };
  });
  await Promise.all([
    page.waitForURL(/project-detail\.html\?id=\d+&tab=stages/),
    page.evaluate((id) => [...document.querySelectorAll("#tbody tr[data-id]")].find((row) => row.dataset.id === String(id) && row.offsetParent !== null).querySelector(".stage-link").click(), chipSource.id),
  ]);
  await page.locator("#back-btn").click();
  await page.waitForURL(/chip-statistics\.html/);
  await expectReturnedFocus(chipSource, "芯片统计");
});

await browser.close();
console.log(JSON.stringify({ baseUrl, results }, null, 2));
if (results.some((result) => result.status === "failed")) process.exit(1);

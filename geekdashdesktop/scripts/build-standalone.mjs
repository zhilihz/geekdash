import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = args.includes("--extract") ? "extract" : args.includes("--check") ? "check" : "build";
const rootArg = args.find((arg) => !arg.startsWith("--"));
const root = path.resolve(rootArg || path.join(import.meta.dirname, "..", "assets", "geekdash-template"));
const mainPath = path.join(root, "GeekDash.html");
const sourceDir = path.join(root, "src");
const cssPath = path.join(sourceDir, "standalone.css");
const templatePath = path.join(sourceDir, "standalone-template.html");
const begin = "/* BEGIN GENERATED STANDALONE — run scripts/build-standalone.mjs */";
const end = "/* END GENERATED STANDALONE */";

function serializeInline(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function tokenize(template) {
  const replacements = new Map([
    ['${boardTitle}', "__GD_BOARD_TITLE__"],
    ['${STANDALONE_CSS}', "__GD_STANDALONE_CSS__"],
    ['${window.PROJECT_DB.APP_VERSION}', "__GD_APP_VERSION__"],
    ['${data.length}', "__GD_PROJECT_COUNT__"],
    ['${readOnly ? "（只读）" : "（可编辑）"}', "__GD_MODE_LABEL__"],
    ['${JSON.stringify(window.PROJECT_DB.STAGES)}', "__GD_STAGES_JSON__"],
    ['${JSON.stringify(window.PROJECT_DB.loadChips())}', "__GD_CHIPS_JSON__"],
    ['${dataJSON}', "__GD_DATA_JSON__"],
    ['${readOnly}', "__GD_READONLY__"],
    ['${exportKey}', "__GD_EXPORT_KEY__"],
  ]);
  let output = template;
  for (const [from, to] of replacements) output = output.split(from).join(to);
  const unresolved = [...output.matchAll(/(?<!\\)\$\{/g)];
  if (unresolved.length) throw new Error(`Standalone template has ${unresolved.length} unresolved outer interpolation(s)`);
  return output;
}

function generatedRegion(css, template) {
  return `${begin}
const STANDALONE_CSS = ${serializeInline(css)};
const STANDALONE_HTML_TEMPLATE = ${serializeInline(template)};
function standaloneSafeJSON(value) {
  return JSON.stringify(value).replace(/</g, "\\\\u003c").replace(/>/g, "\\\\u003e").replace(/&/g, "\\\\u0026");
}
function buildStandaloneHTML(data, readOnly) {
  const company = PROJECT_DB.loadCompany();
  const boardTitle = (company.namePrefix || "智能硬件") + "项目看板系统";
  const exportKey = "hw_project_board_export_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const values = {
    __GD_BOARD_TITLE__: esc(boardTitle),
    __GD_STANDALONE_CSS__: STANDALONE_CSS,
    __GD_APP_VERSION__: String(window.PROJECT_DB.APP_VERSION),
    __GD_PROJECT_COUNT__: String(data.length),
    __GD_MODE_LABEL__: readOnly ? "（只读）" : "（可编辑）",
    __GD_STAGES_JSON__: standaloneSafeJSON(window.PROJECT_DB.STAGES),
    __GD_CHIPS_JSON__: standaloneSafeJSON(window.PROJECT_DB.loadChips()),
    __GD_DATA_JSON__: standaloneSafeJSON(data),
    __GD_PROJECT_RULES__: ["isEarlyClosure", "setProjectStatus", "currentStage", "projectProgress", "projectStageName", "projectDelayState", "normalizeStatusDescriptionHistory", "statusDescriptionHistory", "updateStatusDescription"].map(name => PROJECT_DB[name].toString()).join("\\n"),
    __GD_READONLY__: readOnly ? "true" : "false",
    __GD_EXPORT_KEY__: exportKey,
  };
  let output = STANDALONE_HTML_TEMPLATE;
  Object.keys(values).forEach(key => { output = output.split(key).join(values[key]); });
  return output;
}
${end}`;
}

function replaceGenerated(main, region) {
  const start = main.indexOf(begin);
  const finish = main.indexOf(end);
  if (start < 0 || finish < start) throw new Error("Generated standalone markers were not found");
  return main.slice(0, start) + region + main.slice(finish + end.length);
}

let main = fs.readFileSync(mainPath, "utf8");
if (mode === "extract") {
  if (main.includes(begin)) throw new Error("Standalone sources were already extracted");
  const cssMatch = main.match(/const STANDALONE_CSS = `([\s\S]*?)`;\r?\n\r?\nfunction buildStandaloneHTML/);
  const templateMatch = main.match(/function buildStandaloneHTML\(data, readOnly\) \{[\s\S]*?return `([\s\S]*?<\/html>)`;\r?\n\}/);
  if (!cssMatch || !templateMatch) throw new Error("Legacy standalone CSS/template region was not found");
  const css = cssMatch[1];
  const template = tokenize(templateMatch[1]);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(cssPath, css, "utf8");
  fs.writeFileSync(templatePath, template, "utf8");
  const start = cssMatch.index;
  const finish = templateMatch.index + templateMatch[0].length;
  const updated = main.slice(0, start) + generatedRegion(css, template) + main.slice(finish);
  fs.writeFileSync(mainPath, updated, "utf8");
  console.log(`Extracted standalone sources and regenerated ${mainPath}`);
  process.exit(0);
}

if (!fs.existsSync(cssPath) || !fs.existsSync(templatePath)) throw new Error("Standalone source files are missing; run with --extract once");
const css = fs.readFileSync(cssPath, "utf8");
const template = fs.readFileSync(templatePath, "utf8");
const region = generatedRegion(css, template);
if (mode === "check") {
  const start = main.indexOf(begin);
  const finish = main.indexOf(end);
  const actual = start >= 0 && finish >= start ? main.slice(start, finish + end.length) : "";
  if (actual !== region) {
    console.error("GeekDash.html standalone export is out of sync. Run: node scripts/build-standalone.mjs");
    process.exit(1);
  }
  console.log("Standalone export source and generated runtime are in sync.");
  process.exit(0);
}

main = replaceGenerated(main, region);
fs.writeFileSync(mainPath, main, "utf8");
console.log(`Regenerated standalone export in ${mainPath}`);

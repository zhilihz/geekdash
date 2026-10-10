# GeekDash 可复用错误处理

| 编号 | 现象 | 快速处理 | 状态 |
|---|---|---|---|
| GD-LOCAL-1051-001 | Edge窄窗口菜单边界测试偶发读到定位前坐标 | 先等 `viewport-positioned`，再读坐标 | 已验证 |
| GD-LOCAL-1051-002 | 主页面语法通过仍漏单文件模板错误 | 同时编译模板内script及注入规则，再实际执行导出页 | 已验证 |
| GD-LOCAL-1051-003 | 文件句柄已记住，重启仍回首次欢迎；异步恢复覆盖返回焦点 | 持久连接状态、启动读取句柄，加载完成后恢复返回位置 | 已解决 |

## GD-LOCAL-1051-001：浏览器测试等待实际布局完成

- 范围：`geekdashdesktop/scripts/browser-regression.mjs` 的“系统管理菜单在窄视口完整显示”；2026-10-09，Edge，678×720。
- 现象：点击菜单后立即读取坐标，偶发left=10.046875而断言要求至少12；此前及其他运行可通过。
- 原因：原产品调用 `requestAnimationFrame(positionSysMenu)`，点击完成不代表下一帧定位完成。`positionSysMenu` 在同步函数中加 `viewport-positioned` 并写完left/top。
- 处理：点击后 `waitForFunction` 等菜单含定位完成类，再取 `getBoundingClientRect()`；保留12px断言，不降低标准、不改产品坐标算法。
- 验证：相同1051发布目录41871复跑，13项全部通过，证据见[回归结果](evidence/local-v1051/regression.json)。
- 相关技术边界：新独立测试标签页若没有数据库session会被1050入口保护带回首页；测试应明确建立会话，不能修改产品绕过入口。清除会话回读时先到首页再重新打开文件句柄。

## GD-LOCAL-1051-002：验证生成页面的脚本本体

- 范围：standalone-template.html被序列化为GeekDash.html中的字符串，主页面语法检查不能证明导出脚本合法。
- 处理：修改原模板及build-standalone共享规则名单后重新生成；verify-local.mjs替换占位后编译模板内script，verify-local-browser.mjs在Edge实际执行导出页并保存/结案回读。不同引号层按各自源码上下文修改。
- 验证：本次修正进度模式文案的引号问题，语法与实际导出编辑通过；见本地1051结案补充报告。

## GD-LOCAL-1051-003：恢复原数据库与异步首页加载

- 范围/日期：GeekDash本地1051，2026-10-10；项目会话代码和验收入口，没有修改全局浏览器配置。
- 快速处理：IndexedDB已有文件句柄不代表sessionStorage仍有数据库会话；增加本机持久连接状态，首页启动查询权限并恢复原文件。权限失效保留缓存和原连接，由用户点击授权；待写回内容不被磁盘旧内容覆盖。正常打开首页后再恢复详情返回焦点/滚动，pageshow只处理浏览器缓存恢复。
- 复盘：1050只在首次选择时设窗口会话，关浏览器后记录消失；原首页同步init改为异步后，pageshow先恢复焦点而后init重绘又覆盖。启动回归另暴露测试在加载完成前写夹具的问题，验收先等待版本/首页加载完成，再编辑。不能以脚本HTTP启动代替修复会话。
- 验证：真实Windows JSON、file://、整个Edge进程重启和权限撤销/恢复五组通过；原13项含详情返回焦点/滚动通过，见[启动报告](testing/reports/2026-10-10-local-v1051-startup.md)。OPFS不能用来代表file://磁盘访问，本次由独立测试profile预授权限及真实拖入磁盘文件取得句柄，产品权限逻辑未绕过。首次OS选择仍由使用者完成。
- 检索及归属：已查本项目GD-LOCAL、数据库/IndexedDB/file://条目，未有该模式；本记录依赖本项目session与页面init，归项目错误库。异常文件仍保留缓存，恢复入口是原文件授权或另存，不盲重开覆盖。

## 既有全局方案复用

本轮Python控制台中文/emoji输出显式使用进程级`PYTHONIOENCODING=utf-8`；apply_patch分块按文件顺序或使用断言限定替换。复用全局库GE-20261008-007和GE-20260910-001，不再复制处理卡。全局入口为`C:/Users/Administrator/.codex/docs/codex-runtime-errors.md`。

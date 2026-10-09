# GeekDash 可复用错误处理

| 编号 | 现象 | 快速处理 | 状态 |
|---|---|---|---|
| GD-LOCAL-1051-001 | Edge窄窗口菜单边界测试偶发读到定位前坐标 | 先等 `viewport-positioned`，再读坐标 | 已验证 |

## GD-LOCAL-1051-001：浏览器测试等待实际布局完成

- 范围：`geekdashdesktop/scripts/browser-regression.mjs` 的“系统管理菜单在窄视口完整显示”；2026-10-09，Edge，678×720。
- 现象：点击菜单后立即读取坐标，偶发left=10.046875而断言要求至少12；此前及其他运行可通过。
- 原因：原产品调用 `requestAnimationFrame(positionSysMenu)`，点击完成不代表下一帧定位完成。`positionSysMenu` 在同步函数中加 `viewport-positioned` 并写完left/top。
- 处理：点击后 `waitForFunction` 等菜单含定位完成类，再取 `getBoundingClientRect()`；保留12px断言，不降低标准、不改产品坐标算法。
- 验证：相同1051发布目录41871复跑，13项全部通过，证据见[回归结果](evidence/local-v1051/regression.json)。
- 相关技术边界：新独立测试标签页若没有数据库session会被1050入口保护带回首页；测试应明确建立会话，不能修改产品绕过入口。清除会话回读时先到首页再重新打开文件句柄。

## 既有全局方案复用

本轮Python控制台中文/emoji输出显式使用进程级`PYTHONIOENCODING=utf-8`；apply_patch分块按文件顺序或使用断言限定替换。复用全局库GE-20261008-007和GE-20260910-001，不再复制处理卡。全局入口为`C:/Users/Administrator/.codex/docs/codex-runtime-errors.md`。

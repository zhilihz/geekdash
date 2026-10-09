# E04-B01 阶段开始与完成验证

日期：2026-10-09；施工`codex/e04-b01-stage-actions`，基线`f5bf84d456998b3309e9bb8c8db66b345bb96daa`。范围为F01-A/B，引用SPEC-002/003/014与TEST-004/024、TEST-038阶段主干部分；整个E04未关闭。

## 已执行范围

- 真实隔离MySQL、真实登录账号、真实HTTP及每次新的SQL连接回读：7组57请求。开始/完成、前置/日期/权限/版本、审计/回执、三处实际SQL失败全回滚、COMMIT确认丢失、应用重建后会话/原结果恢复及S1～S7通用能力通过。[阶段证据](../../evidence/2026-10-09-stage-actions-check.json)
- 新建提案主链：S1待开始→开始仍0%→同日完成5%/S2待开始；总体仍提案中。S2真实人工启动链属B02，本批用明确标记的进行中合成夹具验证后续通用阶段，不把直接夹具SQL当启动API。
- 原版七卡片/里程碑/三线展开/工期展示和状态配色已复用；构建从`geekdashdesktop/projects-data.js`提取静态STAGES，不携带示例项目及原存储脚本。浏览器真实新建→卡片开始/完成→GET/历史；取消恢复、错误日期输入保持、同账号双标签旧版拒绝、复制后重新进入、先保存普通编辑、响应200后ConnectionReset原结果确认，以及保存确认后GET超时恢复通过。[浏览器证据](../../evidence/2026-10-09-stage-browser-check.json)、[卡片](../../evidence/2026-10-09-stage-cards.jpg)、[历史](../../evidence/2026-10-09-stage-history.jpg)
- 浏览器发现创建审计beforeValues=null导致历史渲染异常，已修正类型和空值读取并实际回验：新建记录及阶段前后状态/日期/完成原文均可显示；HTML片段安全显示为文字。处理卡归PE-20261009-003。
- 受影响回归：test:projects四组（并发列表20请求P95=32ms）、test:ordinary七组（并发20请求P95=41ms）、test:core八组66请求、test:saves八组，以及构建/TypeScript/基础真实HTTP/失败构建保留旧产物通过。测试用独立合成库；第一次只读回归因本轮浏览器夹具占库拒绝，先停止自有夹具清理，再重跑通过；没有清空其他数据。

## 性能与限制

500项目/3500阶段、四个实际会话，混合查询/保存/历史320请求0错误，第501项目可创建并新请求读取。列表P50/P95=278/345ms，详情21/32ms，保存33/43ms，历史13/20ms。[容量证据](../../evidence/2026-10-09-stage-capacity-check.json)。列表仍未达到稳定200ms目标，不据此声称已完成总体性能验收；后续结合实际SQL定位，不能盲加Redis或硬限制项目总数。

浏览器双标签为同账号；另一账号负责权限、同版冲突及回执隔离由真实API场景覆盖。固定公开部署/公网/实际进程恢复产生后另记operations/deployments，不能用此本地报告代替。SSE、跨设备私人稿、项目启动/纠错/回退/暂停/结案/检查/子记录仍按各批施工；原本地1051文件未修改。本轮没有接真实备份，也没有数据迁移。

## 复核入口

```powershell
./scripts/docker.ps1 run --rm tool npm run build
./scripts/database.ps1 run --rm dbtool npm run test:stages
./scripts/database.ps1 run --rm dbtool npm run test:projects
./scripts/database.ps1 run --rm dbtool npm run test:ordinary
./scripts/docker.ps1 run --rm tool npm test
```

浏览器只用自建合成项目与账号。`test:stages -- --serve`作为临时夹具时需连接宿主可访问网络，验收结束仅停止/移除自有容器并让脚本清理自有数据；不能在共享测试库仍有夹具时运行要求空库的检查。截图/源摘要对应本轮脏工作树验证；固定构建版本另由部署证据核对，不能将基线SHA称为已提交实现。

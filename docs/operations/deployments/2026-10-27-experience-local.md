# 2026-10-27 本地0014候选更新

仅本地41870，不是新加坡服务器发布。对应DEC-171，代码/API覆盖见[报告](../../testing/reports/2026-10-27-experience.md)。

| 项目 | 实际值 |
|---|---|
| 工作目录/分支 | D:/geekwon/geekdash；codex/project-use-unified-save |
| 构建 | 138d674基线＋未提交改动；2026-10-27T15:05:30.023Z，P05-project-editing |
| 结构 | 0014-project-tasks；48表、414列、84外键，差异0 |
| 页面 | http://127.0.0.1:41870/ |
| 应用/数据库 | geekdash-editing-20261027-ui / geekdash-editing-20261027-mysql |
| 固定产物 | test-results/live-0014，由editing-ui.mjs明确读取；后续dist构建不直接改变正在供用户使用的资源 |

先停止应用写入，完整备份数据库（含例程、事件、触发器）、导入文件和配置；在内存中完成归档与AES-256-GCM加密，没有生成SQL/配置明文落地副本。备份位于D:/geekwon/geekdash-data/backups/experience-20261027-230914/full.aes256gcm，解密凭据单独位于credentials目录，均不入Git。权限限定本机当前账号与SYSTEM。

加密文件SHA256为646a43d58e4ca39f8e4f2258458b9347a35096c4e337f6b45d0b9eb2cbde844e；已解密回读并核对归档摘要。**没有执行隔离完整数据库恢复演练**，可解密不能代替恢复验收。

迁移0013、0014后，排除迁移登记表，对46张原有业务表的全部旧字段重新排序摘要比较，全部一致；新增资格/任务标记列按默认值承接。没有清空项目、账号、密码、已导入内容或原始备份文件。

固定新版产物后只重启本项目应用。health/live、health/ready和登录、注册、个人资料、账号管理、导入、详情页面HTTP200；构建和schema回读一致。未代替用户登录或修改项目进行真实操作。

首次迁移调用因Windows PowerShell旧执行策略退出时，备份已完成但迁移尚未开始；后续沿原备份用当前pwsh入口执行迁移，并核旧数据摘要后启动。没有重复清理或覆盖备份。

恢复入口为上述备份及受控凭据；0014任务已经被保存后，不能直接启动旧0012产物，须在隔离环境验证相匹配的数据/应用恢复，或优先向前修复。原live-0012仅留作旧产物记录，不代表可直接回切。

新加坡测试站仍为此前4ebd377/0009；本记录不声称远端新版已运行。


## 后续代码修正更新（同日）

任务个人草稿的嵌套字段遗漏已补齐，并在独立库核验详情和卡片两个草稿范围。代码1376caa、clean构建2026-10-27T15:38:52.861Z固定于test-results/live-0014-drafts；仅更新应用产物与启动入口，无新增迁移。/api/health/live回读该提交、/api/health/ready为ready，账号与个人资料页面HTTP200。上表保留首次0014迁移时点，当前应用以本段为准。


## 整栏任务与内容日期接续（2026-10-28）

代码5ba3b4c38bc784e0b576ca76dd21814cc6bf6939，clean构建2026-10-27T16:22:38.485Z，schema仍为0014-project-tasks。固定产物为test-results/live-0014-bulk，editing-ui.mjs已指向该目录；仅重启geekdash-editing-20261027-ui，没有运行迁移、清理或用户业务写入。健康接口回读构建一致、ready；首页、详情、简要、账号管理、登录、个人资料及改密页面HTTP200。静态可访问不等于真实操作验收，用户继续负责页面验收。

本次应用更新的前一产物是live-0014-drafts，两者均使用0014结构；必要时可改回该启动入口并仅重启应用，但应先确认问题范围及用户当前未保存输入。原备份仍是首次0014迁移前时点，不代表本次更新时的数据备份。新加坡本轮未更新；阶段main合并和服务器交付仍未完成。


## 用户反馈及双视角、资料管理（2026-10-28）

- 产品92ecbc41b9f6c723cb136534e821976600232e3f；clean构建2026-10-28T02:48:19.902Z，0015-project-deletion。固定产物test-results/live-0015-feedback-catalog，editing-ui.mjs已指向此产物。本地入口仍41870。
- 迁移前加密完整备份：D:/geekwon/geekdash-data/backups/feedback-20261028-110339/full.aes256gcm。AES-256-GCM密钥另存受控credentials文件，不进Git；实际路径归本地receipt。加密文件SHA256为47b4355bd077ebe86dd47f9ea9f4efc60b7d40fdfe9571339e1c18253bc327fb，已解密校验内容摘要一致。
- 仅停止本项目应用；备份数据库、原始导入文件及运行配置后，执行0015增量。48张表中除迁移登记外的原有列逐表数据摘要全部一致；没有删除用户项目/账号，没有在用户库执行合成测试。结构核验48表/415列/84外键、差异0。
- 首次迁移入口误用Windows PowerShell，脚本策略在数据库命令执行前拒绝，原应用随即恢复。随后改用本机pwsh（RemoteSigned）且未改系统策略，重新备份当前数据后完成迁移。早期feedback-20261028-102559副本保留，不能把它当作最终迁移前数据。
- /api/health/live实际返回上述revision、dirty=false及0015；ready返回ready。首页、详情、基础资料、状态简要及其引用静态资源全部HTTP200。真实浏览器使用未代验收。
- 产品已推送远端codex/project-use-unified-save；main未合并，新加坡未更新。旧0014产物不支持新结构，不能直接回切；恢复应在隔离环境验证匹配应用和此备份，优先向前修正。

## 统一设计与1056展示承接（2026-10-28）

- 产品提交`cc4a34bac3458984d0a462aa593e89bedad94a44`，clean构建`2026-10-28T07:40:15.666Z`，schema仍`0015-project-deletion`；固定目录`test-results/live-0015-unified-design`，入口`http://127.0.0.1:41870/`。
- 仅复制已构建产物、替换editing-ui.mjs的固定目录引用并重启geekdash-editing-20261027-ui；未重启MySQL，未迁移、清理、回放或写入用户业务数据。
- 新请求health/live回读上述版本及dirty=false，ready=ready。14个HTML和37个引用静态资源全部HTTP200；各页共享设计CSS位于最后，12个业务页面共同页头各1个。该证据不包含用户真实页面点击或视觉验收。
- 产品已推送远端codex/project-use-unified-save；后续交付记录提交只改文档。main未合并，新加坡本轮未更新；此前公网版本仅保留历史记录，未重新核实。
- 前一应用产物test-results/live-0015-feedback-catalog保持完整，同为0015；如需回退应用先确认用户输入及问题范围，再更改启动引用并只重启应用。此前迁移备份不冒充本次时点备份。

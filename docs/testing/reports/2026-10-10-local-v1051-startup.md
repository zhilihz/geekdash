# 1051直接HTML与原数据库恢复验证

2026-10-10；用户要求本地直接HTML、首次选择后记住原数据库，沿用1051。分支codex/local-startup从已fetch的main/af5de712beccdb0da2726a400b7063c5a90d8393施工，需求REQ-L1051-13、契约SPEC-L1051；此前十项及两轮追加保留。用户最后明确“备注不需要显示，有简介了”，卡片仅保留简介，详情备注字段保持。

代码：本机连接元数据持久化，启动从IndexedDB恢复原文件句柄；没有待写回修改时读取原文件最新内容，待写回时保留本机修改。权限失效仍进上次看板并提供原文件授权/另存/更换入口，成功写文件后才清待写回状态。首页加载完成后恢复详情返回位置，浏览器页面缓存恢复沿用原入口。

已执行下列实际链路：

- 直接file://打开完整发布目录，使用真实Windows磁盘合成JSON和FileSystemFileHandle；在详情UI编辑保存后，Node.js重新读取同一磁盘文件核对值，跨HTML页面共享且报表消费一致。
- 原标签页返回首页读取外部修改后的文件；关闭整个Edge进程、在磁盘修改文件、同一独立配置重启，自动恢复原文件并读取新内容，欢迎页隐藏。
- 未写回修改在重启后保留，磁盘旧内容不覆盖缓存；点击继续保存后实际写入原文件并再次回读。
- 实际撤销独立测试配置的文件写权限，仍进入原看板；详情编辑仅缓存，磁盘不变；再次重启保留修改，恢复权限后点击保存，磁盘回读一致。
- 六页及单文件模板脚本语法、共享延期/进度/描述历史边界、生成模板一致性通过；Edge原13项（含详情返回焦点和滚动）及10组功能专项通过，页面错误为空。1049、1050、首次1051合成旧文件打开→UI修改→OPFS真实保存→清缓存→新句柄回读通过，旧25/25/26字段、角色及历史保留。

证据：[五组直接HTML](../../evidence/local-v1051-startup/startup.json)、[直接HTML首页](../../evidence/local-v1051-startup/direct-html-board.png)、[功能专项](../../evidence/local-v1051-startup/acceptance.json)、[原13项](../../evidence/local-v1051-startup/regression.json)、[旧版兼容](../../evidence/local-v1051-startup/legacy-compatibility.json)、[发布摘要](../../evidence/local-v1051-startup/release-files.json)。入口 `geekdashdesktop/scripts/verify-local-startup.mjs D:/geekwon/geekdash-local-releases/GeekDash1051`；其他入口见TEST-L1051。

验证边界：测试通过CDP拖入合成磁盘文件取得真实句柄，仅在独立Edge测试配置预授/撤销文件权限；未修改使用者浏览器配置，也未读写真实业务数据库。首次Windows系统文件选择/授权由使用者完成。HTTP与file://入口浏览器缓存相互独立，切换入口需首次选择原JSON一次；清浏览器数据、换配置或移动文件仍可能需重新选择。没有声称跨浏览器自动找到旧缓存或后台绕过权限。

交付：`D:/geekwon/geekdash-local-releases/GeekDash1051.zip`，206131字节，白名单9项（六个HTML、projects-data.js、README、SHA256.json），源码/解压目录/ZIP逐字节一致；不含启动脚本、测试配置或业务数据库。替换前的实际旧ZIP保存在 `GeekDash1051_启动修正前.zip`。正常入口为双击HTML，不要求Python或HTTP服务。本次没有云端部署；实现53412ab、集成7d6d832350d9aa7f5847c36a6800a2758c73f1b3已推送并以ls-remote回读远端main一致。合并后语法/共享规则及源码/目录/ZIP字节核对通过，临时自有41870验证服务已停止。后续文档收尾提交不改变发布包代码。

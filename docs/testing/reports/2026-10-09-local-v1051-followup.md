# 1051本日追加修正验证

2026-10-09；用户明确保持V1.051。基线eddee0a，施工codex/local-v1051-followup。范围：负责人显示/筛选/导出名称，@库外姓名不自动建基础人员，主卡片及单文件导出卡片隐藏市场预期；旧字段/数据保留。

已执行并通过：六页语法/共享规则及单文件构建检查、Edge原13项、八组专项；库外@姓名回车和保存后基础工程师不增加，清缓存/会话后新真实OPFS句柄回读依然不增加；负责人筛选可命中库外姓名，列名/字段开关/筛选/导出取值标签一致；详情市场预期及数据库值保留；主卡片和单文件卡片无市场预期展示。阶段、风险、状态历史等原有专项继续通过。

分别以附件1049/1050及首次交付1051的原共享模块生成合成旧文件，打开→UI修改→真实文件保存→清缓存→新句柄回读通过；旧人员角色及此前已有空角色工程师保留。未操作用户真实数据库文件。实际OS文件picker首次授权不由OPFS验收代替。

证据：[专项](../../evidence/local-v1051-followup/acceptance.json)、[13项回归](../../evidence/local-v1051-followup/regression.json)、[旧版兼容](../../evidence/local-v1051-followup/legacy-compatibility.json)、[卡片](../../evidence/local-v1051-followup/board-card.png)、[负责人报表](../../evidence/local-v1051-followup/engineer-report.png)、[发布摘要](../../evidence/local-v1051-followup/release-files.json)。代码入口仍为geekdashdesktop/scripts三个验证脚本及原browser-regression.mjs；兼容脚本可传第四参数为首次1051的projects-data.js。首次来源可由Git实现2f5cf2a恢复到临时文件，与兼容证据SHA256核对。

交付目录和ZIP已更新并逐字节核查；旧ZIP保留为GeekDash1051_首次交付.zip。报告及代码提交将按项目规则回main，无服务器部署。

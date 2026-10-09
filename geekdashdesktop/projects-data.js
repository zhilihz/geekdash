/* ==========================================================================
   共享数据模块：智能硬件方案项目看板
   - 被 列表页(GeekDash.html) 与 详情页(project-detail.html) 共同引用
   - 数据单一来源：替换真实数据只需修改本文件的 DEFAULT_PROJECTS
   - 通过 localStorage 在页面间同步编辑结果（临时存储，可「重置数据」恢复初始）
   ========================================================================== */
(function () {
  const STORAGE_KEY = "hw_project_board_data_v3";
  const STORAGE_KEY_CUSTOMERS     = "hw_project_board_customers_v1";
  const STORAGE_KEY_ENGINEERS     = "hw_project_board_engineers_v1";
  const STORAGE_KEY_PRODUCT_LINES = "hw_project_board_productlines_v1";
  const STORAGE_KEY_APPS          = "hw_project_board_apps_v1";
  const STORAGE_KEY_TAGS          = "hw_project_board_tags_v1";
  const STORAGE_KEY_GROUPS        = "hw_project_board_groups_v1";
  const STORAGE_KEY_CHIPS         = "hw_project_board_chips_v1";
  const STORAGE_KEY_COMPANY       = "hw_project_board_company_v1";
  const DATABASE_SESSION_KEY      = "hw_project_board_database_session_v1";
  const DATABASE_HANDLE_IDB_KEY   = "activeDatabaseFile";
  const DATABASE_LAST_HANDLE_KEY  = "lastDatabaseFile";
  const BACKUP_SCHEMA_VERSION     = 2;
  // 只备份可跨设备恢复的业务偏好；会议运行态和文件夹句柄不进入备份。
  const BACKUP_PREFERENCE_KEYS = [
    "hw_project_board_theme", "hw_project_board_display_mode", "hw_project_board_meeting_float",
    "hw_project_board_zone_settings", "hw_project_board_activity_settings", "hw_project_board_check_mode",
    "hw_project_board_check_rule", "hw_project_board_filter_settings", "hw_project_board_filter_collapsed_default",
    "hw_project_board_welcome_dismissed", "hw_project_board_feedback", "hw_project_board_kb_auto_sync",
    "hw_project_board_summary_order", "hw_project_board_summary_hidden", "hw_project_board_summary_notes",
    "hw_project_board_summary_sort", "hw_project_board_summary_show_note", "hw_project_board_summary_show_node",
    "hw_project_board_chipstat_order", "hw_project_board_chipstat_hidden", "hw_project_board_chipstat_notes",
    "hw_project_board_chipstat_sort", "hw_project_board_chipstat_show_note", "hw_project_board_chipstat_show_node",
    "hw_project_board_chipstat_colvis"
  ];

  /* ---- 常量 ---- */
  const STATUS_LIST   = ["提案中", "进行中", "已结案", "暂缓"];
  const PRIORITY_LIST = ["高", "中", "低"];
  // 红黄绿灯（信号灯）：规则参考 + 人工修正
  const SIGNAL_LIST   = ["绿灯", "黄灯", "红灯"];
  const RISK_LEVEL_LIST = ["高", "中", "低"];
  const RISK_LEVEL_STYLE = {
    "高": { color: "#f85149", cls: "lv-high" },
    "中": { color: "#f0883e", cls: "lv-mid" },
    "低": { color: "#3fb950", cls: "lv-low" }
  };

  const STATUS_STYLE = {
    "提案中": { color: "#a371f7", cls: "st-proposal" },
    "进行中": { color: "#58a6ff", cls: "st-active" },
    "已结案": { color: "#39c5cf", cls: "st-closed" },
    "暂缓":   { color: "#8b949e", cls: "st-hold" }
  };
  const PRIORITY_STYLE = {
    "高": { color: "#f85149", cls: "pri-high" },
    "中": { color: "#f0883e", cls: "pri-mid" },
    "低": { color: "#3fb950", cls: "pri-low" }
  };
  const SIGNAL_STYLE = {
    "绿灯": { color: "#3fb950", cls: "signal-green" },
    "黄灯": { color: "#f5b301", cls: "signal-yellow" },
    "红灯": { color: "#f85149", cls: "signal-red" }
  };

  // 客户标签预设（数据管理页点选，可自定义更多标签；一个客户可挂多个标签）
  const CUSTOMER_TAG_SUGGESTIONS = ["品牌", "ODM 工厂", "品牌 + ODM", "渠道商"];

  // 产品线预设（数据管理页「产品线」tab 可增删，作为项目录入的建议来源）
  const DEFAULT_PRODUCT_LINES = [
    { id: 1,  name: "PC 大手柄" },
    { id: 2,  name: "双边游戏手柄" },
    { id: 3,  name: "单边游戏手柄" },
    { id: 4,  name: "手游键鼠转换器" },
    { id: 5,  name: "主机键鼠转换器" },
    { id: 6,  name: "手柄转换器" },
    { id: 7,  name: "音频耳机" },
    { id: 8,  name: "AI 智能硬件" },
    { id: 9,  name: "穿戴设备" },
    { id: 10, name: "教育硬件" },
    { id: 11, name: "AR/VR 外设" },
    { id: 12, name: "配件模组" }
  ];

  /* ========================================================================
     七大研发阶段（V2.0 标准化研发体系：样机联调只做底层适配，固件全功能后置 EVT）
     字段：id / name / standard（标准工期）/ progress（阶段完成进度%）/
           mid（预期天数默认中位值）/ milestone（本阶段核心关键里程碑）/ hw / sw / biz（三线工作要点）
     ======================================================================== */
  const STAGES = [
    { id: 1, name: "需求立项", standard: "1-7天", progress: 5, mid: 4,
      milestone: "完成主控芯片选型、整机硬件方案匹配、项目初步成本预估，锁定项目成本与技术准入基线。",
      hw: "需求拆解、硬件方案评估、成本测算、风险研判；输出硬件立项预案",
      sw: "软件需求拆解、平台适配评估、功能难度研判、技术风险梳理",
      biz: "客户需求锁定、报价输出、合同边界确认、立项审批" },
    { id: 2, name: "项目预启动", standard: "1天起", progress: 10, mid: 3,
      milestone: "完成项目全员人力配置落地，输出完整项目研发排期表，项目正式进入研发执行状态。",
      hw: "研发人力盘点、硬件模块任务拆分、研发工时预估",
      sw: "软件人力匹配、开发任务拆解、版本迭代规划",
      biz: "整体项目排期输出、节点责任划分、项目启动宣贯" },
    { id: 3, name: "PEVT技术预研", standard: "3-30天", progress: 20, mid: 17,
      milestone: "输出软硬件整体方案框图、完成项目细化排期，锁定整体技术路线与预研成果。",
      hw: "核心硬件难点预研、Demo 测试、器件参数验证、硬件技术路线固化",
      sw: "环境搭建、SDK 移植、核心协议/低功耗预研、软件架构定型",
      biz: "进度同步客户、方案确认、风险前置沟通" },
    { id: 4, name: "EVT集成验证", standard: "3-60天", progress: 60, mid: 32,
      milestone: "完成硬件配套软件全功能实现，整机功能完整可用，顺利完成 EVT 送样，硬件正式封样定型。",
      hw: "原理图设计、基线冻结、PCB 工程实现、Gerber 输出、样机打样调试、硬件缺陷整改、整机性能优化、最终硬件封样准备",
      sw: "底层驱动开发、基础功能优化、样机底层适配、全业务功能迭代开发、全场景 BUG 收敛、软硬件功能完整适配闭环",
      biz: "BOM 物料确认、打样排期跟进、样机进度同步、客户功能对标、需求最终收口" },
    { id: 5, name: "DVT可靠性验证", standard: "14-30天", progress: 80, mid: 22,
      milestone: "软硬件正式封版，固件版本达到批量试产标准；试产样机可正式对外供给渠道商、KOL 达人市场送样测评。",
      hw: "高低温/震动/EMC/老化全量可靠性测试、硬件一致性优化、批量适配整改",
      sw: "长稳压力测试、极限场景容错优化、自愈机制完善、版本稳定性闭环",
      biz: "测试报告归档、版本冻结公示、渠道送样筹备" },
    { id: 6, name: "PVT量产验证", standard: "7-30天", progress: 90, mid: 19,
      milestone: "最终稳定量产版固件、硬件方案、生产测试工具全部优化到位，产品具备大批量商业化量产交付条件。",
      hw: "小批量试产跟进、良率分析、生产工艺优化、量产硬件标准固化、产线适配整改",
      sw: "量产固件最终定型、批量烧录方案落地、产线适配优化、量产兼容性闭环",
      biz: "量产排期敲定、供应链对接、交付方案确认、量产能力核验" },
    { id: 7, name: "MP量产维护", standard: "7-30天", progress: 100, mid: 19,
      milestone: "项目正式结项归档，产品实现稳定量产交付，建立市场反馈+固件 OTA 长期迭代机制，持续承接批量订单。",
      hw: "量产资料归档、产线问题跟进、工艺持续优化、项目复盘迭代",
      sw: "量产版本归档、建立 OTA 迭代机制、长期 BUG 修复、版本运维支撑",
      biz: "客户验收闭环、持续订单承接、售后对接、市场运营配合" }
  ];

  // 导出字段定义（key 对应数据字段，label 为中文名；含计算字段由页面 exportValue 取值）
  const FIELD_OPTIONS = [
    { key: "name",              label: "项目名称" },
    { key: "summary",           label: "项目简介" },
    { key: "productLine",       label: "产品线" },
    { key: "customer",          label: "客户" },
    { key: "customerTags",      label: "客户标签" },
    { key: "odmFactory",        label: "ODM 工厂" },
    { key: "app",               label: "配套 APP" },
    { key: "proposalDate",      label: "提案日期" },
    { key: "filingDate",        label: "立案日期" },
    { key: "startDate",         label: "启动日期" },
    { key: "dueDate",           label: "预计结案日期" },
    { key: "chips",             label: "核心芯片" },
    { key: "status",            label: "项目状态" },
    { key: "isProductionMaintenance", label: "量产维护" },
    { key: "statusDesc",        label: "项目状态描述" },
    { key: "priority",          label: "优先级" },
    { key: "signal",            label: "信号灯" },
    { key: "signalNote",        label: "信号灯备注" },
    { key: "hwOwner",           label: "硬件负责人" },
    { key: "swOwner",           label: "软件负责人" },
    { key: "pm",                label: "项目经理" },
    { key: "tags",              label: "项目标签" },
    { key: "stage",             label: "当前阶段" },
    { key: "progress",          label: "项目进度" },
    { key: "totalDays",         label: "总工期(天)" },
    { key: "stageDone",         label: "阶段完成情况" },
    { key: "marketExpectation", label: "项目市场预期" }
  ];

  /* ========================================================================
     模拟数据（11 条，可直接替换为真实业务数据）
     字段：id / name / productLine（产品线）/ customer / odmFactory（ODM 工厂）/
           proposalDate / filingDate / startDate（启动日期）/ dueDate / chips / status / statusDesc /
           priority / signal / signalNote /
           statusHistory（状态更新历史 [{date,text}]）/ hwOwner / swOwner /
           marketExpectation
     ======================================================================== */
  const DEFAULT_PROJECTS = [
    {
      id: 1, name: "C1 系列游戏手柄方案", customer: "腾讯游戏",
      productLine: "双边游戏手柄", odmFactory: "", app: "",
      proposalDate: "2026-02-10", filingDate: "2026-03-01", startDate: "2026-03-10", dueDate: "2026-10-30",
      lastCheckAt: Date.now() - 3600000,
      chips: ["杰理 AC6966B", "恒玄 BES2600"],
      status: "进行中", statusDesc: "PCBA 已定型，正在做量产前可靠性测试，进度正常。",
      priority: "高", signal: "黄灯", signalNote: "量产前可靠性测试周期紧，需重点跟踪。",
      statusHistory: [
        { date: "2026-03-01", text: "项目立项，方案评审通过。" },
        { date: "2026-06-15", text: "PCBA 已定型，进入量产前可靠性测试。" },
        { date: "2026-08-18 16:20", text: "新增风险预警：量产前可靠性测试延期风险（关键物料交期紧张）" }
      ],
      hwOwner: "陈志强", swOwner: "林晓峰",
            pm: "陈志强",
      tags: [],
      participants: ["陈志强", "林晓峰", "刘洋"],
      risks: [{id:1, content:"量产前可靠性测试延期风险：关键物料交期紧张", level:"高", createdAt:"2026-08-15 14:30", resolved:false}],
      changes: [{id:1, source:"客户", content:"客户要求新增按键自定义功能", status:"接受", reason:"功能合理，纳入下版迭代", createdAt:"2026-08-12 10:30"}],
      nodes: [
        {id:1, name:"样机硬件底座验证", stage:"EVT集成验证", targetDate:"2026-06-20", output:"首轮样机硬件底座跑通，完成底层适配与基础链路验证", doneDate:"2026-06-18"},
        {id:2, name:"EVT 全功能送测", stage:"EVT集成验证", targetDate:"2026-08-15", output:"整机全功能开发完成，首次全场景送测通过", doneDate:""}
      ],
      customerNodes: [
        {id:1, name:"客户样机验收", targetDate:"2026-06-25", doneDate:"2026-06-23", note:"客户完成首轮样机验收，提出 3 条优化建议"},
        {id:2, name:"客户批量下单确认", targetDate:"2026-09-15", doneDate:"", note:"待量产验证通过后推动客户批量下单"}
      ],
      marketExpectation: "面向主机与手游双平台，预计年出货 80 万台，毛利率约 28%。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:false},{days:"",done:false},{days:"",done:false}]
    },
    {
      id: 2, name: "A200 Pro 无线耳机", customer: "网易严选",
      productLine: "音频耳机", odmFactory: "", app: "",
      proposalDate: "2026-01-15", filingDate: "2026-02-20", dueDate: "2026-09-15",
      lastCheckAt: Date.now() - 8 * 86400000,
      chips: ["中科蓝讯 AB5376", "恒玄 BES2500"],
      status: "进行中", statusDesc: "降噪算法联调中，ANC 深度目标 38dB，需再优化。",
      priority: "高", signal: "黄灯", signalNote: "ANC 降噪深度未达目标，存在延期风险。",
      statusHistory: [
        { date: "2026-02-20", text: "项目立项，方案冻结。" },
        { date: "2026-07-10", text: "降噪算法联调中，ANC 深度未达目标。" },
        { date: "2026-08-16 10:00", text: "新增需求变更（业务·拒绝）：调整目标市场从东南亚改为欧洲" }
      ],
      hwOwner: "陈志强", swOwner: "王雪",
            pm: "陈志强",
      tags: [],
      risks: [{id:1, content:"ANC 降噪深度未达 38dB 目标，存在延期风险", level:"中", createdAt:"2026-08-10 09:20", resolved:false}],
      changes: [{id:1, source:"业务", content:"调整目标市场从东南亚改为欧洲", status:"拒绝", reason:"欧洲认证成本过高", createdAt:"2026-08-08 15:00"}],
      marketExpectation: "主打主动降噪与低延迟，目标东南亚市场，预计年出货 50 万台。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false}]
    },
    {
      id: 3, name: "IX01 AI 录音卡", customer: "字节跳动",
      productLine: "AI 智能硬件", odmFactory: "", app: "",
      proposalDate: "2026-03-05", filingDate: "2026-03-28", dueDate: "2026-12-20",
      chips: ["乐鑫 ESP32-S3", "瑞芯微 RK3566"],
      status: "进行中", statusDesc: "AI 转写功能与云端打通，正在打磨会议场景体验。",
      priority: "中", signal: "绿灯", signalNote: "进度正常，风险可控。",
      statusHistory: [
        { date: "2026-03-28", text: "项目立项，方案确定。" },
        { date: "2026-08-19 09:30", text: "信号灯由绿灯变更为黄灯，需关注转写精度" }
      ],
      hwOwner: "刘洋", swOwner: "张伟",
            pm: "林晓峰",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "结合 AI 转写切入办公与会议场景，以 B 端客户定制为主。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false}]
    },
    {
      id: 4, name: "手柄震动反馈模组", customer: "北通",
      productLine: "配件模组", odmFactory: "", app: "",
      proposalDate: "2025-11-01", filingDate: "2025-11-20", dueDate: "2026-05-30",
      chips: ["杰理 AC700N"],
      status: "已结案", statusDesc: "线性马达触觉反馈方案已量产，客户复购稳定。",
      priority: "低", signal: "绿灯", signalNote: "已量产交付，进入稳定维护。",
      statusHistory: [
        { date: "2025-11-20", text: "项目立项，方案确定。" },
        { date: "2026-05-30", text: "已量产交付，项目结案。" }
      ],
      hwOwner: "刘洋", swOwner: "林晓峰",
            pm: "王雪",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "已进入量产阶段，客户复购稳定，作为基础技术平台沉淀。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true}]
    },
    {
      id: 5, name: "蓝牙键鼠转换器", customer: "海外渠道商",
      productLine: "主机键鼠转换器", odmFactory: "", app: "",
      proposalDate: "2026-02-25", filingDate: "2026-03-10", dueDate: "2026-11-15",
      chips: ["炬芯 ATS2833", "Nordic nRF52840", "全志 H616"],
      status: "进行中", statusDesc: "主机协议适配中，重点攻关低延迟与多设备切换。",
      priority: "高", signal: "红灯", signalNote: "主机协议适配是关键难点，存在延期超 14 天风险。",
      statusHistory: [
        { date: "2026-03-10", text: "项目立项，方案评审通过。" },
        { date: "2026-07-20", text: "主机协议适配攻关中，低延迟未达标。" }
      ],
      hwOwner: "陈志强", swOwner: "黄伟强",
            pm: "陈志强",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "主机 FPS 键鼠转换外设，对标 XIM / Cronus，利润空间较大。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false}]
    },
    {
      id: 6, name: "智能指环（穿戴）", customer: "自研",
      productLine: "穿戴设备", odmFactory: "", app: "",
      proposalDate: "2026-04-01", filingDate: "-", dueDate: "2027-01-30",
      chips: ["Nordic nRF52840"],
      status: "暂缓", statusDesc: "具身智能方向探索，技术验证中，客户需求尚未明确。",
      priority: "中", signal: "黄灯", signalNote: "暂缓推进，需求未明确，待确认。",
      statusHistory: [
        { date: "2026-04-01", text: "项目提案，进入技术验证。" }
      ],
      hwOwner: "刘洋", swOwner: "王雪",
            pm: "林晓峰",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "面向具身智能的穿戴入口，技术储备期，暂缓推进待需求确认。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false}]
    },
    {
      id: 7, name: "智能手写板", customer: "学而思",
      productLine: "教育硬件", odmFactory: "", app: "",
      proposalDate: "2025-10-12", filingDate: "2025-11-05", dueDate: "2026-04-30",
      chips: ["全志 H616"],
      status: "已结案", statusDesc: "儿童教育手写板方案已交付，等待客户二次下单。",
      priority: "低", signal: "绿灯", signalNote: "已交付，等待二次下单。",
      statusHistory: [
        { date: "2025-11-05", text: "项目立项，方案确定。" },
        { date: "2026-04-30", text: "已交付，等待客户二次下单。" }
      ],
      hwOwner: "陈志强", swOwner: "张伟",
            pm: "王雪",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "儿童教育手写板方案，已交付，等待客户二次下单扩大规模。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true}]
    },
    {
      id: 8, name: "AR 眼镜遥控手柄", customer: "某 AR 厂商",
      productLine: "AR/VR 外设", odmFactory: "", app: "",
      proposalDate: "2026-03-18", filingDate: "-", dueDate: "-",
      createdAt: "2026-08-10 14:00",
      chips: ["杰理 AC700N", "Nordic nRF52840"],
      status: "暂缓", statusDesc: "配合 AR 眼镜的 3D 手柄，硬件成本偏高，待供应链优化。",
      priority: "中", signal: "红灯", signalNote: "硬件成本偏高，关键物料供应链待优化。",
      statusHistory: [
        { date: "2026-03-18", text: "项目提案，硬件成本评估中。" }
      ],
      hwOwner: "刘洋", swOwner: "黄伟强",
            pm: "张伟",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "AR 生态外设布局，成本较高，待供应链与客户需求成熟。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false}]
    },
    {
      id: 9, name: "电竞耳机 7.1 声道", customer: "自营品牌",
      productLine: "音频耳机", odmFactory: "", app: "",
      proposalDate: "2026-02-01", filingDate: "2026-02-22", dueDate: "2026-10-10",
      chips: ["炬芯 ATS2833", "中科蓝讯 AB5376"],
      status: "进行中", statusDesc: "虚拟 7.1 声道算法移植完成，音效调校阶段。",
      priority: "中", signal: "绿灯", signalNote: "进度正常，音效调校中。",
      statusHistory: [
        { date: "2026-02-22", text: "项目立项，方案确定。" },
        { date: "2026-06-30", text: "7.1 声道算法移植完成，进入音效调校。" }
      ],
      hwOwner: "陈志强", swOwner: "林晓峰",
            pm: "陈志强",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "虚拟 7.1 声道电竞耳机，主打国内直播与电竞用户群体。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:false},{days:"",done:false}]
    },
    {
      id: 10, name: "儿童智能手表方案", customer: "步步高",
      productLine: "穿戴设备", odmFactory: "", app: "",
      proposalDate: "2025-09-01", filingDate: "2025-09-20", dueDate: "2026-03-30",
      chips: ["展锐 SC9863A"],
      status: "已结案", statusDesc: "儿童定位手表方案已结案交付，进入售后维护期。",
      priority: "低", signal: "绿灯", signalNote: "已结案，售后维护中。",
      statusHistory: [
        { date: "2025-09-20", text: "项目立项，方案确定。" },
        { date: "2026-03-30", text: "已结案交付，进入售后维护。" }
      ],
      hwOwner: "刘洋", swOwner: "王雪",
            pm: "王雪",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "儿童定位手表方案，已交付结案，进入售后维护期。",
      stages: [{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true},{days:"",done:true}]
    },
    {
      id: 11, name: "体感健身环手柄", customer: "自研",
      productLine: "配件模组", odmFactory: "", app: "",
      proposalDate: "2026-07-20", filingDate: "-", dueDate: "-",
      createdAt: "2026-08-05 09:30",
      chips: ["杰理 AC6966B"],
      status: "提案中", statusDesc: "结合运动健身的手柄体感方案，需求调研与可行性评估中。",
      priority: "中", signal: "黄灯", signalNote: "提案阶段，需求尚在调研，待评估。",
      statusHistory: [
        { date: "2026-07-20", text: "项目提案，需求调研中。" }
      ],
      hwOwner: "陈志强", swOwner: "王雪",
            pm: "林晓峰",
      tags: [],
      risks: [],
      changes: [],
      marketExpectation: "健身场景体感外设，需求尚在调研，具备差异化切入空间。",
      stages: [{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false},{days:"",done:false}]
    }
  ];

  /* ========================================================================
     客户库（默认数据仅含名称与公开可判断的类型，联系人 / 背景信息由用户在「数据管理」页录入）
     字段：id / name（客户名称，唯一）/ type（客户类型：品牌 / ODM 工厂 / 品牌 + ODM / 渠道商，可为空）/
           contact（主要联系人）/ background（客户背景）
     ======================================================================== */
  const DEFAULT_CUSTOMERS = [
    { id: 1,  name: "腾讯游戏",   tags: ["品牌"],   contact: "", background: "" },
    { id: 2,  name: "网易严选",   tags: ["品牌"],   contact: "", background: "" },
    { id: 3,  name: "字节跳动",   tags: ["品牌"],   contact: "", background: "" },
    { id: 4,  name: "北通",       tags: ["品牌"],   contact: "", background: "" },
    { id: 5,  name: "海外渠道商", tags: ["渠道商"], contact: "", background: "" },
    { id: 6,  name: "自研",       tags: [],       contact: "", background: "" },
    { id: 7,  name: "学而思",     tags: ["品牌"],   contact: "", background: "" },
    { id: 8,  name: "某 AR 厂商", tags: ["品牌"],   contact: "", background: "" },
    { id: 9,  name: "自营品牌",   tags: ["品牌"],   contact: "", background: "" },
    { id: 10, name: "步步高",     tags: ["品牌"],   contact: "", background: "" }
  ];

  /* ========================================================================
     工程师库（默认数据为现有项目负责人姓名，角色由用户录入）
     字段：id / name（姓名，唯一）/ role（角色，如：硬件负责人 / 软件负责人 / 结构 / 测试）
     ======================================================================== */
  const DEFAULT_ENGINEERS = [
    { id: 1, name: "陈志强", role: "" },
    { id: 2, name: "林晓峰", role: "" },
    { id: 3, name: "王雪",   role: "" },
    { id: 4, name: "刘洋",   role: "" },
    { id: 5, name: "张伟",   role: "" },
    { id: 6, name: "黄伟强", role: "" }
  ];

  // 角色建议（datalist 用，可自由输入）
  const ENGINEER_ROLE_SUGGESTIONS = [
    "硬件负责人", "软件负责人", "嵌入式硬件工程师", "嵌入式软件工程师",
    "App 开发工程师", "前端工程师", "后端工程师", "测试工程师",
    "结构工程师", "产品经理", "项目经理"
  ];

  /* ========================================================================
     配套 APP 库（默认为空，由用户在「数据管理」页录入）
     字段：id / name（App 名称，唯一）/ desc（App 描述）/ version（版本信息）
     ======================================================================== */
  const DEFAULT_APPS = [];

  /* ========================================================================
     项目标签库（默认为空，由用户在「数据管理」页录入）
     字段：id / name（标签名称，唯一）
     ======================================================================== */
  const DEFAULT_TAGS = [];

  /* ========================================================================
     项目分组库（默认一组 / 二组 / 三组，可在「数据管理」页新增）
     字段：id / name（分组名称，唯一）
     ======================================================================== */
  const DEFAULT_GROUPS = [
    { id: 1, name: "一组" },
    { id: 2, name: "二组" },
    { id: 3, name: "三组" }
  ];

  /* ========================================================================
     核心芯片库（默认预置项目已用到的芯片型号，可在「数据管理」页新增）
     字段：id / name（芯片型号，唯一，必填）/
           originalModel（芯片原始型号，选填）/
           manufacturer（原厂信息，选填）/
           firmwareVersion（固件版本名称，选填）
     ======================================================================== */
  const DEFAULT_CHIPS = [
    { id: 1,  name: "杰理 AC6966B",     originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 2,  name: "恒玄 BES2600",     originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 3,  name: "中科蓝讯 AB5376",  originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 4,  name: "恒玄 BES2500",     originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 5,  name: "乐鑫 ESP32-S3",    originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 6,  name: "瑞芯微 RK3566",    originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 7,  name: "杰理 AC700N",      originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 8,  name: "炬芯 ATS2833",     originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 9,  name: "Nordic nRF52840",  originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 10, name: "全志 H616",        originalModel: "", manufacturer: "", firmwareVersion: "" },
    { id: 11, name: "展锐 SC9863A",     originalModel: "", manufacturer: "", firmwareVersion: "" }
  ];

  /* ========================================================================
     企业信息（在「基础信息管理」页维护，显示在看板副标题与会议纪要中）
     字段：fullName（企业全称）/ shortName（企业简称）/ manager（当前项目管理人）/ namePrefix（看板系统名称前缀，默认「智能硬件」，标题=前缀+「项目看板系统」）
     ======================================================================== */
  const DEFAULT_COMPANY = {
    fullName: "AI科技有限公司",
    shortName: "AI科技",
    manager: "李经理",
    namePrefix: "智能硬件"
  };

  /* ---- 读写逻辑 ---- */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (e) { /* 忽略，回退默认 */ }
    return JSON.parse(JSON.stringify(DEFAULT_PROJECTS));
  }

  function save(projects) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }

  function reset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }

  // ---- 客户库 / 工程师库读写 ----
  function loadCollection(key, defaults) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (e) { /* 忽略，回退默认 */ }
    return JSON.parse(JSON.stringify(defaults));
  }

  function loadCustomers() {
    const list = loadCollection(STORAGE_KEY_CUSTOMERS, DEFAULT_CUSTOMERS);
    // 兼容旧版单选 type 字段：迁移为 tags 数组
    list.forEach(c => {
      if (!Array.isArray(c.tags)) {
        c.tags = (c.type && c.type !== "") ? [c.type] : [];
      }
      delete c.type;
    });
    return list;
  }
  function saveCustomers(list) {
    try { localStorage.setItem(STORAGE_KEY_CUSTOMERS, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }
  function loadEngineers() { return loadCollection(STORAGE_KEY_ENGINEERS, DEFAULT_ENGINEERS); }
  function saveEngineers(list) {
    try { localStorage.setItem(STORAGE_KEY_ENGINEERS, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }
  function loadProductLines() { return loadCollection(STORAGE_KEY_PRODUCT_LINES, DEFAULT_PRODUCT_LINES); }
  function saveProductLines(list) {
    try { localStorage.setItem(STORAGE_KEY_PRODUCT_LINES, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }
  function loadApps() { return loadCollection(STORAGE_KEY_APPS, DEFAULT_APPS); }
  function saveApps(list) {
    try { localStorage.setItem(STORAGE_KEY_APPS, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }
  function loadTags() { return loadCollection(STORAGE_KEY_TAGS, DEFAULT_TAGS); }
  function saveTags(list) {
    try { localStorage.setItem(STORAGE_KEY_TAGS, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }
  function loadGroups() { return loadCollection(STORAGE_KEY_GROUPS, DEFAULT_GROUPS); }
  function saveGroups(list) {
    try { localStorage.setItem(STORAGE_KEY_GROUPS, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }
  function loadChips() { return loadCollection(STORAGE_KEY_CHIPS, DEFAULT_CHIPS); }
  function saveChips(list) {
    try { localStorage.setItem(STORAGE_KEY_CHIPS, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }

  // ---- 企业信息读写 ----
  function loadCompany() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_COMPANY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
          return {
            fullName: obj.fullName != null ? obj.fullName : DEFAULT_COMPANY.fullName,
            shortName: obj.shortName != null ? obj.shortName : DEFAULT_COMPANY.shortName,
            manager: obj.manager != null ? obj.manager : DEFAULT_COMPANY.manager,
            namePrefix: obj.namePrefix != null ? obj.namePrefix : DEFAULT_COMPANY.namePrefix
          };
        }
      }
    } catch (e) { /* 忽略，回退默认 */ }
    return { ...DEFAULT_COMPANY };
  }
  function saveCompany(info) {
    try { localStorage.setItem(STORAGE_KEY_COMPANY, JSON.stringify(info || DEFAULT_COMPANY)); } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }

  // 对导入或级联更新执行尽力而为的原子写入：任一项失败即恢复写入前快照。
  function saveBusinessDataAtomic(partial) {
    const mapping = {
      projects: STORAGE_KEY, customers: STORAGE_KEY_CUSTOMERS, engineers: STORAGE_KEY_ENGINEERS,
      productLines: STORAGE_KEY_PRODUCT_LINES, apps: STORAGE_KEY_APPS, tags: STORAGE_KEY_TAGS,
      groups: STORAGE_KEY_GROUPS, chips: STORAGE_KEY_CHIPS, company: STORAGE_KEY_COMPANY
    };
    const entries = Object.keys(mapping)
      .filter(key => Object.prototype.hasOwnProperty.call(partial || {}, key))
      .map(key => [mapping[key], partial[key]]);
    const before = new Map(entries.map(([key]) => [key, localStorage.getItem(key)]));
    try {
      entries.forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(value)));
    } catch (error) {
      entries.forEach(([key]) => {
        const previous = before.get(key);
        if (previous == null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      });
      throw error;
    }
    scheduleAutoBackup();
  }

  // 重置全部数据（项目 / 客户库 / 工程师库 / 产品线库 / APP 库 / 标签库 / 企业信息）
  function resetAll() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY_CUSTOMERS);
      localStorage.removeItem(STORAGE_KEY_ENGINEERS);
      localStorage.removeItem(STORAGE_KEY_PRODUCT_LINES);
      localStorage.removeItem(STORAGE_KEY_APPS);
      localStorage.removeItem(STORAGE_KEY_TAGS);
      localStorage.removeItem(STORAGE_KEY_GROUPS);
      localStorage.removeItem(STORAGE_KEY_CHIPS);
      localStorage.removeItem(STORAGE_KEY_COMPANY);
    } catch (e) { /* 忽略 */ }
    scheduleAutoBackup();
  }

  // ======================================================================
  // 自动备份：数据每次更新后自动生成一份 .bak（写入用户指定备份文件夹）
  // 文件名含日期 + 时刻 + 随机数；每天最多保留 N 份，超出滚动删除最早的
  // ======================================================================
  const AUTO_BACKUP_KEY = "hw_project_board_auto_backup_v1";
  const FS_IDB_NAME = "hw_project_board_fs";
  const FS_IDB_STORE = "handles";

  function loadAutoBackupConfig() {
    const def = { enabled: true, maxPerDay: 3 };
    try {
      const raw = localStorage.getItem(AUTO_BACKUP_KEY);
      if (raw) return Object.assign(def, JSON.parse(raw));
    } catch (e) {}
    return def;
  }
  function saveAutoBackupConfig(cfg) {
    try { localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  function fsIdbOpen() {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(FS_IDB_NAME, 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore(FS_IDB_STORE); } catch (e) {} };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }
  async function fsIdbGet(key) {
    try {
      const db = await fsIdbOpen();
      return await new Promise(resolve => {
        const tx = db.transaction(FS_IDB_STORE, "readonly");
        const req = tx.objectStore(FS_IDB_STORE).get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); resolve(null); };
      });
    } catch (e) { return null; }
  }
  async function fsIdbPut(key, value) {
    try {
      const db = await fsIdbOpen();
      return await new Promise(resolve => {
        const tx = db.transaction(FS_IDB_STORE, "readwrite");
        tx.objectStore(FS_IDB_STORE).put(value, key);
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); resolve(false); };
      });
    } catch (e) { return false; }
  }
  async function loadBackupDirHandle() {
    return fsIdbGet("backupDir");
  }
  async function writeBackupFile(filename, content) {
    const handle = await loadBackupDirHandle();
    if (!handle) return false;
    try {
      const fh = await handle.getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
      return true;
    } catch (e) { return false; }
  }
  function loadBackupPreferences() {
    const result = {};
    BACKUP_PREFERENCE_KEYS.forEach(key => {
      try {
        const value = localStorage.getItem(key);
        if (value != null) result[key] = value;
      } catch (e) { /* 单项读取失败不阻断业务数据备份 */ }
    });
    return result;
  }
  function restoreBackupPreferences(preferences) {
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return;
    BACKUP_PREFERENCE_KEYS.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(preferences, key)) return;
      const value = preferences[key];
      if (typeof value !== "string") return;
      localStorage.setItem(key, value);
    });
  }
  function buildBackupData(projectOverride) {
    return {
      version: BACKUP_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      exportedAt: todayTimeStr(),
      projects: Array.isArray(projectOverride) ? projectOverride : load(),
      customers: loadCustomers(),
      engineers: loadEngineers(),
      productLines: loadProductLines(),
      apps: loadApps(),
      tags: loadTags(),
      groups: loadGroups(),
      chips: loadChips(),
      company: loadCompany(),
      preferences: loadBackupPreferences()
    };
  }

  function validateBackupCollection(value, label) {
    if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
    const ids = new Set();
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}第 ${index + 1} 条不是对象`);
      const id = Number(item.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`${label}第 ${index + 1} 条的 id 必须是正整数`);
      if (ids.has(id)) throw new Error(`${label}存在重复 id：${id}`);
      ids.add(id);
      const name = String(item.name == null ? "" : item.name).trim();
      if (!name) throw new Error(`${label}第 ${index + 1} 条缺少名称`);
      return Object.assign({}, item, { id, name });
    });
  }

  function validateBackupData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("备份根节点必须是对象");
    if (!Array.isArray(data.projects)) throw new Error("缺少 projects 数组");
    const ids = new Set();
    const projects = data.projects.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`项目第 ${index + 1} 条不是对象`);
      const id = Number(item.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`项目第 ${index + 1} 条的 id 必须是正整数`);
      if (ids.has(id)) throw new Error(`项目存在重复 id：${id}`);
      ids.add(id);
      const name = String(item.name == null ? "" : item.name).trim();
      if (!name) throw new Error(`项目第 ${index + 1} 条缺少项目名称`);
      return Object.assign({}, item, {
        id, name,
        status: STATUS_LIST.includes(item.status) ? item.status : "提案中",
        priority: PRIORITY_LIST.includes(item.priority) ? item.priority : "中",
        signal: SIGNAL_LIST.includes(item.signal) ? item.signal : "绿灯",
        chips: normalizeChips(item.chips), tags: normalizeChips(item.tags), participants: normalizeChips(item.participants),
        stages: normalizeStages(item.stages), risks: normalizeRisks(item.risks), changes: normalizeChanges(item.changes),
        delays: normalizeDelays(item.delays), nodes: normalizeNodes(item.nodes), customerNodes: normalizeCustomerNodes(item.customerNodes),
        statusHistory: normalizeHistory(item.statusHistory), isDelayed: !!item.isDelayed,
        summary: String(item.summary || ""),
        ...(Array.isArray(item.statusDescHistory) ? { statusDescHistory: normalizeStatusDescriptionHistory(item.statusDescHistory) } : {}),
        // 量产维护是已结案项目的受控标识；旧数据或不一致导入均安全回退为未标识。
        isProductionMaintenance: item.status === "已结案" && item.isProductionMaintenance === true
      });
    });
    const output = Object.assign({}, data, { version: Number(data.version) || 1, projects });
    const collections = [
      ["customers", "客户"], ["engineers", "工程师"], ["productLines", "产品线"], ["apps", "APP"],
      ["tags", "标签"], ["groups", "分组"], ["chips", "芯片"]
    ];
    collections.forEach(([key, label]) => {
      if (data[key] !== undefined) output[key] = validateBackupCollection(data[key], label);
    });
    if (data.company !== undefined) {
      if (!data.company || typeof data.company !== "object" || Array.isArray(data.company)) throw new Error("企业信息必须是对象");
      output.company = {
        fullName: String(data.company.fullName || ""), shortName: String(data.company.shortName || ""),
        manager: String(data.company.manager || ""), namePrefix: String(data.company.namePrefix || "智能硬件")
      };
    }
    if (data.preferences !== undefined) {
      if (!data.preferences || typeof data.preferences !== "object" || Array.isArray(data.preferences)) throw new Error("偏好设置必须是对象");
      output.preferences = {};
      BACKUP_PREFERENCE_KEYS.forEach(key => {
        if (typeof data.preferences[key] === "string") output.preferences[key] = data.preferences[key];
      });
    }
    return output;
  }

  // ======================================================================
  // 主动项目数据库：每个新会话由欢迎页打开或新建；业务写入后自动回写。
  // IndexedDB 只保存文件句柄和上次位置，localStorage 仅作为当前会话缓存与故障恢复副本。
  // ======================================================================
  let activeDatabaseHandleCache = null;
  let databaseAutosaveTimer = null;
  function databaseSession() {
    try { return JSON.parse(sessionStorage.getItem(DATABASE_SESSION_KEY) || "null"); }
    catch (e) { return null; }
  }
  function hasActiveDatabaseSession() {
    const session = databaseSession();
    return !!(session && session.mode === "file" && session.name);
  }
  function setDatabaseSession(handle, state) {
    const session = { mode: "file", name: handle.name || "GeekDash项目数据库", state: state || "saved", openedAt: todayTimeStr(), savedAt: state === "saved" ? todayTimeStr() : "" };
    try { sessionStorage.setItem(DATABASE_SESSION_KEY, JSON.stringify(session)); } catch (e) {}
    window.dispatchEvent(new CustomEvent("geekdash-database-status", { detail: session }));
    return session;
  }
  function updateDatabaseSession(patch) {
    const next = Object.assign({}, databaseSession() || {}, patch || {});
    try { sessionStorage.setItem(DATABASE_SESSION_KEY, JSON.stringify(next)); } catch (e) {}
    window.dispatchEvent(new CustomEvent("geekdash-database-status", { detail: next }));
    return next;
  }
  function fullDatabasePayload(validated) {
    const clone = value => JSON.parse(JSON.stringify(value));
    return {
      projects: clone(validated.projects || []),
      customers: clone(validated.customers !== undefined ? validated.customers : DEFAULT_CUSTOMERS),
      engineers: clone(validated.engineers !== undefined ? validated.engineers : DEFAULT_ENGINEERS),
      productLines: clone(validated.productLines !== undefined ? validated.productLines : DEFAULT_PRODUCT_LINES),
      apps: clone(validated.apps !== undefined ? validated.apps : DEFAULT_APPS),
      tags: clone(validated.tags !== undefined ? validated.tags : DEFAULT_TAGS),
      groups: clone(validated.groups !== undefined ? validated.groups : DEFAULT_GROUPS),
      chips: clone(validated.chips !== undefined ? validated.chips : DEFAULT_CHIPS),
      company: clone(validated.company !== undefined ? validated.company : DEFAULT_COMPANY)
    };
  }
  function applyOpenedDatabase(validated) {
    saveBusinessDataAtomic(fullDatabasePayload(validated));
    if (validated.preferences) restoreBackupPreferences(validated.preferences);
  }
  async function rememberDatabaseHandle(handle) {
    activeDatabaseHandleCache = handle;
    await fsIdbPut(DATABASE_HANDLE_IDB_KEY, handle);
    await fsIdbPut(DATABASE_LAST_HANDLE_KEY, handle);
  }
  async function getActiveDatabaseHandle() {
    if (activeDatabaseHandleCache) return activeDatabaseHandleCache;
    activeDatabaseHandleCache = await fsIdbGet(DATABASE_HANDLE_IDB_KEY);
    return activeDatabaseHandleCache;
  }
  async function ensureDatabaseWritePermission(handle) {
    if (typeof handle.queryPermission !== "function") return;
    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted" && typeof handle.requestPermission === "function") permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("未获得数据库文件写入权限，无法启用自动保存");
  }
  async function writeDatabaseHandle(handle, payload) {
    if (!handle || typeof handle.createWritable !== "function") throw new Error("数据库文件不可写");
    await ensureDatabaseWritePermission(handle);
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
  }
  async function openProjectDatabaseHandle(handle) {
    if (!handle || typeof handle.getFile !== "function") throw new Error("请选择有效的 GeekDash 项目数据库文件");
    await ensureDatabaseWritePermission(handle);
    const file = await handle.getFile();
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (error) { throw new Error("数据库文件不是有效的 JSON 格式"); }
    const validated = validateBackupData(parsed);
    applyOpenedDatabase(validated);
    await rememberDatabaseHandle(handle);
    setDatabaseSession(handle, "saved");
    return { name: handle.name || file.name, projects: validated.projects.length };
  }
  async function pickerWithRememberedLocation(kind, options) {
    const picker = kind === "open" ? window.showOpenFilePicker : window.showSaveFilePicker;
    if (typeof picker !== "function") throw new Error("当前浏览器不支持直接读写数据库文件，请使用最新版 Chrome 或 Edge 打开 GeekDash");
    const lastHandle = await fsIdbGet(DATABASE_LAST_HANDLE_KEY);
    const withStart = lastHandle ? Object.assign({}, options, { startIn: lastHandle }) : options;
    try { return await picker.call(window, withStart); }
    catch (error) {
      if (lastHandle && error && error.name === "TypeError") return picker.call(window, options);
      throw error;
    }
  }
  async function openProjectDatabasePicker() {
    const result = await pickerWithRememberedLocation("open", {
      multiple: false,
      types: [{ description: "GeekDash 项目数据库", accept: { "application/json": [".json", ".bak", ".geekdash"] } }]
    });
    const handle = Array.isArray(result) ? result[0] : result;
    return openProjectDatabaseHandle(handle);
  }
  function emptyDatabasePayload() {
    return { version: BACKUP_SCHEMA_VERSION, appVersion: APP_VERSION, exportedAt: todayTimeStr(), projects: [], customers: [], engineers: [], productLines: [], apps: [], tags: [], groups: [], chips: [], company: Object.assign({}, DEFAULT_COMPANY), preferences: loadBackupPreferences() };
  }
  async function createProjectDatabasePicker(useCurrentData) {
    const handle = await pickerWithRememberedLocation("save", {
      suggestedName: `GeekDash项目数据库_${todayStr()}.geekdash.json`,
      types: [{ description: "GeekDash 项目数据库", accept: { "application/json": [".json"] } }]
    });
    const payload = useCurrentData ? buildBackupData() : emptyDatabasePayload();
    await writeDatabaseHandle(handle, payload);
    if (!useCurrentData) applyOpenedDatabase(validateBackupData(payload));
    await rememberDatabaseHandle(handle);
    setDatabaseSession(handle, "saved");
    return { name: handle.name, projects: payload.projects.length };
  }
  async function saveActiveProjectDatabase() {
    if (!hasActiveDatabaseSession()) return false;
    const handle = await getActiveDatabaseHandle();
    if (!handle) throw new Error("当前数据库文件句柄已失效，请返回首页重新打开数据库");
    try {
      await writeDatabaseHandle(handle, buildBackupData());
      updateDatabaseSession({ state: "saved", savedAt: todayTimeStr(), error: "" });
      return true;
    } catch (error) {
      updateDatabaseSession({ state: "error", error: error.message || String(error) });
      window.dispatchEvent(new CustomEvent("geekdash-database-save-error", { detail: { message: error.message || String(error) } }));
      throw error;
    }
  }
  function scheduleDatabaseAutosave() {
    if (!hasActiveDatabaseSession()) return;
    updateDatabaseSession({ state: "saving" });
    if (databaseAutosaveTimer) clearTimeout(databaseAutosaveTimer);
    databaseAutosaveTimer = setTimeout(() => {
      databaseAutosaveTimer = null;
      saveActiveProjectDatabase().catch(error => console.error("项目数据库自动保存失败", error));
    }, 500);
  }
  function autoBackupFileName() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    const rnd = Math.random().toString(36).slice(2, 6);
    return `GeekDash自动备份_${stamp}_${rnd}.bak`;
  }
  async function pruneAutoBackups(handle, maxPerDay) {
    const prefix = `GeekDash自动备份_${todayStr()}_`;
    try {
      const names = [];
      for await (const name of handle.keys()) {
        if (name.startsWith(prefix)) names.push(name);
      }
      names.sort();
      while (names.length > maxPerDay) {
        const oldest = names.shift();
        try { await handle.removeEntry(oldest); } catch (e) { break; }
      }
    } catch (e) { /* 忽略清理失败 */ }
  }
  async function runAutoBackup() {
    const cfg = loadAutoBackupConfig();
    if (!cfg.enabled) return;
    const maxPerDay = Math.min(10, Math.max(3, parseInt(cfg.maxPerDay, 10) || 3));
    const handle = await loadBackupDirHandle();
    if (!handle) return; // 未设置备份文件夹，静默跳过
    const fname = autoBackupFileName();
    const ok = await writeBackupFile(fname, JSON.stringify(buildBackupData(), null, 2));
    if (ok) await pruneAutoBackups(handle, maxPerDay);
  }
  let _autoBackupTimer = null;
  function scheduleAutoBackup() {
    scheduleDatabaseAutosave();
    if (_autoBackupTimer) clearTimeout(_autoBackupTimer);
    _autoBackupTimer = setTimeout(() => { _autoBackupTimer = null; runAutoBackup(); }, 1200);
  }

  // 生成新 id（集合内最大 id + 1，空集合从 1 开始）
  function nextId(collection) {
    return collection.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  }

  // 规范化 chips：过滤空值 / "-"，返回字符串数组
  function normalizeChips(v) {
    if (!Array.isArray(v)) return [];
    return v.map(c => String(c).trim()).filter(c => c && c !== "-");
  }

  // 芯片名称业务键：兼容全/半角、大小写及多余空白，但不改写用户展示名称。
  function chipNameKey(value) {
    const text = String(value == null ? "" : value).trim();
    const normalized = typeof text.normalize === "function" ? text.normalize("NFKC") : text;
    return normalized.replace(/\s+/g, " ").toLowerCase();
  }

  // 规范化状态历史：确保是数组，每条含 date/text
  function normalizeHistory(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(h => h && h.text).map(h => ({ date: h.date || "", text: h.text }));
  }

  function normalizeStatusDescriptionHistory(v) {
    return Array.isArray(v) ? v.filter(h => h && typeof h.text === "string")
      .map(h => ({ date: String(h.date || ""), text: h.text })) : [];
  }
  function statusDescriptionHistory(p) {
    if (Array.isArray(p.statusDescHistory)) return normalizeStatusDescriptionHistory(p.statusDescHistory);
    return p.statusDesc ? [{ date: p.statusDescUpdatedAt || "", text: String(p.statusDesc) }] : [];
  }
  function updateStatusDescription(p, text, date = todayTimeStr()) {
    text = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    if (text === String(p.statusDesc || "")) return false;
    if (!Array.isArray(p.statusDescHistory)) {
      p.statusDescHistory = statusDescriptionHistory(p);
      p.statusDescLegacyHistoryCount = normalizeHistory(p.statusHistory).length;
    }
    p.statusDescHistory.push({ date, text });
    p.statusDesc = text;
    p.statusDescUpdatedAt = date;
    return true;
  }

  // 仅解析最新状态描述；选择候选时会自动插入空格分隔姓名。
  function statusEngineers(p) {
    return [...new Set(Array.from(String(p.statusDesc || "").matchAll(/@([^\s@，,。；;：:！？!?（）()\[\]【】、<>]+)/gu), m => m[1]))];
  }
  function addStatusEngineer(name) {
    const engineers = loadEngineers();
    const existing = engineers.find(e => e.name === name);
    if (existing) return existing;
    const engineer = { id: nextId(engineers), name, role: "" };
    engineers.push(engineer);
    saveBusinessDataAtomic({ engineers });
    return engineer;
  }

  // 规范化阶段状态：对齐 STAGES 七阶段，返回 [{days, done, note, doneDate, startDate, expectedEndDate}] 数组
  function normalizeStages(v) {
    return STAGES.map((s, i) => {
      const d = Array.isArray(v) ? v[i] : null;
      return {
        days: (d && d.days) ? String(d.days) : "",
        done: !!(d && d.done),
        note: (d && d.note) ? String(d.note) : "",
        doneDate: (d && d.doneDate) ? String(d.doneDate) : "",
        startDate: (d && d.startDate) ? String(d.startDate) : "",
        expectedEndDate: (d && d.expectedEndDate) ? String(d.expectedEndDate) : ""
      };
    });
  }

  // 规范化里程碑节点：确保是数组，每条含 id/stageId/name/日期/prevId/nextId/x/y/children（子节点）
  function normalizeMilestones(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(m => m && typeof m === "object").map(m => ({
      id: m.id || 0,
      stageId: m.stageId || 0,
      name: String(m.name || ""),
      startDate: m.startDate || "",
      expectedEndDate: m.expectedEndDate || "",
      actualEndDate: m.actualEndDate || "",
      note: String(m.note || ""),
      prevId: m.prevId != null ? m.prevId : null,
      nextId: m.nextId != null ? m.nextId : null,
      x: m.x != null ? m.x : null,
      y: m.y != null ? m.y : null,
      children: Array.isArray(m.children) ? m.children.filter(c => c && typeof c === "object").map(c => ({
        id: c.id || 0,
        name: String(c.name || ""),
        startDate: c.startDate || "",
        expectedEndDate: c.expectedEndDate || "",
        actualEndDate: c.actualEndDate || "",
        note: String(c.note || "")
      })) : []
    }));
  }

  // 规范化风险预警：确保是数组，每条含 id/content/level/createdAt/resolved/resolveMethod/resolvedAt
  function normalizeRisks(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(r => r && typeof r === "object").map(r => ({
      id: r.id || 0,
      content: String(r.content || ""),
      level: RISK_LEVEL_LIST.indexOf(r.level) >= 0 ? r.level : "中",
      createdAt: r.createdAt || "",
      updatedAt: r.updatedAt || "",
      resolved: !!r.resolved,
      resolveMethod: r.resolveMethod || "",
      resolvedAt: r.resolvedAt || ""
    }));
  }

  // 规范化需求变更：确保是数组，每条含 id/source/content/status/reason/createdAt
  function normalizeChanges(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(r => r && typeof r === "object").map(r => ({
      id: r.id || 0,
      source: String(r.source || "客户"),
      content: String(r.content || ""),
      status: String(r.status || "接受"),
      reason: String(r.reason || ""),
      createdAt: r.createdAt || "",
      updatedAt: r.updatedAt || ""
    }));
  }

  // 规范化延期记录：确保是数组，每条含 id/reason/newTargetDate/measures/createdAt
  function normalizeDelays(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(r => r && typeof r === "object").map(r => ({
      id: r.id || 0,
      reason: String(r.reason || ""),
      newTargetDate: r.newTargetDate || "",
      measures: String(r.measures || ""),
      createdAt: r.createdAt || ""
    }));
  }

  // 规范化项目节点：确保是数组，每条含 id/name/stage/stageId/targetDate/output/doneDate（附 Flow 编排坐标 x/y）
  // stageId 用于把节点挂到 STAGES 七大阶段泳道；优先取 n.stageId，否则用 stage 名反查 id（兼容存量数据），查不到归 0
  function normalizeNodes(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(n => n && typeof n === "object").map(n => {
      const stageName = String(n.stage || "").trim();
      let stageId = (n.stageId != null && Number(n.stageId) > 0) ? Number(n.stageId) : 0;
      if (!stageId && stageName) {
        const s = STAGES.find(x => x.name === stageName);
        if (s) stageId = s.id;
      }
      return {
        id: n.id || 0,
        name: String(n.name || ""),
        stage: stageName || (stageId ? ((STAGES.find(x => x.id === stageId) || {}).name || "") : ""),
        stageId,
        targetDate: n.targetDate || "",
        output: String(n.output || ""),
        doneDate: n.doneDate || "",
        prevId: n.prevId != null ? n.prevId : null,
        nextId: n.nextId != null ? n.nextId : null,
        x: n.x != null ? n.x : null,
        y: n.y != null ? n.y : null
      };
    });
  }

  // 规范化客户项目节点：确保是数组，每条含 id/name/targetDate/doneDate/note
  function normalizeCustomerNodes(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(n => n && typeof n === "object").map(n => ({
      id: n.id || 0,
      name: String(n.name || ""),
      targetDate: n.targetDate || "",
      doneDate: n.doneDate || "",
      note: String(n.note || "")
    }));
  }

  // 当前进行中的阶段：第一个未完成阶段（全部完成返回 null）
  function currentStage(p) {
    const stages = normalizeStages(p.stages);
    const idx = stages.findIndex(s => !s.done);
    if (idx < 0) return null;
    return { index: idx, stage: STAGES[idx], data: stages[idx] };
  }

  // 项目整体进度：按阶段完成情况估算（用于卡片进度指示）
  function projectProgress(p) {
    const stages = normalizeStages(p.stages);
    const doneCount = stages.filter(s => s.done).length;
    if (doneCount === 0) return 0;
    if (doneCount >= stages.length) return 100;
    return STAGES[doneCount - 1].progress; // 返回最近完成阶段的进度占比
  }

  // 跨页面共享的项目派生状态，避免报表页与主看板各自维护不同口径。
  function latestTargetDate(p) {
    const delays = normalizeDelays(p && p.delays);
    if (delays.length) return delays[delays.length - 1].newTargetDate || "";
    return (p && p.dueDate) || "";
  }
  function isProjectDelayed(p) {
    return projectDelayState(p) === "overdue";
  }
  function isProductionMaintenance(p) {
    return !!(p && p.status === "已结案" && p.isProductionMaintenance);
  }
  function hasDelay(p) {
    return isProjectDelayed(p);
  }
  function latestProjectStatus(p) {
    return (p && p.statusDesc) || "-";
  }
  function projectStageName(p) {
    const current = currentStage(p || {});
    return current ? current.stage.name : "已全部完成";
  }
  function projectDelayState(p) {
    if (p && p.status === "已结案") return "closed";
    const due = p && p.dueDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due || "")) return "unknown";
    const date = new Date(due + "T00:00:00");
    if (isNaN(date.getTime()) || [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-") !== due) return "unknown";
    return todayStr() > due ? "overdue" : "normal";
  }
  function projectDelayText(state) {
    return state === "overdue" ? "延期" : state === "normal" ? "正常" : state === "closed" ? "已结案" : "未定";
  }
  function pendingProjectNodes(p) {
    return normalizeNodes(p && p.nodes).filter(node => !node.doneDate);
  }
  function pendingProjectNodesText(p) {
    const nodes = pendingProjectNodes(p);
    if (!nodes.length) return "-";
    return nodes.map((node, index) => `${index + 1}. ${node.name}${node.targetDate ? `（${node.targetDate}）` : ""}`).join("；");
  }

  // 今天日期 YYYY-MM-DD
  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // 当前日期时间 YYYY-MM-DD HH:mm
  function todayTimeStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}`;
  }

  // 应用版本（每次改动 +0.001）与版本生成时间
  const APP_VERSION = "V1.051";
  const APP_VERSION_TIME = "2026-10-09 17:39:02";
  // 历史版本更改日志（简要总结；新改动可在此追加新条目并 +0.001 版本号）
  const VERSION_LOG = [
    { version: "V1.051", date: APP_VERSION_TIME, items: [
      "详情滚动时项目标题保持可见，日期时钟正常滚动",
      "风险预警与需求变更支持编辑，保留创建时间并记录修改前后内容",
      "未结案项目按预计结案日期自动判断延期，所有页面与导出统一口径",
      "所有看板的项目最新状态区块默认折叠，可手动展开",
      "新增项目简介，详情输入并显示在项目卡片上",
      "状态描述独立保留完整历史，输入栏上方默认折叠，旧版混合历史原文保留",
      "卡片精简：变更次数、负责人、项目经理和周期移至详情查看",
      "状态描述 @检索工程师，不存在的姓名回车新增且角色留空",
      "项目状态简要增加工程师显示列和筛选，仅取最新状态描述中的 @姓名",
      "阶段可回退到任意已完成阶段并撤销后续完成，结案可撤销，原记录保留历史",
      "兼容 V1.049 / V1.050 全数据备份与数据库文件，保留旧角色、记录及扩展字段"
    ] },
    { version: "V1.050", date: "2026-09-04 10:00:00", items: [
      "每个新会话在进入看板前必须由用户打开现有项目数据库、迁移当前浏览器数据或新建空数据库",
      "项目与基础资料修改后自动回写当前数据库文件，首页持续显示文件名和自动保存状态；localStorage 改为会话缓存与故障恢复副本",
      "文件句柄保存在 IndexedDB，打开或新建数据库时文件选择器优先回到上次使用的位置；详情、报表与设置页无法绕过数据库入口"
    ] },
    { version: "V1.049", date: "2026-09-02 09:30:00", items: [
      "项目状态纪要与快速筛选结果中的项目名称可进入详情页，并通过返回上下文回到原纪要/快速筛选范围",
      "快速筛选页的隐藏操作改为当前会话独立生效，支持全部显示，不再意外影响普通项目状态纪要",
      "项目详情的硬件负责人、软件负责人、项目经理和参与人改为基础信息库受控可搜索选择器；历史库外人员保留并标注待入库"
    ] },
    { version: "V1.048", date: "2026-09-01 16:30:00", items: [
      "量产维护标识缩小为 9px，并在项目状态简要中从项目名称下方移至“已结案”状态标签正下方"
    ] },
    { version: "V1.047", date: "2026-09-01 16:00:00", items: [
      "首页统计卡片升级为快速筛选入口，继承当前看板、筛选条件和搜索范围，跳转结果页后可直接导出 Markdown、PDF、CSV 或一键存图",
      "快速筛选结果页支持主动选择 Markdown、CSV 与 PNG 图片的导出文件夹；PDF 仍由浏览器打印对话框选择保存位置",
      "勾选量产维护的已结案项目在首页、详情页和状态简要中统一显示紫色底纹、白色小字的“量产维护”标识"
    ] },
    { version: "V1.046", date: "2026-09-01 15:00:00", items: [
      "项目状态描述按多行原始文本保存，保留用户输入的换行和首尾空行",
      "首页、状态历史、项目状态简要及 PDF 按原换行显示；CSV 使用标准带引号单元格保留换行"
    ] },
    { version: "V1.045", date: "2026-09-01 14:00:00", items: [
      "系统管理菜单按浏览器可视区域自动定位，窄窗口或缩放时保持完整可见，并在空间不足时向上展开或内部滚动",
      "项目状态简要导出 PDF 的打印样式隐藏字段显示控制区，字段选择仍继续控制 PDF、CSV 和 Markdown 的数据列"
    ] },
    { version: "V1.044", date: "2026-09-01 13:10:00", items: [
      "项目详情返回列表时完整保存并恢复筛选条件、搜索词、看板视图、展示模式、筛选栏展开状态、滚动位置和项目焦点",
      "返回恢复改为先还原列表状态并重绘，再恢复滚动与焦点，避免页面重新加载后筛选失效"
    ] },
    { version: "V1.043", date: "2026-09-01 12:48:14", items: [
      "项目详情核心芯片改为基础芯片库受控多选，保留 1.028 库外历史值并提供待入库提示",
      "核心芯片改名同步更新项目引用，使用中的芯片禁止删除，名称按全半角/空白/大小写防重",
      "1.028 备份导入新增芯片预检、映射或批量入库、导入前安全备份、迁移报告与业务数据原子写入",
      "可编辑单文件导出内置导出时芯片库并禁用芯片自由文本输入"
    ] },
    { version: "V1.042", date: "2026-09-01 12:15:06", items: [
      "项目详情的状态描述支持 @ 工程师自动补全，可选择基础资料人员或继续自由输入",
      "新增 statusDescUpdatedAt，状态描述实际变更保存后显示并持久记录最近保存时间"
    ] },
    { version: "V1.041", date: "2026-09-01 12:01:06", items: [
      "项目状态简要将字段显示控制移至列表上方，项目名称固定显示，其余八个字段可独立显示或隐藏",
      "字段隐藏状态持久保存，并同步影响页面列表、PDF、CSV 和 Markdown 导出"
    ] },
    { version: "V1.040", date: "2026-09-01 11:52:24", items: [
      "项目状态简要新增自定义报告名称，PDF 打印版使用该名称作为标题并移除筛选与操作栏",
      "新增按当前勾选项目导出 CSV，文件名采用自定义报告名称并遵循分组列开关"
    ] },
    { version: "V1.039", date: "2026-09-01 11:02:29", items: [
      "项目状态 Markdown 改为会议纪要式输出，按客户、主要负责人和项目简明条目组织，并保留原始字段追溯",
      "网页生成协议新增文件夹选择、日期戳知识库目录、图片/HTML/PDF 保存和项目级复制按钮的可操作要求"
    ] },
    { version: "V1.038", date: "2026-09-01 10:25:42", items: [
      "项目状态简要 Markdown 新增网页状态色语义：延期、量产维护和各原始项目状态均有明确展示色与优先级",
      "Markdown 新增网页交付要求，要求 AI 生成的网页提供一键保存图片、保存 HTML、导出或保存 PDF 按钮"
    ] },
    { version: "V1.037", date: "2026-09-01 10:03:55", items: [
      "项目详情返回列表时恢复来源页面、滚动位置及刚打开项目的键盘与视觉焦点",
      "主看板、项目状态简要和芯片统计入口统一保存返回上下文，并优先使用浏览器历史保留筛选、搜索和排序状态"
    ] },
    { version: "V1.036", date: "2026-09-01 00:52:23", items: [
      "项目状态简要将 CSV 导出升级为 AI 协作 Markdown 导出，按当前勾选项目生成",
      "Markdown 按客户、主要负责人（项目经理→软件负责人→硬件负责人）分层，并保留原始项目字段",
      "内置 AI 使用规则：先询问汇报用途、忽略字段和补充信息；原始数据为唯一事实来源，最终仅允许简短归纳"
    ] },
    { version: "V1.035", date: "2026-08-31 14:05:00", items: [
      "为已结案项目新增 isProductionMaintenance 量产维护标识，研发状态保持已结案",
      "主看板新增互斥的量产维护视图，详情、导出、状态简要、芯片统计、完整备份和知识库同步展示该标识",
      "新增量产维护浏览器回归：标记、历史、独立看板、普通结案去重及单文件导出均受验证"
    ] },
    { version: "V1.034", date: "2026-08-31 11:18:40", items: [
      "修复新建模式无法保存项目节点、客户节点及阶段天数草稿，并保留首次创建前产生的操作历史",
      "把单文件导出版抽为 src 源模板，由构建脚本生成回 GeekDash.html，保持八文件运行交付",
      "单文件导出数据改用安全 JSON 转义，防止项目内容提前终止 script 标签",
      "新增 localhost 浏览器回归脚本，覆盖首页、三视图返回、新建草稿、备份、导出版及两个报表页"
    ] },
    { version: "V1.033", date: "2026-08-31 10:54:32", items: [
      "把延期、最新状态、当前阶段和未完成节点等派生逻辑集中到 projects-data.js",
      "状态简要页、芯片统计页和主看板改用共享口径，降低重复实现和页面间结果漂移风险",
      "新增 Skill 与模板双重自动校验及安全创建脚本"
    ] },
    { version: "V1.032", date: "2026-08-31 10:39:32", items: [
      "完整业务备份新增企业信息、反馈、报表备注与可迁移偏好，并引入备份 schema 版本",
      "导入前校验项目与基础库结构、唯一正整数 ID 和枚举字段，避免异常备份污染本地数据",
      "手动备份文件名加入时分秒，避免同一天多次备份静默覆盖",
      "知识库同步清理受管模块的旧文件并加强 Markdown 数据边界"
    ] },
    { version: "V1.031", date: "2026-08-31 10:39:32", items: [
      "修复新建项目未写入 createdAt，导致近 1 月新增统计不准确",
      "修复新建前录入的阶段、项目节点和客户节点在首次保存时丢失",
      "修复项目保存时分组字段被重复误记为变更",
      "修复从提案中/暂缓看板进入详情后返回到进行中看板的问题",
      "清理默认示例数据中的重复更新历史"
    ] },
    { version: "V1.030", date: "2026-08-25 14:58:38", items: [
      "项目 Flow 升级为画布式泳道流程图：节点可拖拽定位、拖拽节点左右圆点建立连线（支持跨阶段连线），点连线删除、删除节点自动清理相关连线",
      "节点新增 prevId/nextId 连线字段（normalizeNodes 兼容存量数据）；节点编辑弹窗新增「前置节点/后置节点」下拉，两种方式都能改连接",
      "泳道标签点击弹出阶段编辑弹窗，内嵌「里程碑完成/中途结案」操作（当前阶段显示）；泳道右侧「＋ 节点」按钮 / 双击泳道空白新增节点",
      "新增「预览图」按钮：把泳道+节点+连线渲染成 SVG 转 PNG，页面内弹窗预览并可下载 PNG（项目阶段节点图）"
    ] },
    { version: "V1.029", date: "2026-08-25 13:23:13", items: [
      "项目详情页「Flow」tab 升级为「项目 Flow」：把「项目阶段」与「项目节点」整合到一张纵向泳道视图（泳道=七大阶段，节点按所属阶段挂靠到对应泳道）",
      "节点归属由存「阶段名」改为存「stageId」（1-7），代码自动兼容存量数据（阶段名自动反查 id），节点数据零删除",
      "泳道升级：显示里程碑目标/三线要点/预期天数/完成状态，并内嵌「里程碑完成/中途结案」操作与「编辑阶段」弹窗（可改日期/天数/备注）",
      "节点就地新增/编辑/删除/标记完成（复用「项目节点」数据，消除原 Flow 独立里程碑数据冗余）；当前进行阶段默认展开、其余折叠",
      "节点与阶段统一即时保存；原「项目阶段」「项目节点」两个 tab 保持不变作为列表式兜底；Flow 导出改为阶段+节点清单"
    ] },
    { version: "V1.028", date: "2026-08-24 18:21:07", items: [
      "修复：新建项目时「是否延期」手动标记（isDelayed）未带入新项目，导致延期标记丢失；现在新建项目会正确带入手动延期标记（含延期记录自动视为延期）",
      "统一延期状态口径：旧项目（无手动标记）一律默认「未延期」，详情/首页/状态简要/芯片统计四页一致（不再按日期自动判断）"
    ] },
    { version: "V1.027", date: "2026-08-24 17:47:16", items: [
      "项目详情「延期项目控制」：是否延期改为下拉框（用户可主动选择已延期，不再自动判断），新增延期记录支持编辑与删除",
      "看板首页 / 项目状态简要 / 芯片统计的延期标识同步改为读取手动延期标记（旧数据回退按日期自动判断）"
    ] },
    { version: "V1.026", date: "2026-08-24 16:41:54", items: [
      "系统设置「关于」新增 Bug/建议板块：可新增（类型/提出人/提出日期/具体信息）、勾选多条后导出为 PDF 或 MD，并可删除选中"
    ] },
    { version: "V1.025", date: "2026-08-24 16:24:46", items: [
      "知识库新增「自动同步」：同步时间可下拉选择每 5/10/30/60 分钟，默认手动同步（定时器仅系统设置页打开期间生效）"
    ] },
    { version: "V1.024", date: "2026-08-24 16:16:39", items: [
      "知识库改为在「数据备份」的备份文件夹下生成 GeekDashKB（不再单独选择文件夹），并附带「使用说明.md」引导文件",
      "知识库新增「同步方向」下拉（单向同步 / 双向同步），双向同步暂不支持"
    ] },
    { version: "V1.023", date: "2026-08-24 15:57:35", items: [
      "系统设置新增「知识库」模块：选择存储文件夹后同步生成 GeekDashKB 文件夹，按模块分类生成 Markdown 知识库（各子文件夹含 index 索引），供对接 AI 平台查询"
    ] },
    { version: "V1.022", date: "2026-08-24 15:32:50", items: [
      "首页顶部新增「卡片模式 / 驾驶舱模式」快捷切换按钮，与系统设置同步"
    ] },
    { version: "V1.021", date: "2026-08-24 15:14:30", items: [
      "管理模式记住上次选择的工程师：再次进入直接复用；未选择过才弹窗，已在管理模式再次点击可重新选择",
      "系统设置「关于」历史版本日志默认折叠，点击展开"
    ] },
    { version: "V1.020", date: "2026-08-24 14:51:52", items: [
      "新建项目「项目风险与变更」tab 同步显示风险预警、需求变更模块，并可新增（创建项目时带入）",
      "删除「项目把控」字段与逻辑，改为「延期项目控制」模块：显示是否延期，已延期可新增延期1/2/3…（延期原因 + 新的目标完成日期 + 应对措施）",
      "延期项目在项目卡片与看板首页「项目最新状态」区体现延期标识",
      "延期数据（delays）随项目对象纳入数据备份 / 数据导入"
    ] },
    { version: "V1.019", date: "2026-08-24 14:26:59", items: [
      "「数据恢复」更名为「数据导入」",
      "数据导入支持「覆盖 / 叠加」两种方式；叠加遇数据冲突逐条提示（维持旧数据 / 插入新数据 / 叠加新数据 / 忽略，忽略后后续冲突均维持旧数据）",
      "看板筛选模块可折叠 / 展开（默认折叠），系统设置新增「筛选模块默认折叠 / 展开」选项"
    ] },
    { version: "V1.018", date: "2026-08-24 14:11:57", items: [
      "系统设置筛选字段与首页看板筛选字段同步（补充「分组」维度）",
      "企业信息新增「看板系统名称前缀」（默认智能硬件，标题=前缀+「项目看板系统」）"
    ] },
    { version: "V1.017", date: "2026-08-24 13:53:54", items: [
      "项目详情：信号灯 / 风险预警 / 需求变更三部分从「基本信息」tab 归入新「项目风险与变更」tab（位于客户节点之后）",
      "项目详情「基本信息」tab 项目名称下新增「项目详情备注」（选填，可填写规格等信息）"
    ] },
    { version: "V1.016", date: "2026-08-24 13:37:08", items: [
      "「数据管理」更名为「基础信息管理」；看板顶部「系统管理」移至「芯片项目统计」之后",
      "约定：用户主动数据备份与自动备份分开存放、命名规则不同，主动备份由用户自定义文件夹完成"
    ] },
    { version: "V1.015", date: "2026-08-24 13:15:18", items: [
      "项目状态简要 / 芯片项目统计两页新增「按项目状态筛选」（提案中/暂缓/进行中/已结案，默认全选，可单选/多选）",
      "数据备份升级：备份前选择「全部备份」或按客户/项目/分组/项目经理「选择性备份」（多选叠加），并提示选择指定文件夹"
    ] },
    { version: "V1.014", date: "2026-08-24 12:56:38", items: [
      "芯片项目统计页：最新状态/当前阶段/预计结案日期/是否延期四列支持隐藏/显示（默认隐藏）；芯片筛选勾选后需点「确定」才执行筛选"
    ] },
    { version: "V1.013", date: "2026-08-24 12:45:12", items: [
      "新增「芯片项目统计」页面与看板入口按钮：核心芯片作为第一列，支持按核心芯片下拉筛选（单选/多选/全选）生成不同列表"
    ] },
    { version: "V1.012", date: "2026-08-24 12:31:35", items: [
      "数据管理新增「核心芯片」台账：每个芯片型号可记录芯片原始型号、原厂信息、固件版本名称（三项均为选填）"
    ] },
    { version: "V1.011", date: "2026-08-24 12:00:31", items: [
      "新增自动备份：数据每次更新自动生成一份 .bak（文件名含日期、时刻与随机数），写入系统设置指定的备份文件夹",
      "每天最多保留 N 份自动备份（默认 3，可在系统设置选择 3-10），超出自动覆盖最早的一份"
    ] },
    { version: "V1.010", date: "2026-08-24 11:13:49", items: [
      "项目状态简要页新增「分组」列 + 分组多选筛选（单选/多选/全选）+ 排序加「按分组」+ 导出可控制是否含分组列",
      "数据安全：系统设置新增「备份文件夹地址」选择，数据备份除浏览器下载 .bak 外同步在该文件夹保存一份同样内容"
    ] },
    { version: "V1.009", date: "2026-08-24 10:52:07", items: [
      "新增「项目分组」：数据管理企业信息后新增分组管理（默认一组/二组/三组，可增删改），看板筛选新增分组维度，详情页基本信息新增分组下拉字段",
      "项目状态简要关键节点列无未完成节点时显示「-」"
    ] },
    { version: "V1.008", date: "2026-08-24 10:38:16", items: [
      "项目状态简要页：新增「关键节点」列（抽取项目节点 tab 中未完成节点 + 预计完成日期，多个用 1/2/3 罗列），顶部可隐藏/显示该列"
    ] },
    { version: "V1.007", date: "2026-08-24 10:20:55", items: [
      "项目状态简要页：新增排序下拉（按客户/按阶段/按预计结案日期，默认客户），调整列顺序为「客户、项目、最新状态、备注、阶段、结案日期、延期」，备注列可隐藏/显示"
    ] },
    { version: "V1.006", date: "2026-08-24 10:10:16", items: [
      "项目状态简要页：每行支持隐藏/显示（顶部一键全部显示）；新增可编辑「备注」列；每行可单独勾选 + 表头全选，按勾选导出 CSV / PDF"
    ] },
    { version: "V1.005", date: "2026-08-24 09:54:00", items: [
      "项目状态简要页新增「当前阶段」列（点击跳转项目详情阶段 tab），详情页支持 ?tab= 直达对应标签",
      "项目状态简要「最新状态」改为提取基本信息「项目状态描述」字段"
    ] },
    { version: "V1.004", date: "2026-08-24 09:32:14", items: [
      "新增「项目状态简要」按钮与专门网页：提取所有项目最新状态生成列表（客户 / 项目名称 / 预计结案日期 / 最新状态 / 是否延期）",
      "同客户项目相邻（默认按客户分组、组内按结案日期）；支持拖拽行排序自由调配顺序并持久化，可一键重置；顶部显示列表生成日期"
    ] },
    { version: "V1.003", date: "2026-08-22 01:07:16", items: [
      "修复：进入管理模式的选择工程师对话框缺少遮罩定位样式（.modal-overlay）导致不显示，补全后弹窗正常居中显示"
    ] },
    { version: "V1.002", date: "2026-08-22 00:45:17", items: [
      "新增浏览/管理模式：浏览模式默认只读（隐藏新建/数据写入/卡片更新状态）；管理模式需从工程师名单选择一人确认进入",
      "进入管理模式弹窗支持「新增工程师 + 角色」（与数据管理同逻辑）",
      "仅管理模式显示会议悬浮窗，且副标题显示「项目管理人」",
      "详情页浏览模式下表单只读、隐藏保存/删除，打开不记录 check"
    ] },
    { version: "V1.001", date: "2026-08-22 00:02:16", items: [
      "初始版本发布：研发阶段重构为七大阶段体系（需求立项→项目预启动→PEVT技术预研→EVT集成验证→DVT可靠性验证→PVT量产验证→MP量产维护）",
      "三看板视图（提案中/暂缓、进行中、已结案）+ 暂缓项目并入提案中/暂缓看板",
      "项目 CHECK 模式开关 + 可自定义 check 截止规则（默认周五 18:00）；统计区「未check项目」总数",
      "基本信息新增启动日期（设置后预计结案日期必填）+ 项目总工期校验（超出窗口提示「计算工期出错」）",
      "驾驶舱风格升级（KPI 大数字卡片、环形进度条、风险左色条）+ 新增「科技」主题",
      "首页三专区（最新状态/风险预警/需求变更）按当前看板过滤"
    ] }
  ];
  window.APP_VERSION = APP_VERSION;
  window.APP_VERSION_TIME = APP_VERSION_TIME;
  window.VERSION_LOG = VERSION_LOG;

  window.PROJECT_DB = {
    STORAGE_KEY, STORAGE_KEY_CUSTOMERS, STORAGE_KEY_ENGINEERS, STORAGE_KEY_PRODUCT_LINES, STORAGE_KEY_APPS, STORAGE_KEY_TAGS, STORAGE_KEY_GROUPS, STORAGE_KEY_CHIPS, STORAGE_KEY_COMPANY, DATABASE_SESSION_KEY,
    BACKUP_SCHEMA_VERSION, BACKUP_PREFERENCE_KEYS,
    APP_VERSION, APP_VERSION_TIME, VERSION_LOG,
    STATUS_LIST, PRIORITY_LIST, SIGNAL_LIST, RISK_LEVEL_LIST, RISK_LEVEL_STYLE,
    STATUS_STYLE, PRIORITY_STYLE, SIGNAL_STYLE,
    FIELD_OPTIONS,
    CUSTOMER_TAG_SUGGESTIONS,
    STAGES,
    DEFAULT_PROJECTS, DEFAULT_CUSTOMERS, DEFAULT_ENGINEERS, DEFAULT_PRODUCT_LINES, DEFAULT_APPS, DEFAULT_TAGS, DEFAULT_GROUPS, DEFAULT_CHIPS, DEFAULT_COMPANY,
    ENGINEER_ROLE_SUGGESTIONS,
    normalizeChips, chipNameKey, normalizeHistory, normalizeStatusDescriptionHistory, statusDescriptionHistory, updateStatusDescription, statusEngineers, addStatusEngineer, normalizeStages, normalizeRisks, normalizeChanges, normalizeDelays, normalizeNodes, normalizeCustomerNodes, normalizeMilestones,
    currentStage, projectProgress, latestTargetDate, isProjectDelayed, isProductionMaintenance, hasDelay, latestProjectStatus, projectStageName, projectDelayState, projectDelayText, pendingProjectNodes, pendingProjectNodesText,
    todayStr, todayTimeStr, nextId,
    load, save, reset, resetAll,
    loadCustomers, saveCustomers, loadEngineers, saveEngineers, loadProductLines, saveProductLines, loadApps, saveApps, loadTags, saveTags, loadGroups, saveGroups, loadChips, saveChips, loadCompany, saveCompany, saveBusinessDataAtomic,
    loadAutoBackupConfig, saveAutoBackupConfig, runAutoBackup, buildBackupData, validateBackupData, restoreBackupPreferences,
    databaseSession, hasActiveDatabaseSession, openProjectDatabaseHandle, openProjectDatabasePicker, createProjectDatabasePicker, saveActiveProjectDatabase
  };
  // 防止通过书签直接绕过数据库入口访问详情、报表或设置页面。
  const runtimePage = typeof location === "undefined" ? "" : String(location.pathname || "").split("/").pop();
  if (runtimePage && runtimePage !== "GeekDash.html" && ["project-detail.html", "project-status-summary.html", "chip-statistics.html", "data-manage.html", "settings.html"].includes(runtimePage) && !hasActiveDatabaseSession()) {
    setTimeout(() => location.replace("GeekDash.html?databaseRequired=1"), 0);
  }
})();

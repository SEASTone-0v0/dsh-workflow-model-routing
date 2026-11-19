/*
 * @local/dsh-workflow-model-routing — client half (v2.2.0, role-first + reasoningEffort).
 *
 * The page is a Settings section. v1 was model-first: a flat whitelist with
 * role labels attached to models. This version inverts the subject: the user
 * reads and edits ROLES (what the agent does), and each role owns a primary,
 * a backup and an upgrade route. The allowed-model whitelist is derived by the
 * host from those routes plus any extra models, so the page never asks the user
 * to maintain two lists that can drift apart.
 *
 * Save is two-phase: validate every referenced route through a real request,
 * then write. A failed route blocks the save and leaves the old configuration
 * untouched.
 *
 * Loaded as a classic script by the web shell:
 *   window.__ModuleLoader__.load({ id, factory(require) { ... } })
 */

window.__ModuleLoader__.load({
  id: "@local/dsh-workflow-model-routing",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;
    var useCallback = React.useCallback;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useState = React.useState;
    var useRef = React.useRef;

    var PACKAGE_ID = "@local/dsh-workflow-model-routing";
    var SETTINGS_SLOT = "settings.section";
    var SETTINGS_ICON_SLOT = "settings.section.icon";
    var SECTION_ID = "subagent-roles-and-models";
    var SECTION_ORDER = 46;

    var ROUTE_BASE = "/plugins/dsh-workflow-model-routing";
    var ROLES_PATH = ROUTE_BASE + "/roles";
    var VALIDATE_PATH = ROUTE_BASE + "/roles/validate";
    var SAVE_PATH = ROUTE_BASE + "/roles/save";
    var CATALOG_PATH = ROUTE_BASE + "/catalog";
    var SUBAGENTS_PATH = ROUTE_BASE + "/subagents";
    var MODES_PATH = ROUTE_BASE + "/modes";
    var MODE_SAVE_PATH = ROUTE_BASE + "/modes/save";
    var MODE_ENABLE_PATH = ROUTE_BASE + "/modes/enable";
    var CAPABILITIES_PATH = ROUTE_BASE + "/capabilities";
    var CAPABILITIES_REFRESH_PATH = ROUTE_BASE + "/capabilities/refresh";
    var EXECUTION_INTEGRATION_PATH = ROUTE_BASE + "/execution-integration";
    var TIERS_PATH = ROUTE_BASE + "/tiers";
    var TIERS_REFRESH_PATH = ROUTE_BASE + "/tiers/refresh";
    var AI_CONFIGURE_PATH = ROUTE_BASE + "/ai/configure";
    var AI_RECOMMEND_PATH = ROUTE_BASE + "/ai/recommend";
    var AI_JOBS_PATH = ROUTE_BASE + "/ai/jobs";
    var RELEASE_NOTES_PATH = ROUTE_BASE + "/release-notes";

    var STYLE_ID = PACKAGE_ID + "-styles";

    var TIERS = ["primary", "backup", "upgrade"];
    var MODE_IDS = ["economy", "normal", "performance", "broke"];
    var REASONING_POLICIES = ["default", "fixed", "smart"];
    var DIFFICULTIES = ["low", "medium", "high"];
    var TEAM_KINDS = ["planner", "executor", "reviewer", "advisor"];

    /* Four model tiers shown in the authorized-models tab. The backend exposes
     * no /tiers route, so the client carries a provider-based fallback for the
     * tier badges; a real benchmark DB is never surfaced. */
    var TIER_ORDER = ["broke", "economy", "normal", "performance"];
    var TIER_EMOJI = { broke: "🔴", economy: "🟡", normal: "🟢", performance: "🔵" };
    var TIER_FALLBACK = [
      { tier: "broke", providers: ["deepseek-account", "deepseek-account-vision"] },
      { tier: "performance", providers: ["openai", "anthropic"] },
      { tier: "economy", providers: ["google"] },
      { tier: "normal", providers: ["moonshotai"] },
    ];
    var VERSIONS = [
      {
        version: "v2.3.0",
        date: "2026-11-15",
        zh: "四模式（新增穷鬼模式）、三标签页、授权模型测试/分层、版本控制与历代更新说明。",
        en: "Four modes (added Broke), three tabs, authorized-model test/tiering, and a version changelog.",
      },
      {
        version: "v2.2.0",
        date: "2026-11-14",
        zh: "能力未知/失效/过期只读处理、执行接线说明、任务板禁用提示。",
        en: "Read-only handling for unknown/stale/expired capability, execution-wiring copy, task-board gating.",
      },
      {
        version: "v2.1.0",
        date: "2026-11-14",
        zh: "扁平推理配置与能力缓存、保存/启用分离、expectedRevision 并发保护。",
        en: "Flat reasoning config + capability cache, save/enable split, expectedRevision CAS.",
      },
      {
        version: "v1.0.0",
        date: "2026-11-13",
        zh: "首个三模式运行模式界面与角色路由。",
        en: "First three-mode run-mode UI and role routing.",
      },
    ];

    /* Preset snapshots now come from the backend (/modes → recommendedPresets),
     * not a hardcoded client copy. See restorePreset(). */

    /* ---------------------------------------------------------------- *
     * Copy
     * ---------------------------------------------------------------- */

    var COPY = {
      zh: {
        nav: "运行模式与团队路由",
        title: "运行模式与团队路由",
        subtitle: "选择经济 / 普通 / 性能运行模式，配置 Lead、升级顾问、团队与子代理角色的模型路由与推理档位；授权与角色分配互不影响，能力未知时不猜测档位。",
        enabled: "启用角色路由",
        enabledHint: "关闭后保存会移除全部子代理模型授权；已打开的会话不受影响。",
        primary: "主用",
        backup: "备用",
        upgrade: "升级",
        primaryHint: "日常执行这条路线。",
        backupHint: "主用不可用时的人工备选，不会自动替换。",
        upgradeHint: "任务超出主用能力时显式改走这条路线。",
        unset: "未配置",
        configure: "配置",
        collapse: "收起",
        addRole: "添加角色",
        restoreRoles: "恢复默认角色",
        restoreAuthorized: "恢复默认授权",
        authorizedTitle: "已授权模型",
        authorizedHint: "这里是你明确授权给子代理的模型。角色只能从这些模型里选择路线；授权与角色分配互不影响。",
        authorizedEmpty: "还没有已授权的模型。请先在这里添加。",
        emptyAuthorized: "启用角色路由时，至少需要授权一个模型。",
        addAuthorized: "授权模型",
        revoke: "取消授权",
        referencedBy: "被引用",
        notReferenced: "暂无角色使用",
        revokeBlocked: "该模型正被 {n} 个角色引用（{list}），请先解除这些引用再取消授权。",
        rolePickerEmpty: "暂无已授权模型，请先在上方「已授权模型」中添加。",
        roleSectionTitle: "角色分配",
        unauthorizedOption: "未授权",
        conflictTitle: "配置异常",
        conflictLine: "角色 {name} 的{tier}路线 {route} 未获授权，该角色无法派发。",
        changesTitle: "本次保存将：",
        changeAddAuth: "新增授权 {n} 个：{list}",
        changeRevokeAuth: "撤销授权 {n} 个：{list}",
        changeRoles: "角色配置有改动",
        changeEnabled: "启用状态改变",
        migratedNote: "已从旧版角色配置迁移授权（保存后写入新格式）。",
        tierPrimary: "主用",
        tierBackup: "备用",
        tierUpgrade: "升级",
        recentDispatches: "最近派发记录",
        recentHint: "当前运行期间的观察记录，非完整历史。",
        recentEmpty: "还没有记录。",
        advanced: "高级设置与写入信息",
        reload: "重新载入",
        validateAndSave: "验证并保存",
        saving: "保存中…",
        validating: "正在验证 {n} 个模型…",
        validateConfirm:
          "将验证 {n} 个已授权模型，每条路线发一次最小请求，可能产生调用费用。验证不通过时不会保存，也不会改动现有配置。是否继续？",
        saved: "已保存。新开的顶层会话才携带新授权。",
        unchanged: "没有未保存的修改。",
        dirty: "有未保存的修改。",
        conflict: "配置已被其他窗口或文件修改，请重新载入后再保存。",
        roleName: "角色名称",
        rolePurpose: "职责说明",
        roleEnabled: "启用该角色",
        roleDisabled: "已停用",
        switchRule: "切换规则：经确认后切换（本版本不会自动替换）",
        removeRole: "删除角色",
        deleteRoleConfirm: "确定删除角色「{name}」？只影响草稿，保存后才生效。",
        restoreRolesConfirm: "将把角色草稿恢复为内置的 14 个角色（不改变授权模型）。只影响草稿，验证并保存后才生效。是否继续？",
        restoreAuthorizedConfirm: "将把授权草稿恢复为内置默认授权（{count} 条，不改变角色分配）。只影响草稿，保存后才生效。是否继续？",
        noRoleRoutes: "该角色由规则决定路线，不能手配固定模型。",
        privacyRule: "不自动派发，不使用云端回退。",
        authorPrefix: "作者",
        reviewPrefix: "审查",
        unlistedTitle: "规划模型未获允许",
        unlistedEmpty: "全部被引用的路线都会写入授权。",
        roleIdLabel: "角色标识",
        roleIdHint: "小写字母、数字、点、下划线或连字符；改名不会改变历史记录。",
        manualRoute: "手动填写 provider / model",
        newRoleName: "新角色",
        validationTitle: "验证结果",
        validationOk: "全部通过",
        validationFailed: "有 {n} 个模型未通过，未保存。",
        validationNote: "验证只说明此刻这条路线能完成一次最小请求，不代表模型身份、质量或未来可用性。",
        transient: "本次未通过",
        permanent: "未通过",
        rolesFailed: "读取角色配置失败，页面暂不能编辑。",
        catalogFailed: "读取模型目录失败，模型下拉可能不完整。",
        storePath: "角色配置文件",
        policyRevision: "官方授权 revision",
        derivedTitle: "当前应写入的授权",
        driftTitle: "授权与角色配置不一致，保存后会对齐。",
        consistencyTitle: "上次保存未完成回滚，派发已被阻止；请重新载入并再次保存。",
        notPersistent: "找不到可写入的 profile 目录，角色配置无法持久保存。",
        refresh: "刷新",
        loading: "加载中…",
        unknownRole: "未指定角色",
        statusRunning: "运行中",
        statusCompleted: "已完成",
        statusAborted: "已中止",
        statusError: "失败",
        statusBlocked: "被阻止",
        statusInterrupted: "已中断",
        statusMaxTokens: "达到长度上限",
        requested: "指定",
        actual: "调用",
        actualNote: "“调用”取自运行期的 llm/stream 参数，不等同于成功响应。",
        role: "角色",
        task: "任务",
        status: "状态",
        runModeTitle: "运行模式",
        runModeSubtitle: "经济 / 普通 / 性能 / 穷鬼四套配置各自独立保存。保存设置与启用是两步：保存只写入该模式的草稿（未启用），启用才把它标记为当前模式并应用 Lead 默认；实际生效范围以下方「执行接线」为准，仅限本插件（Lead 默认 + 原生子代理派工），不劫持全局模型路由。",
        modeCurrent: "当前启用",
        modeDirty: "有未保存修改",
        modeSaved: "已保存草稿（未启用）。启用才会写入当前模式。",
        rolesSaveFailed: "授权/角色存储同步失败（模式草稿已保存）。",
        rolesSaveConflict: "角色配置已被其他窗口修改（revision 不匹配），已重新载入，请再次保存。",
        globalLoadFailed: "角色存储读取失败，无法安全保存。请刷新页面重试。",
        modeEnabled: "已启用「{label}」。",
        modeEnabledUnknown: "执行接线状态未知（后端未返回集成信息），请刷新确认。",
        wiringLeadDefault: "Lead 默认",
        wiringNative: "原生子代理派工",
        wiringSession: "会话快照",
        wiringTaskBoard: "跨会话任务板",
        wiringOn: "：已接线",
        wiringOff: "：未接线",
        wiringScopeNote: "生效范围仅限本插件（Lead 默认 + role_subagent 派工），不劫持全局模型路由。",
        modeEnableDirty: "当前草稿有未保存修改，请先保存草稿再启用。",
        modeEnableFailed: "启用失败（未写入任何变更）：",
        modeSaveConflict: "保存冲突：该模式已被其他会话修改（revision 不匹配），已重新读取最新配置，请复核后再保存。",
        modeEnableConflict: "启用冲突：该模式已被其他会话修改（revision 不匹配），已重新读取最新配置，请复核后再启用。",
        saveDraft: "保存草稿",
        enableMode: "启用该模式",
        restorePreset: "恢复预设",
        restorePresetConfirm: "将把「{label}」的 Lead、升级顾问、角色、团队与任务目标恢复为内置推荐预设（保留自定义角色与 revision），并把引用路线并入授权草稿（只增不删）。只改草稿，保存后才生效。是否继续？",
        restorePresetMissing: "后端未返回推荐预设（版本过旧），无法恢复。请刷新或升级插件。",
        restoreAuthorizedDone: "已把授权草稿恢复为默认授权（{count} 条），保存后才生效。",
        copyMode: "复制模式",
        copyFromLabel: "复制自…",
        copyFromConfirm: "将把「{source}」的完整配置（Lead、升级顾问、角色、团队、任务目标）复制进「{target}」草稿，覆盖当前草稿，保存后才生效。是否继续？",
        modeCopied: "已复制到草稿（未保存）。",
        modeRestored: "已恢复预设到草稿（未保存）。",
        modeClear: "清除",
        unsavedSwitch: "「{label}」有未保存修改，切换会丢弃这些修改。是否继续？",
        leadTitle: "Lead 默认路线",
        leadLabel: "Lead 主模型",
        advisorLabel: "升级顾问",
        advisorEnabled: "启用升级顾问",
        advisorCondition: "升级条件",
        teamTitle: "子代理派工策略",
        teamPlanner: "规划者",
        teamExecutor: "执行者",
        teamReviewer: "复核者",
        teamAdvisor: "顾问",
        teamConcurrency: "并发上限",
        teamConcurrencyHint: "仅 role_subagent 派工范围；留空表示不设上限",
        teamRetry: "失败重试上限",
        teamRetryHint: "留空表示不设上限",
        teamEscalation: "升级门槛",
        teamWriteIsolation: "写入范围隔离",
        teamBudget: "预算上限",
        teamBudgetHint: "留空表示不设上限",
        targetsTitle: "任务执行目标",
        targetNative: "原生同树子代理",
        targetBoard: "任务板独立会话",
        targetBoardUnsupported: "任务板执行未接通（后端未提供可运行独立会话的任务板服务），此选项已禁用。",
        targetBoardNote: "任务板：rc.3 的 agentTeams.createTask 只是共享待办账本，不创建独立会话、不含模型路由，故不提供独立会话开关。",
        rolesTitle: "该模式下的子代理角色",
        rolesHint: "角色的主 / 备 / 升级路线同样使用扁平推理配置；审查与隐私角色沿用既有特殊规则，不提供常规路线编辑。",
        dispatchTitle: "派工控制",
        nativeScopeNote: "此开关仅决定 role_subagent 派工是否可用原生子代理，不会禁用其他原生工具。",
        teamOverrideTitle: "协作身份覆盖",
        teamOverrideHint: "仅对显式声明的 teamRole 生效；协作身份覆盖路线优先于各专业角色已配置的路线；显式 override 的优先级更高；直接调用原生 subagent 不会自动套用这些路线。",
        advisorGroupTitle: "协作建议",
        advisorGroupHint: "升级条件仅作为提示，不触发自动调度；是否升级由主模型显式决定。",
        reasoningPolicyLabel: "推理政策",
        reasoningPolicy_default: "模型默认",
        reasoningPolicy_fixed: "固定档位",
        reasoningPolicy_smart: "按难度智能映射",
        reasoningEffortLabel: "固定档位",
        reasoningSmart_low: "低难度 →",
        reasoningSmart_medium: "中难度 →",
        reasoningSmart_high: "高难度 →",
        reasoningPreviewDefault: "发送：适配器默认（不带 reasoningEffort）",
        reasoningPreviewFixed: "发送：固定档位 {effort}",
        reasoningPreviewSmart: "发送：按任务难度映射到该模型允许的原始档位",
        reasoningPreviewInvalid: "该档位不在模型允许范围内 → 回退适配器默认",
        reasoningFallback: "能力未知 / 已过期：回退适配器默认，不猜测档位。",
        reasoningStale: "已存档位当前不可用（能力未知 / 过期 / 已收窄）。请先刷新能力，或显式切回「模型默认」；不会静默覆盖已存值。",
        reasoningNoEfforts: "该模型未声明可用推理档位，仅支持「模型默认」。",
        reasoningResidual: " · 无效档位",
        capTitle: "能力缓存（本地）",
        capHint: "主键为 provider+model；来源为目录声明（configSource=declared，不宣称已验证真实端点变更）；刷新只读本地适配器元数据（listProviders / listModels / resolveModelInfo），不发起付费模型请求。",
        capEmpty: "尚未检测能力；点击「刷新能力」读取本地适配器元数据。",
        capRefresh: "刷新能力（本地元数据，不付费）",
        capRefreshing: "正在本地检测…",
        capRefreshed: "已刷新能力缓存（本地元数据，未发起付费请求）。",
        capSourceCatalog: "目录声明",
        capSourceUnknown: "未知来源",
        capStatusOk: "可用",
        capStatusFailed: "失败",
        capStatusUnknown: "未知",
        capStatusExpired: "已过期",
        capStatusInvalidated: "已失效",
        capStatusStale: "已过期（代次不匹配）",
        capDetectedAt: "检测时间",
        capEfforts: "档位",
        capEffortsDefault: "默认（模型自选）",
        capEffortsOff: "关（无档位）",
        capCacheStatus: "能力缓存",
        capFailed: "读取能力缓存失败：",
        capNotPersistent: "找不到可写入的配置目录，模式无法持久保存。",
        modesFailed: "读取运行模式失败。",
        modeCurrentShort: "当前",
        modeDirtyShort: "未保存",
        modeDescTitle: "模式解读",
        tabTeam: "主会话与派工控制",
        tabRoles: "子代理配置",
        tabAuthorized: "授权模型",
        tabHub: "模型与角色中心",
        tabModels: "模型配置",
        saveSettings: "保存设置",
        testConnection: "测试连接",
        testConnectionHint: "对每个已授权模型发起一次最小真实请求以验证连通性（可能产生少量费用）；通过亮绿点、未通过亮红点。",
        testPass: "通过",
        testFail: "未通过",
        notTested: "未测试",
        testedNote: "已测试连接（对每个已授权模型发起一次最小真实请求）。",
        tierTitle: "模型分层",
        tierHint: "四档分层与对应已授权模型；后台复杂基准分数据库不展示。",
        refreshTiers: "刷新模型分层",
        tierBroke: "穷鬼档",
        tierEconomy: "经济档",
        tierNormal: "普通档",
        tierPerformance: "性能档",
        tiersFallbackNote: "后端未返回模型分层数据，已使用前端兜底分层（按 provider 归类）。",
        authorizedTabHint: "只展示已授权模型的能力档位；不展示全量模型目录。",
        changelogTitle: "版本控制与历代更新说明",
        versionCurrent: "当前版本",
        recentNone: "暂无派发记录（本插件不持久化派发日志）。",
        authorizedEmptyTab: "暂无已授权模型。",
        aiTitle: "AI 智能助手",
        aiConfigureTitle: "一键配置",
        aiConfigureDesc: "用所选授权模型，为四个模式生成主用/备用/升级路线与推理配置（会调用真实模型，约 4 次）。",
        aiConfigureButton: "生成配置",
        aiRecommendTitle: "一键推荐",
        aiRecommendDesc: "按角色/模式推荐市场模型候选（会调用真实模型；市场推荐需自行核对供应商可用性与价格）。",
        aiRecommendButton: "获取推荐",
        aiPickModel: "执行模型",
        aiBusy: "AI 处理中…",
        aiPaidHint: "将产生真实模型请求，约 4 次，可能产生费用。",
        aiConfigureDone: "配置完成：成功模式已合并进草稿（未保存）。",
        aiRecommendDone: "推荐完成。",
        aiRecommendPartial: "部分模式推荐失败：",
        aiNewAuth: "新增授权草稿",
        aiSaveAll: "保存全部草稿",
        aiSaveAllDone: "全部草稿已保存。",
        aiSaveAllPartial: "部分草稿保存失败",
        aiResultTitle: "模式结果",
        aiModeOk: "成功",
        aiModeFail: "失败",
        aiWarnings: "警告",
        aiSkippedEdited: "以下模式在 AI 请求期间被修改，已跳过未覆盖：",
        aiNone: "无",
        aiRecommendNote: "市场推荐需核对供应商可用性与价格",
        aiSourceLocal: "本地",
        aiSourceMarket: "市场",
        aiAvailableLocal: "本地可用",
        aiReason: "理由",
        aiStrength: "优势",
        aiCaution: "注意",
        aiError: "AI 请求失败",
        aiNetworkError: "网络请求失败，无法连接本地服务（可能被代理或离线打断），请检查网络/代理后重试",
        aiAbortedError: "请求被中止（超时或中断），请重试",
        aiHttpError: "请求返回错误",
        aiJsonError: "本地服务返回了无法解析的响应（非 JSON）",
        aiNoResponse: "本地服务请求未收到响应",
        aiJobTimeout: "任务轮询超时",
        aiJobStillRunning: "任务可能仍在后台运行，请勿立即重新生成",
        aiJobGone: "任务不存在或已过期（可能因服务重启而丢失）",
        aiPollExhausted: "轮询任务状态时连续失败，请检查本地服务后重试",
        aiRecommendEmpty: "AI 未返回推荐结果。",
        releaseNotesFailed: "版本说明读取失败。",
        releaseHistory: "历史版本",
        releaseFiles: "文件",
      },
      en: {
        nav: "Run modes & team routing",
        title: "Run modes & team routing",
        subtitle:
          "Choose Economy / Normal / Performance, then configure the Lead, upgrade advisor, team and subagent-role model routes and reasoning effort. Authorization and role assignment stay independent; unknown capabilities never guess an effort.",
        enabled: "Enable role routing",
        enabledHint: "Saving with this off removes every subagent model authorization. Open sessions keep their snapshot.",
        primary: "Primary",
        backup: "Backup",
        upgrade: "Upgrade",
        primaryHint: "The everyday route.",
        backupHint: "A manual fallback when primary is unavailable; never switched automatically.",
        upgradeHint: "An explicit stronger route when the task outgrows primary.",
        unset: "Not set",
        configure: "Configure",
        collapse: "Collapse",
        addRole: "Add role",
        restoreRoles: "Restore default roles",
        restoreAuthorized: "Restore default authorizations",
        authorizedTitle: "Authorized models",
        authorizedHint: "Models you explicitly authorize for subagents. Roles can only pick routes from this list; authorization and role assignment never change each other.",
        authorizedEmpty: "No authorized models yet. Add one here first.",
        emptyAuthorized: "Enable role routing requires at least one authorized model.",
        addAuthorized: "Authorize model",
        revoke: "Revoke",
        referencedBy: "used by",
        notReferenced: "no role uses it",
        revokeBlocked: "This model is referenced by {n} role route(s) ({list}). Remove those references before revoking.",
        rolePickerEmpty: "No authorized models yet. Add one in \"Authorized models\" above.",
        roleSectionTitle: "Role assignment",
        unauthorizedOption: "not authorized",
        conflictTitle: "Configuration anomaly",
        conflictLine: "Role {name} uses {route} for {tier}, which is not authorized; that role cannot be dispatched.",
        changesTitle: "Saving will:",
        changeAddAuth: "add {n} authorization(s): {list}",
        changeRevokeAuth: "revoke {n} authorization(s): {list}",
        changeRoles: "change role configuration",
        changeEnabled: "change the enabled switch",
        migratedNote: "Authorizations were migrated from the previous role configuration; saving writes the new format.",
        tierPrimary: "primary",
        tierBackup: "backup",
        tierUpgrade: "upgrade",
        recentDispatches: "Recent dispatches",
        recentHint: "Observation for this host process, not a complete history.",
        recentEmpty: "Nothing recorded yet.",
        advanced: "Advanced and write target",
        reload: "Reload",
        validateAndSave: "Validate and save",
        saving: "Saving…",
        validating: "Validating {n} models…",
        validateConfirm:
          "This will validate {n} authorized models with one minimal request each, which may cost money. A failure blocks the save and leaves the current configuration untouched. Continue?",
        saved: "Saved. Only newly opened top-level sessions carry the new authorization.",
        unchanged: "No unsaved changes.",
        dirty: "Unsaved changes.",
        conflict: "The configuration changed elsewhere. Reload before saving again.",
        roleName: "Role name",
        rolePurpose: "What the role does",
        roleEnabled: "Role enabled",
        roleDisabled: "disabled",
        switchRule: "Switching: after confirmation only (never automatic in this version)",
        removeRole: "Delete role",
        deleteRoleConfirm: "Delete role \"{name}\"? The draft only; nothing applies before a save.",
        restoreRolesConfirm:
          "Reset the role draft to the 14 built-in roles (authorized models are untouched). The draft only; nothing applies before validation and save. Continue?",
        restoreAuthorizedConfirm:
          "Reset the authorization draft to the default {count} routes (role assignment is untouched). The draft only; save to apply. Continue?",
        noRoleRoutes: "This role's route is decided by rules and cannot be pinned to one model.",
        privacyRule: "Never dispatched automatically; no cloud fallback.",
        authorPrefix: "author",
        reviewPrefix: "review",
        unlistedTitle: "Planned models not allowed",
        unlistedEmpty: "Every referenced route is written into the authorization.",
        roleIdLabel: "Role id",
        roleIdHint: "Lowercase letters, digits, dot, underscore or hyphen; renaming keeps history.",
        manualRoute: "Manual provider / model",
        newRoleName: "New role",
        validationTitle: "Validation",
        validationOk: "All passed",
        validationFailed: "{n} models failed; nothing was saved.",
        validationNote: "A pass only means one minimal request completed just now: not identity, quality or future availability.",
        transient: "Did not pass this time",
        permanent: "Did not pass",
        rolesFailed: "Could not read the role configuration; the page cannot edit it right now.",
        catalogFailed: "Could not read the model catalogue; the picker may be incomplete.",
        storePath: "Role store file",
        policyRevision: "Authorization revision",
        derivedTitle: "Authorization this configuration implies",
        driftTitle: "Authorization and role configuration disagree; a save would realign them.",
        consistencyTitle: "The last save could not roll back. Dispatch is blocked; reload and save again.",
        notPersistent: "No writable profile directory, so roles cannot be persisted.",
        refresh: "Refresh",
        loading: "Loading…",
        unknownRole: "Unassigned role",
        statusRunning: "running",
        statusCompleted: "completed",
        statusAborted: "aborted",
        statusError: "error",
        statusBlocked: "blocked",
        statusInterrupted: "interrupted",
        statusMaxTokens: "max tokens",
        requested: "requested",
        actual: "called",
        actualNote: "\"called\" comes from the llm/stream arguments, which is not proof of a successful answer.",
        role: "Role",
        task: "Task",
        status: "Status",
        runModeTitle: "Run modes",
        runModeSubtitle: "Economy, Normal, Performance and Broke each keep their own draft. Saving settings and enabling a mode are two steps: save writes the draft (not enabled), enable marks it current and applies the Lead default. Actual effect follows the execution wiring below; it is limited to this plugin (Lead default + native subagent dispatch) and never hijacks the global model routing.",
        modeCurrent: "current",
        modeDirty: "unsaved changes",
        modeSaved: "Draft saved (not enabled). Enable to make it current.",
        rolesSaveFailed: "Role store sync failed (mode draft saved).",
        rolesSaveConflict: "Role config was changed elsewhere (revision mismatch); reloaded. Save again.",
        globalLoadFailed: "Role store failed to load; cannot save safely. Refresh and retry.",
        modeEnabled: "Enabled \"{label}\".",
        modeEnabledUnknown: "Execution wiring state is unknown (backend returned no integration info); refresh to confirm.",
        wiringLeadDefault: "Lead default",
        wiringNative: "Native subagent dispatch",
        wiringSession: "Session snapshot",
        wiringTaskBoard: "Cross-session task board",
        wiringOn: ": wired",
        wiringOff: ": not wired",
        wiringScopeNote: "Effect is limited to this plugin (Lead default + role_subagent dispatch); it never hijacks the global model routing.",
        modeEnableDirty: "This draft has unsaved changes. Save the draft before enabling.",
        modeEnableFailed: "Enable failed (nothing written):",
        modeSaveConflict: "Save conflict: this mode was changed elsewhere (revision mismatch); the latest config was reloaded. Review and save again.",
        modeEnableConflict: "Enable conflict: this mode was changed elsewhere (revision mismatch); the latest config was reloaded. Review and enable again.",
        saveDraft: "Save draft",
        enableMode: "Enable this mode",
        restorePreset: "Restore preset",
        restorePresetConfirm: "Reset Lead, upgrade advisor, roles, team and task targets of \"{label}\" to the recommended preset (custom roles and revision are kept); referenced routes are merged into the authorization draft (add-only). Draft only; save to apply. Continue?",
        restorePresetMissing: "The backend did not return recommended presets (stale version); cannot restore. Refresh or upgrade the plugin.",
        restoreAuthorizedDone: "Authorization draft restored to the default {count} routes; save to apply.",
        copyMode: "Copy mode",
        copyFromLabel: "Copy from…",
        copyFromConfirm: "Copy the full configuration (Lead, upgrade advisor, roles, team, task targets) of \"{source}\" into the \"{target}\" draft, overwriting it. Save to apply. Continue?",
        modeCopied: "Copied into draft (not saved).",
        modeRestored: "Preset restored into draft (not saved).",
        modeClear: "Clear",
        unsavedSwitch: "\"{label}\" has unsaved changes; switching discards them. Continue?",
        leadTitle: "Lead default route",
        leadLabel: "Lead model",
        advisorLabel: "Upgrade advisor",
        advisorEnabled: "Enable upgrade advisor",
        advisorCondition: "Upgrade condition",
        teamTitle: "Subagent dispatch policy",
        teamPlanner: "Planner",
        teamExecutor: "Executor",
        teamReviewer: "Reviewer",
        teamAdvisor: "Advisor",
        teamConcurrency: "Max concurrent workers",
        teamConcurrencyHint: "role_subagent dispatch scope; empty = unlimited",
        teamRetry: "Failure retry limit",
        teamRetryHint: "empty = unlimited",
        teamEscalation: "Escalation threshold",
        teamWriteIsolation: "Write-scope isolation",
        teamBudget: "Budget limit",
        teamBudgetHint: "empty = no limit",
        targetsTitle: "Task execution targets",
        targetNative: "Native same-tree subagents",
        targetBoard: "Task board sessions",
        targetBoardUnsupported: "Task board execution is not wired (no backend service can run an independent session), so this option is disabled.",
        targetBoardNote: "Task board: rc.3 agentTeams.createTask is a shared TODO ledger only — no independent session or model routing, so no session toggle is offered.",
        rolesTitle: "Subagent roles in this mode",
        rolesHint: "Primary / backup / upgrade routes use the same flat reasoning config; reviewer and privacy roles keep their existing special rules.",
        dispatchTitle: "Dispatch control",
        nativeScopeNote: "This toggle only controls whether role_subagent dispatch may use native subagents; it never disables other native tools.",
        teamOverrideTitle: "Collaboration identity override",
        teamOverrideHint: "Applies only to explicitly declared team roles; the collaboration identity override route takes priority over a specialized role's configured route; an explicit override ranks higher still; direct native subagent calls never auto-apply these routes.",
        advisorGroupTitle: "Collaboration advice",
        advisorGroupHint: "The condition is advisory only — it never triggers automatic scheduling; the lead model decides upgrades explicitly.",
        reasoningPolicyLabel: "Reasoning policy",
        reasoningPolicy_default: "Model default",
        reasoningPolicy_fixed: "Fixed effort",
        reasoningPolicy_smart: "Smart by difficulty",
        reasoningEffortLabel: "Fixed effort",
        reasoningSmart_low: "Low difficulty →",
        reasoningSmart_medium: "Medium difficulty →",
        reasoningSmart_high: "High difficulty →",
        reasoningPreviewDefault: "Sends: adapter default (no reasoningEffort)",
        reasoningPreviewFixed: "Sends: fixed effort {effort}",
        reasoningPreviewSmart: "Sends: difficulty mapped to the model's allowed raw effort IDs",
        reasoningPreviewInvalid: "Effort not in the model's allowed list → falls back to adapter default",
        reasoningFallback: "Capability unknown / expired: falls back to adapter default; no guessed effort.",
        reasoningStale: "The stored effort is currently unavailable (capability unknown / expired / narrowed). Refresh the capability first, or explicitly switch back to \"model default\"; stored values are never silently overwritten.",
        reasoningNoEfforts: "This model declares no usable reasoning efforts; only \"model default\" is supported.",
        reasoningResidual: " \u00b7 invalid effort",
        capTitle: "Capability cache (local)",
        capHint: "Keyed by provider+model; source is catalog-declared (configSource=declared; real endpoint changes are not verifiable). Refresh only reads local adapter metadata (listProviders / listModels / resolveModelInfo) and never issues a paid model request.",
        capEmpty: "No capabilities detected yet; click \"Refresh\" to read local adapter metadata.",
        capRefresh: "Refresh capabilities (local metadata, no cost)",
        capRefreshing: "Detecting locally…",
        capRefreshed: "Capability cache refreshed (local metadata; no paid request issued).",
        capSourceCatalog: "catalog",
        capSourceUnknown: "unknown",
        capStatusOk: "ok",
        capStatusFailed: "failed",
        capStatusUnknown: "unknown",
        capStatusExpired: "expired",
        capStatusInvalidated: "invalidated",
        capStatusStale: "stale",
        capDetectedAt: "detected",
        capEfforts: "efforts",
        capEffortsDefault: "default (adapter)",
        capEffortsOff: "off (no efforts)",
        capCacheStatus: "capability cache",
        capFailed: "Failed to read capability cache:",
        capNotPersistent: "No writable config directory; modes cannot persist.",
        modesFailed: "Failed to read run modes.",
        modeCurrentShort: "current",
        modeDirtyShort: "unsaved",
        modeDescTitle: "About this mode",
        tabTeam: "Main session & dispatch control",
        tabRoles: "Subagent roles",
        tabAuthorized: "Authorized models",
        tabHub: "Model & Role Hub",
        tabModels: "Model config",
        saveSettings: "Save settings",
        testConnection: "Test connections",
        testConnectionHint: "Probes each authorized model with one minimal real request (may incur cost); pass shows a green dot, fail a red dot.",
        testPass: "passed",
        testFail: "failed",
        notTested: "untested",
        testedNote: "Connections tested (one minimal real request per authorized model).",
        tierTitle: "Model tiers",
        tierHint: "Four tiers and their authorized models; the backend benchmark DB is never shown.",
        refreshTiers: "Refresh tiers",
        tierBroke: "Broke tier",
        tierEconomy: "Economy tier",
        tierNormal: "Normal tier",
        tierPerformance: "Performance tier",
        tiersFallbackNote: "The backend returned no tier data; a front-end fallback (by provider) is shown.",
        authorizedTabHint: "Only authorized models are listed with their tier; the full model catalogue is never shown.",
        changelogTitle: "Version control & release notes",
        versionCurrent: "current version",
        recentNone: "No dispatch records (this plugin does not persist a dispatch log).",
        authorizedEmptyTab: "No authorized models yet.",
        aiTitle: "AI assistant",
        aiConfigureTitle: "One-click configure",
        aiConfigureDesc: "Generate primary/backup/upgrade routes and reasoning configs for all four modes using the selected authorized model (makes real model calls, ~4).",
        aiConfigureButton: "Configure",
        aiRecommendTitle: "One-click recommend",
        aiRecommendDesc: "Recommend market model candidates per role/mode (makes real calls; verify vendor availability and pricing).",
        aiRecommendButton: "Recommend",
        aiPickModel: "Execution model",
        aiBusy: "AI working…",
        aiPaidHint: "Makes real model requests (~4) and may incur cost.",
        aiConfigureDone: "Configured: successful modes merged into drafts (unsaved).",
        aiRecommendDone: "Recommendation complete.",
        aiRecommendPartial: "Some modes failed to recommend:",
        aiNewAuth: "new authorized drafts",
        aiSaveAll: "Save all drafts",
        aiSaveAllDone: "All drafts saved.",
        aiSaveAllPartial: "Some drafts failed to save",
        aiResultTitle: "Mode result",
        aiModeOk: "ok",
        aiModeFail: "failed",
        aiWarnings: "Warnings",
        aiSkippedEdited: "These modes were edited while the AI request was in flight and were skipped (not overwritten):",
        aiNone: "none",
        aiRecommendNote: "Market recommendations need vendor availability and pricing verification",
        aiSourceLocal: "local",
        aiSourceMarket: "market",
        aiAvailableLocal: "available locally",
        aiReason: "Reason",
        aiStrength: "Strengths",
        aiCaution: "Cautions",
        aiError: "AI request failed",
        aiNetworkError: "Network request failed — could not reach the local service (proxy or offline?). Check your network/proxy and retry",
        aiAbortedError: "Request aborted (timeout or interrupted); please retry",
        aiHttpError: "Request returned an error",
        aiJsonError: "The local service returned an unparsable (non-JSON) response",
        aiNoResponse: "The local service did not respond",
        aiJobTimeout: "Task polling timed out",
        aiJobStillRunning: "The task may still be running in the background; do not re-generate immediately",
        aiJobGone: "Task not found or expired (it may have been lost after a service restart)",
        aiPollExhausted: "Repeated failures while polling the task; check the local service and retry",
        aiRecommendEmpty: "AI returned no recommendations.",
        releaseNotesFailed: "Failed to load release notes.",
        releaseHistory: "History",
        releaseFiles: "Files",
      },
    };

    /* ---------------------------------------------------------------- *
     * Styles
     * ---------------------------------------------------------------- */

    var CSS = [
      ".mrs-set{display:flex;flex-direction:column;gap:14px;padding:4px 2px 8px;}",
      ".mrs-set__head{display:flex;flex-direction:column;gap:4px;}",
      ".mrs-set__head--row{flex-direction:row;align-items:center;justify-content:space-between;gap:12px;}",
      ".mrs-set__headtext{display:flex;flex-direction:column;gap:4px;min-width:0;}",
      ".mrs-set__title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0;}",
      ".mrs-set__sub{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);margin:0;}",
      ".mrs-switch{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;}",
      ".mrs-switch input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}",
      ".mrs-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:9px;}",
      ".mrs-card__title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0;}",
      ".mrs-card__title--section{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:20px 0 0;}",
      ".mrs-card__hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:0;}",
      ".mrs-roles{display:flex;flex-direction:column;gap:8px;}",
      ".mrs-role{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 13px;display:flex;flex-direction:column;gap:7px;}",
      ".mrs-role__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      ".mrs-role__name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}",
      ".mrs-role__id{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}",
      ".mrs-role__purpose{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);margin:0;}",
      ".mrs-role__routes{display:flex;flex-direction:column;gap:3px;}",
      ".mrs-route{display:grid;grid-template-columns:40px 8px minmax(0,1fr);column-gap:6px;row-gap:2px;align-items:baseline;font-size:12px;}",
      ".mrs-route--pair{grid-template-columns:40px minmax(0,1fr);}",
      ".mrs-route__key{color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
      ".mrs-route__value{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;min-width:0;overflow-wrap:anywhere;}",
      ".mrs-route__value--wrap{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}",
      ".mrs-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto;display:inline-block;}",
      ".mrs-dot--ok{background:var(--dsw-alias-state-success-primary);}",
      ".mrs-dot--bad{background:var(--dsw-alias-state-error-primary);}",
      ".mrs-dot--running{background:var(--dsw-alias-state-warn-primary);}",
      ".mrs-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}",
      ".mrs-tagrow{display:flex;gap:6px;flex-wrap:wrap;}",
      ".mrs-tag{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}",
      ".mrs-btn{font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;}",
      ".mrs-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}",
      ".mrs-btn:disabled{opacity:.45;cursor:not-allowed;}",
      ".mrs-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}",
      ".mrs-btn--ghost{background:transparent;}",
      ".mrs-btn--danger{color:var(--dsw-alias-state-error-primary);}",
      ".mrs-btnrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}",
      ".mrs-editor{display:flex;flex-direction:column;gap:9px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:9px;}",
      ".mrs-field{display:flex;flex-direction:column;gap:4px;}",
      ".mrs-field__label{font-size:11px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-input, .mrs-select, .mrs-textarea{font-size:12px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);width:100%;box-sizing:border-box;font-family:inherit;}",
      ".mrs-textarea{min-height:56px;resize:vertical;line-height:1.5;}",
      ".mrs-select{cursor:pointer;}",
      ".mrs-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;}",
      ".mrs-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:0;}",
      ".mrs-warn{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warn-primary);margin:0;}",
      ".mrs-err{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);margin:0;}",
      ".mrs-ok{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-success-primary);margin:0;}",
      ".mrs-details{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}",
      ".mrs-details > summary{cursor:pointer;list-style:none;padding:9px 13px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);}",
      ".mrs-details > summary::-webkit-details-marker{display:none;}",
      ".mrs-details > summary::before{content:'▸';display:inline-block;width:14px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-details[open] > summary::before{content:'▾';}",
      ".mrs-details__body{padding:0 13px 11px;display:flex;flex-direction:column;gap:8px;}",
      ".mrs-ledger{width:100%;border-collapse:collapse;font-size:12px;}",
      ".mrs-ledger th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);}",
      ".mrs-ledger td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);vertical-align:top;}",
      ".mrs-ledger tbody tr:last-child td{border-bottom:none;}",
      ".mrs-ledger .mrs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;}",
      ".mrs-statuscell{display:flex;align-items:center;gap:5px;}",
      ".mrs-footer{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}",
      ".mrs-footer__status{font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-list{display:flex;flex-direction:column;gap:5px;}",
      ".mrs-listrow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:8px;align-items:center;padding:3px 0;}",
      ".mrs-listrow__text{display:flex;flex-direction:column;gap:2px;min-width:0;}",
      ".mrs-listrow__text .mrs-route__value{white-space:normal;overflow-wrap:anywhere;}",
      ".mrs-listrow__refs{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".mrs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;}",
      ".mrs-validrow{display:flex;align-items:baseline;gap:7px;font-size:12px;}",
      ".mrs-mmodes{display:flex;flex-direction:column;gap:12px;margin-bottom:20px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}",
      ".mrs-mhead{display:flex;flex-direction:column;gap:6px;}",
      ".mrs-mtabs{display:flex;gap:8px;flex-wrap:wrap;}",
      ".mrs-mtab{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;}",
      ".mrs-mtab--active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base);}",
      ".mrs-mbody{display:flex;flex-direction:column;gap:14px;}",
      ".mrs-mgroup{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}",
      ".mrs-mgroup h4{margin:0 0 2px;font-size:13px;color:var(--dsw-alias-label-primary);}",
      ".mrs-mroute{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--dsw-alias-border-l1);border-radius:6px;}",
      ".mrs-mroute__top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
      ".mrs-mroute__policy{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;}",
      ".mrs-mroute__model{flex:1 1 220px;min-width:200px;}",
      ".mrs-mroute__preview{font-size:11px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-mroute__efforts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
      ".mrs-mroute__efforts label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;}",
      ".mrs-mactions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
      ".mrs-mcap{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}",
      ".mrs-mcaprow{display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;}",
      ".mrs-mcaprow__key{font-family:monospace;color:var(--dsw-alias-label-primary);}",
      ".mrs-mcaprow__efforts{color:var(--dsw-alias-label-secondary);}",
      ".mrs-capgrid{display:flex;flex-direction:column;gap:6px;width:100%;overflow-x:auto;}",
      ".mrs-caprow{display:grid;grid-template-columns:64px minmax(150px,1.4fr) minmax(110px,1fr) minmax(88px,0.8fr) minmax(110px,1fr) minmax(110px,1fr) 84px;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;min-width:860px;}",
      ".mrs-caprow--head{background:var(--dsw-alias-bg-layer-1);font-weight:600;color:var(--dsw-alias-label-secondary);border:none;padding:6px 8px;}",
      ".mrs-caprow__test{display:inline-flex;align-items:center;gap:4px;}",
      ".mrs-caprow__model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary);word-break:break-all;}",
      ".mrs-caprow__tier{display:inline-flex;align-items:center;}",
      ".mrs-caprow__cache{display:inline-flex;align-items:center;gap:4px;}",
      ".mrs-caprow__efforts{color:var(--dsw-alias-label-secondary);word-break:break-all;}",
      ".mrs-caprow__refs{font-size:11px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-caprow__act{display:inline-flex;justify-content:flex-end;}",
      ".mrs-mroute--disabled{opacity:.62;}",
      ".mrs-mroute--disabled .mrs-mroute,.mrs-mroute--disabled .mrs-field{pointer-events:none;}",
      ".mrs-mmodes--saving{pointer-events:none;opacity:.72;}",
      ".mrs-mbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;width:100%;}",
      ".mrs-mbar .mrs-mtab{width:100%;justify-content:center;}",
      ".mrs-mdot--current{color:var(--dsw-alias-state-success-primary);font-weight:700;font-size:12px;}",
      ".mrs-mdot--dirty{color:var(--dsw-alias-state-error-primary);font-weight:700;font-size:12px;}",
      ".mrs-msubtabs{display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:8px;}",
      ".mrs-msubtab{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;}",
      ".mrs-msubtab--active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base);}",
      ".mrs-mdesc{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}",
      ".mrs-mdesc__title{font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-mdesc__body{font-size:13px;color:var(--dsw-alias-label-primary);}",
      ".mrs-mtagline{font-size:13px;color:var(--dsw-alias-state-error-primary);font-weight:700;}",
      ".mrs-mtiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;}",
      ".mrs-mtiercard{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}",
      ".mrs-mtiercard__title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}",
      ".mrs-mtiercard__models{font-size:12px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;}",
      ".mrs-mchangelog{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}",
      ".mrs-tierlegend{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;align-items:center;}",
      ".mrs-tierbadge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-primary);}",
      ".mrs-mver{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden;}",
      ".mrs-mver__head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary);}",
      ".mrs-mver__body{padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".mrs-aicards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;}",
      ".mrs-aicard{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}",
      ".mrs-aicard__title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}",
      ".mrs-aicard__desc{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);}",
      ".mrs-airesult{display:flex;flex-direction:column;gap:6px;}",
      ".mrs-airesult__row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;}",
      ".mrs-airesult__mode{font-weight:600;color:var(--dsw-alias-label-primary);}",
      ".mrs-airesult__ok{color:var(--dsw-alias-state-success-primary);}",
      ".mrs-airesult__fail{color:var(--dsw-alias-state-error-primary);}",
      ".mrs-aiwarn{font-size:11px;color:var(--dsw-alias-state-warn-primary);line-height:1.5;}",
      ".mrs-recgroup{display:flex;flex-direction:column;gap:8px;}",
      ".mrs-reccand{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;}",
      ".mrs-reccand__model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary);}",
      ".mrs-reccand__meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}",
      ".mrs-mver__history{margin-top:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden;}",
      ".mrs-mver__sec{display:flex;flex-direction:column;gap:3px;margin-bottom:6px;}",
      ".mrs-mver__sectitle{font-weight:600;color:var(--dsw-alias-label-primary);}",
      ".mrs-mver__sec ul{margin:0;padding-left:18px;}",
      ".mrs-mver__sec li{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;}",
    ].join("\n");

    function installStyles() {
      try {
        if (document.getElementById(STYLE_ID)) return;
        var node = document.createElement("style");
        node.id = STYLE_ID;
        node.textContent = CSS;
        document.head.appendChild(node);
      } catch (error) {
        console.error("[" + PACKAGE_ID + "] could not install styles", error);
      }
    }

    /* ---------------------------------------------------------------- *
     * Transport
     * ---------------------------------------------------------------- */

    function apiUrl(relative) {
      try {
        var resolved = new URL(relative, document.baseURI);
        return resolved.pathname + resolved.search;
      } catch {
        return relative;
      }
    }

    function fetchErrorKind(error) {
      var name = (error && error.name) || "";
      var message = (error && error.message) || "";
      var text = (name + " " + message).toLowerCase();
      if (name === "AbortError" || /abort/i.test(text)) return "aborted";
      if (/failed to fetch|fetch failed|network|load failed|failed to load|econnrefused|econnreset|enotfound|eai_again|etimedout|dns|socket|connect/i.test(text)) return "network";
      return "unknown";
    }

    // Bounded, safe client-side error formatter: preserves the nested `cause`
    // chain, `code`, `status`, and a bounded `AggregateError.errors` list without
    // touching `.stack` or arbitrary keys (credentials can live there). The
    // client bundle cannot import the host `ai-assistant.js` helper, so this is a
    // self-contained mirror of `formatError`.
    function clientFormatError(error) {
      var maxDepth = 4;
      var maxLength = 600;
      var maxItems = 4;
      function render(err, depth) {
        if (err === null || err === undefined) return String(err);
        if (typeof err !== "object" && typeof err !== "function") return String(err);
        if (depth > maxDepth) return "[…]";
        var parts = [];
        if (typeof err.name === "string" && err.name !== "" && err.name !== "Error") parts.push(err.name);
        if (typeof err.message === "string" && err.message !== "") parts.push(err.message);
        if (typeof err.code === "string" && err.code !== "") parts.push("code=" + err.code);
        if (typeof err.status === "number" && isFinite(err.status)) parts.push("status=" + err.status);
        if (err.errors !== undefined && err.errors !== null) {
          var list = Array.isArray(err.errors) ? err.errors : [err.errors];
          var items = list.slice(0, maxItems).map(function (item) { return render(item, depth + 1); });
          if (list.length > maxItems) items.push("…(+" + (list.length - maxItems) + ")");
          parts.push("errors=[" + items.join(" | ") + "]");
        }
        if (err.cause !== undefined && err.cause !== null && err.cause !== err) {
          parts.push("cause=" + render(err.cause, depth + 1));
        }
        if (parts.length === 0) parts.push(String(err));
        return parts.join(" ");
      }
      var result = render(error, 0);
      return result.length > maxLength ? result.slice(0, maxLength) + "…" : result;
    }

    async function requestJson(relative, options) {
      var init = Object.assign(
        { method: "GET", cache: "no-store", headers: { accept: "application/json" } },
        options || {},
      );
      if (init.body !== undefined) {
        init.headers = Object.assign({}, init.headers, { "content-type": "application/json" });
        init.body = JSON.stringify(init.body);
      }
      var response;
      try {
        response = await fetch(apiUrl(relative), init);
      } catch (error) {
        // EVERY rejection here means the browser got no HTTP response
        // (network/abort/proxy). Normalize all of them to one semantic
        // no-response error so a browser TypeError is never re-wrapped into a
        // same-named TypeError — that produced the duplicate
        // "TypeError Failed to fetch cause=TypeError Failed to fetch". The
        // original error is kept as `cause` and rendered bounded by
        // clientFormatError, so nested detail (e.g. ECONNREFUSED) survives.
        var noResponse = new Error("network request did not receive a response");
        noResponse.name = "NoResponseError";
        noResponse.kind = "no-response";
        noResponse.cause = error;
        throw noResponse;
      }
      var data = null;
      var parseError = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
        parseError = String((error && error.message) || error);
      }
      return { status: response.status, ok: response.ok, data: data, parseError: parseError };
    }

    /* ---------------------------------------------------------------- *
     * Small helpers
     * ---------------------------------------------------------------- */

    function readLanguage(ctx) {
      try {
        var locale = ctx && typeof ctx.get === "function" ? ctx.get("locale") : null;
        var value = locale && typeof locale.getLocale === "function" ? locale.getLocale() : null;
        if (typeof value === "string" && value.toLowerCase().indexOf("en") === 0) return "en";
      } catch {
        /* locale is optional */
      }
      return "zh";
    }

    function routeKeyOf(route) {
      return route && route.provider && route.model ? route.provider + "\u0000" + route.model : "";
    }

    function parseRouteKey(key) {
      if (typeof key !== "string" || key === "") return null;
      var at = key.indexOf("\u0000");
      if (at <= 0) return null;
      return { provider: key.slice(0, at), model: key.slice(at + 1) };
    }

    function routeText(route) {
      if (!route || !route.provider || !route.model) return "";
      return route.reasoningEffort
        ? route.provider + " / " + route.model + " · " + route.reasoningEffort
        : route.provider + " / " + route.model;
    }

    function fmtTime(value) {
      if (!value) return "";
      try {
        return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
      } catch {
        return "";
      }
    }

    function statusLabel(copy, status) {
      var map = {
        running: copy.statusRunning,
        completed: copy.statusCompleted,
        aborted: copy.statusAborted,
        error: copy.statusError,
        blocked: copy.statusBlocked,
        interrupted: copy.statusInterrupted,
        "max-tokens": copy.statusMaxTokens,
      };
      return map[status] || status || "";
    }

    function statusDotClass(status) {
      if (status === "completed") return "mrs-dot mrs-dot--ok";
      if (status === "running") return "mrs-dot mrs-dot--running";
      if (status === "error" || status === "aborted" || status === "blocked") return "mrs-dot mrs-dot--bad";
      return "mrs-dot";
    }

    function clone(value) {
      return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
    }

    function draftFrom(roles, authorizedModels, enabled) {
      return {
        enabled: enabled === true,
        roles: clone(Array.isArray(roles) ? roles : []),
        authorizedModels: clone(Array.isArray(authorizedModels) ? authorizedModels : []),
      };
    }

    function nonVisionRoute(route) { return !!route && !/-vision$/i.test(route.provider || ""); }

    function authorizedList(draft) {
      var seen = {};
      var out = [];
      (draft && draft.authorizedModels ? draft.authorizedModels : []).forEach(function (route) {
        if (!route || !route.provider || !route.model || !nonVisionRoute(route)) return;
        var key = routeKeyOf(route);
        if (seen[key]) return;
        seen[key] = true;
        out.push({ provider: route.provider, model: route.model });
      });
      return out;
    }

    function tierLabel(copy, tier) {
      if (tier === "backup") return copy.tierBackup;
      if (tier === "upgrade") return copy.tierUpgrade;
      return copy.tierPrimary;
    }

    function refsText(copy, refs) {
      if (!refs || refs.length === 0) return copy.notReferenced;
      return (
        copy.referencedBy +
        "：" +
        refs
          .map(function (row) {
            return (row.roleName || row.roleId) + " · " + tierLabel(copy, row.tier);
          })
          .join("、")
      );
    }

    /** Picker options for a role route: only authorized models (plus the current value). */
    function authorizedOptions(catalog, authorized, extras, copy) {
      var labels = {};
      (catalog || []).forEach(function (provider) {
        if (/-vision$/i.test(provider.id || "")) return;
        (provider.models || []).forEach(function (model) {
          labels[routeKeyOf({ provider: provider.id, model: model.id })] =
            (model.name || model.id) + " · " + provider.id + "/" + model.id;
        });
      });
      var options = [];
      var seen = {};
      (authorized || []).forEach(function (route) {
        if (!nonVisionRoute(route)) return;
        var value = routeKeyOf(route);
        if (value === "" || seen[value]) return;
        seen[value] = true;
        options.push({ value: value, label: labels[value] || routeText(route) });
      });
      (extras || []).forEach(function (route) {
        if (!nonVisionRoute(route)) return;
        var value = routeKeyOf(route);
        if (value === "" || seen[value]) return;
        seen[value] = true;
        options.push({ value: value, label: routeText(route) + " · " + copy.unauthorizedOption });
      });
      return options;
    }

    /** Picker options for the authorization list: the whole catalogue. */
    function catalogOptions(catalog, currentRoutes) {
      var options = [];
      var seen = {};
      (catalog || []).forEach(function (provider) {
        if (/-vision$/i.test(provider.id || "")) return;
        (provider.models || []).forEach(function (model) {
          var value = routeKeyOf({ provider: provider.id, model: model.id });
          if (seen[value]) return;
          seen[value] = true;
          options.push({ value: value, label: (model.name || model.id) + " · " + provider.id + "/" + model.id });
        });
      });
      (currentRoutes || []).forEach(function (route) {
        if (!nonVisionRoute(route)) return;
        var value = routeKeyOf(route);
        if (value === "" || seen[value]) return;
        seen[value] = true;
        options.push({ value: value, label: routeText(route) + " (不在目录)" });
      });
      return options;
    }

    function SettingsPage() {
      var ctx = hostContext;
      var copy = COPY[readLanguage(ctx)];
      var [catalog, setCatalog] = useState([]);
      var [catalogFailed, setCatalogFailed] = useState(false);
      useEffect(function () {
        var alive = true;
        requestJson(CATALOG_PATH).then(function (r) {
          if (!alive) return;
          if (r && r.ok && r.data && r.data.ok === true) {
            setCatalog(r.data.providers || []);
            setCatalogFailed(false);
          } else {
            setCatalog([]);
            setCatalogFailed(true);
          }
        });
        return function () { alive = false; };
      }, []);
      return h(
        "section",
        { className: "mrs-set" },
        h(
          "div",
          { className: "mrs-set__head" },
          h("h3", { className: "mrs-set__title" }, copy.title),
          h("p", { className: "mrs-set__sub" }, copy.subtitle),
        ),
        catalogFailed ? h("p", { className: "mrs-warn" }, copy.catalogFailed) : null,
        h(ModesPanel, { copy: copy, catalog: catalog }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Run modes (three-mode) helpers + components
     * ------------------------------------------------------------------ */

    function capabilitySource(source, copy) {
      if (source === "catalog" || source === "measured") return copy.capSourceCatalog;
      if (source === "unknown") return copy.capSourceUnknown;
      return source || copy.capSourceUnknown;
    }

    function capabilityStatus(status, copy) {
      if (status === "ok") return copy.capStatusOk;
      if (status === "failed") return copy.capStatusFailed;
      if (status === "invalidated") return copy.capStatusInvalidated;
      if (status === "expired") return copy.capStatusExpired;
      if (status === "stale") return copy.capStatusStale;
      return copy.capStatusUnknown;
    }

    function capDotClass(status) {
      if (status === "ok") return "mrs-dot mrs-dot--ok";
      if (status === "failed" || status === "invalidated") return "mrs-dot mrs-dot--bad";
      if (status === "expired" || status === "stale") return "mrs-dot mrs-dot--running";
      return "mrs-dot";
    }

    function capMapOf(records) {
      var map = {};
      (records || []).forEach(function (rec) {
        if (rec && rec.provider && rec.model) {
          map[routeKeyOf({ provider: rec.provider, model: rec.model })] = rec;
        }
      });
      return map;
    }

    function effortOptionsOf(record) {
      var eff = record && Array.isArray(record.efforts) ? record.efforts : null;
      if (!eff || eff.length === 0) return null;
      return eff
        .map(function (e) {
          if (e && typeof e.id === "string" && e.id !== "") {
            return { value: e.id, label: e.name && e.name !== e.id ? e.id + " · " + e.name : e.id };
          }
          return null;
        })
        .filter(Boolean);
    }

    function capEffective(record) {
      if (!record) return null;
      return record.effectiveStatus || record.status || null;
    }

    function isCapOk(record) {
      return capEffective(record) === "ok";
    }

    function normalizeReasonedRoute(value) {
      if (!value || typeof value !== "object") return null;
      if (typeof value.provider !== "string" || typeof value.model !== "string") return null;
      if (value.provider === "" || value.model === "") return null;
      var policy = REASONING_POLICIES.indexOf(value.reasoningPolicy) >= 0 ? value.reasoningPolicy : "default";
      var effort = typeof value.reasoningEffort === "string" && value.reasoningEffort !== "" ? value.reasoningEffort : null;
      var smart = value.smartMap && typeof value.smartMap === "object" && !Array.isArray(value.smartMap) ? value.smartMap : null;
      if (smart) {
        var clean = { low: null, medium: null, high: null };
        DIFFICULTIES.forEach(function (t) {
          var v = smart[t];
          clean[t] = typeof v === "string" && v !== "" ? v : null;
        });
        smart = clean;
      }
      return { provider: value.provider, model: value.model, reasoningPolicy: policy, reasoningEffort: effort, smartMap: smart };
    }

    function reasoningPreview(route, record, copy) {
      if (!route) return "";
      var policy = REASONING_POLICIES.indexOf(route.reasoningPolicy) >= 0 ? route.reasoningPolicy : "default";
      if (policy === "default") return copy.reasoningPreviewDefault;
      if (policy === "fixed") {
        var eff = route.reasoningEffort;
        if (!eff) return copy.reasoningPreviewInvalid;
        var opts = effortOptionsOf(record);
        if (opts && opts.length > 0 && !opts.some(function (o) { return o.value === eff; })) {
          return copy.reasoningPreviewInvalid;
        }
        return copy.reasoningPreviewFixed.replace("{effort}", eff);
      }
      var map = route.smartMap || {};
      var opts2 = effortOptionsOf(record);
      var okAll = DIFFICULTIES.every(function (t) {
        var v = map[t];
        if (!v) return false;
        if (opts2 && opts2.length > 0) return opts2.some(function (o) { return o.value === v; });
        return true;
      });
      return okAll ? copy.reasoningPreviewSmart : copy.reasoningPreviewInvalid;
    }

    function reasoningValid(route, record) {
      if (!route) return true;
      var policy = REASONING_POLICIES.indexOf(route.reasoningPolicy) >= 0 ? route.reasoningPolicy : "default";
      if (policy === "default") return true;
      if (!isCapOk(record)) return false;
      var opts = effortOptionsOf(record);
      if (!opts || opts.length === 0) return false;
      if (policy === "fixed") {
        var eff = route.reasoningEffort;
        if (!eff) return false;
        return opts.some(function (o) { return o.value === eff; });
      }
      var map = route.smartMap || {};
      return DIFFICULTIES.every(function (t) {
        var v = map[t];
        if (!v) return false;
        return opts.some(function (o) { return o.value === v; });
      });
    }

    function wiringSummary(integration, copy, label) {
      var base = copy.modeEnabled.replace("{label}", label);
      if (!integration || !integration.leadDefault) {
        return base + " " + copy.modeEnabledUnknown;
      }
      var parts = [];
      parts.push(copy.wiringLeadDefault + (integration.leadDefault.wired ? copy.wiringOn : copy.wiringOff));
      parts.push(copy.wiringNative + (integration.nativeDispatch && integration.nativeDispatch.wired ? copy.wiringOn : copy.wiringOff));
      parts.push(copy.wiringSession + (integration.sessionSnapshot && integration.sessionSnapshot.wired ? copy.wiringOn : copy.wiringOff));
      parts.push(copy.wiringTaskBoard + (integration.taskBoard && integration.taskBoard.wired ? copy.wiringOn : copy.wiringOff));
      return base + " " + parts.join("；") + "。" + copy.wiringScopeNote;
    }

    function modeRouteOptions(authorized, currentKey, copy) {
      var opts = [];
      var seen = {};
      (authorized || []).forEach(function (a) {
        if (nonVisionRoute(a) && a.provider && a.model) {
          var k = routeKeyOf(a);
          if (!seen[k]) {
            seen[k] = true;
            opts.push({ value: k, label: routeText(a) });
          }
        }
      });
      if (currentKey && !seen[currentKey]) {
        var parsed = parseRouteKey(currentKey);
        if (parsed && nonVisionRoute(parsed)) opts.push({ value: currentKey, label: routeText(parsed) + " · " + copy.unauthorizedOption });
      }
      return opts;
    }

    function tierOfProvider(provider) {
      for (var i = 0; i < TIER_FALLBACK.length; i++) {
        if (TIER_FALLBACK[i].providers.indexOf(provider) >= 0) return TIER_FALLBACK[i].tier;
      }
      return "normal";
    }

    function tierLabelOf(tier, copy) {
      var key = tier === "broke" ? "tierBroke" : tier === "economy" ? "tierEconomy" : tier === "normal" ? "tierNormal" : "tierPerformance";
      return (TIER_EMOJI[tier] || "") + " " + (copy[key] || tier);
    }

    // Resolve a model's tier from the backend /tiers modelTierMap (keyed by
    // "provider/model", slash-separated), falling back to the provider-level
    // heuristic only when no model-level mapping exists.
    function routeTierId(route, tiers) {
      var mt = tiers && tiers.modelTierMap;
      if (mt && route && route.provider && route.model) {
        var e = mt[route.provider + "/" + route.model];
        if (e && e.tierId) {
          return e.tierId;
        }
      }
      return route ? tierOfProvider(route.provider) : "normal";
    }

    function versionList() {
      return VERSIONS;
    }

    function ReasonedRouteEditor(props) {
      var copy = props.copy;
      var label = props.label;
      var value = props.value;
      var authorized = props.authorized;
      var capMap = props.capMap;
      var onChange = props.onChange;

      var route = normalizeReasonedRoute(value);
      var key = route ? routeKeyOf(route) : "";
      var options = useMemo(function () { return modeRouteOptions(authorized, key, copy); }, [authorized, key, copy]);
      var record = key ? capMap[key] : null;
      var capOk = isCapOk(record);
      var effortOptions = effortOptionsOf(record);
      var canReason = capOk && effortOptions && effortOptions.length > 0;
      var statusText = capabilityStatus(capEffective(record), copy);
      var policy = route ? route.reasoningPolicy : "default";
      var preview = route ? reasoningPreview(route, record, copy) : "";

      function setModel(nextKey) {
        var parsed = parseRouteKey(nextKey);
        if (!parsed) { onChange(null); return; }
        var same = route && route.provider === parsed.provider && route.model === parsed.model;
        onChange({
          provider: parsed.provider,
          model: parsed.model,
          reasoningPolicy: same && route.reasoningPolicy ? route.reasoningPolicy : "default",
          reasoningEffort: same && route.reasoningEffort ? route.reasoningEffort : null,
          smartMap: same && route.smartMap ? route.smartMap : null,
        });
      }

      function setPolicy(p) {
        if (!route) return;
        var next = clone(route);
        next.reasoningPolicy = p;
        if (p === "default") { next.reasoningEffort = null; next.smartMap = null; }
        else if (p === "fixed") { next.smartMap = null; }
        else if (p === "smart") {
          next.reasoningEffort = null;
          next.smartMap = next.smartMap && typeof next.smartMap === "object" ? next.smartMap : { low: null, medium: null, high: null };
        }
        onChange(next);
      }

      function setEffort(e) {
        if (!route) return;
        var next = clone(route);
        next.reasoningEffort = e || null;
        onChange(next);
      }

      function setSmart(tier, e) {
        if (!route) return;
        var next = clone(route);
        var map = next.smartMap && typeof next.smartMap === "object" ? clone(next.smartMap) : { low: null, medium: null, high: null };
        map[tier] = e || null;
        next.smartMap = map;
        onChange(next);
      }

      var children = [];

      var modelField = h("label", { className: "mrs-field mrs-mroute__model", key: "model" },
        h("span", { className: "mrs-field__label" }, label),
        h("select", { className: "mrs-select", value: key, onChange: function (e) { setModel(e.target.value); } },
          h("option", { value: "" }, copy.unset),
          options.map(function (o) { return h("option", { value: o.value, key: o.value, disabled: !!o.disabled }, o.label); })
        )
      );

      var policyEl = route ? h("div", { className: "mrs-mroute__policy", key: "policy" },
        h("span", { className: "mrs-mroute__preview" }, copy.reasoningPolicyLabel),
        h("select", { className: "mrs-select", value: policy, onChange: function (e) { setPolicy(e.target.value); } },
          REASONING_POLICIES.map(function (rp) {
            return h("option", { value: rp, key: rp, disabled: !canReason && rp !== "default" }, copy["reasoningPolicy_" + rp]);
          })
        )
      ) : null;

      children.push(h("div", { className: "mrs-mroute__top", key: "top" },
        modelField,
        policyEl
      ));

      if (route) {
        function effortSelect(currentValue) {
          var has = currentValue && effortOptions.some(function (o) { return o.value === currentValue; });
          return h("select", { className: "mrs-select", value: currentValue || "", onChange: function (e) { setEffort(e.target.value); } },
            h("option", { value: "" }, copy.unset),
            effortOptions.map(function (o) { return h("option", { value: o.value, key: o.value }, o.label); }),
            !has && currentValue ? h("option", { value: currentValue, disabled: true }, currentValue + copy.reasoningResidual) : null
          );
        }

        function smartSelect(tier, currentValue) {
          var has = currentValue && effortOptions.some(function (o) { return o.value === currentValue; });
          return h("select", { className: "mrs-select", value: currentValue || "", onChange: function (e) { setSmart(tier, e.target.value); } },
            h("option", { value: "" }, copy.unset),
            effortOptions.map(function (o) { return h("option", { value: o.value, key: o.value }, o.label); }),
            !has && currentValue ? h("option", { value: currentValue, disabled: true }, currentValue + copy.reasoningResidual) : null
          );
        }

        if (policy === "fixed") {
          if (canReason) {
            children.push(h("div", { className: "mrs-mroute__efforts", key: "fixed" },
              h("label", null, copy.reasoningEffortLabel, effortSelect(route.reasoningEffort))));
          } else {
            var hint = capOk ? copy.reasoningNoEfforts : copy.reasoningStale;
            children.push(h("div", { className: "mrs-mroute__efforts", key: "fixed" },
              h("span", { className: "mrs-mroute__preview" }, copy.reasoningEffortLabel + "：" + (route.reasoningEffort || "—")),
              h("span", { className: "mrs-mroute__preview" }, hint)));
          }
        } else if (policy === "smart") {
          var map = route.smartMap || {};
          if (canReason) {
            children.push(h("div", { className: "mrs-mroute__efforts", key: "smart" },
              DIFFICULTIES.map(function (tier) {
                return h("label", { key: tier }, copy["reasoningSmart_" + tier], smartSelect(tier, map[tier]));
              })));
          } else {
            var hint2 = capOk ? copy.reasoningNoEfforts : copy.reasoningStale;
            var readOnlyText = DIFFICULTIES.map(function (tier) {
              return copy["reasoningSmart_" + tier] + " " + (map[tier] || "—");
            }).join("  ");
            children.push(h("div", { className: "mrs-mroute__efforts", key: "smart" },
              h("span", { className: "mrs-mroute__preview" }, readOnlyText),
              h("span", { className: "mrs-mroute__preview" }, hint2)));
          }
        }

        children.push(h("span", { className: "mrs-mroute__preview", key: "preview" }, preview));
        if (!capOk && key && policy === "default") {
          children.push(h("span", { className: "mrs-mroute__preview", key: "fallback" }, copy.reasoningFallback));
        }
        children.push(h("span", { className: "mrs-badge", key: "capstatus" },
          h("span", { className: capDotClass(capEffective(record)) }), " ", statusText));
      }

      return h("div", { className: "mrs-mroute" }, children);
    }

    function ModeRoleCard(props) {
      var copy = props.copy;
      var role = props.role;
      var authorized = props.authorized;
      var capMap = props.capMap;
      var onPatch = props.onPatch;
      var onToggle = props.onToggle;
      var onRemove = props.onRemove;

      if (!role) return null;

      function patchPrimary(v) { onPatch(function (r) { r.primary = v; return r; }); }
      function patchBackup(v) { onPatch(function (r) { r.backup = v; return r; }); }
      function patchUpgrade(v) { onPatch(function (r) { r.upgrade = v; return r; }); }
      function patchPairing(index, v) {
        onPatch(function (r) {
          var ps = (r.pairings || []).slice();
          var prev = ps[index] || {};
          ps[index] = { authorProviders: prev.authorProviders || [], reviewer: v };
          r.pairings = ps;
          return r;
        });
      }

      var title = (role.name || role.id || "") + " · " + role.id;
      var kind = role.kind === "reviewer" || role.kind === "privacy" ? role.kind : "standard";
      var disabled = role.enabled === false;

      return h("div", { className: "mrs-mroute" + (disabled ? " mrs-mroute--disabled" : ""), "data-role-id": role.id },
        h("div", { className: "mrs-card__title" },
          h("span", null, title),
          disabled ? h("span", { className: "mrs-badge" }, copy.roleDisabled) : null),
        h("div", { className: "mrs-btnrow" },
          h("label", { className: "mrs-check" },
            h("input", { type: "checkbox", checked: !disabled, onChange: function (e) { onToggle(e.target.checked); } }),
            copy.roleEnabled),
          h("button", { type: "button", className: "mrs-btn mrs-btn--danger", onClick: function () { onRemove(); } }, copy.removeRole)),
        kind === "privacy"
          ? h("p", { className: "mrs-hint" }, copy.privacyRule)
          : kind === "reviewer"
            ? (role.pairings || []).map(function (p, i) {
                var authors = (p.authorProviders || []).join(" / ");
                return h("div", { className: "mrs-mroute", key: "p" + i },
                  h("div", { className: "mrs-mroute__preview" }, copy.authorPrefix + "：" + authors),
                  h(ReasonedRouteEditor, {
                    copy: copy,
                    label: copy.reviewPrefix,
                    value: p.reviewer,
                    authorized: authorized,
                    capMap: capMap,
                    onChange: function (v) { patchPairing(i, v); },
                  })
                );
              })
            : TIERS.map(function (tier) {
                var val = role[tier];
                var onChange = tier === "primary" ? patchPrimary : (tier === "backup" ? patchBackup : patchUpgrade);
                return h(ReasonedRouteEditor, {
                  key: tier,
                  copy: copy,
                  label: tierLabel(copy, tier),
                  value: val,
                  authorized: authorized,
                  capMap: capMap,
                  onChange: onChange,
                });
              })
      );
    }

    function ModesPanel(props) {
      var copy = props.copy;

      function aiFailureMessage(kind, message, backendError) {
        var cause = message ? "：" + message : "";
        if (kind === "no-response") return copy.aiNoResponse + cause;
        if (kind === "network") return copy.aiNetworkError + cause;
        if (kind === "aborted") return copy.aiAbortedError + cause;
        if (kind === "json") return copy.aiJsonError + cause;
        if (kind === "auth") return copy.aiError + "（权限/凭据不足）" + cause;
        if (kind === "rate-limit") return copy.aiError + "（限流）" + cause;
        return (backendError || copy.aiHttpError) + cause;
      }
      var catalog = (props.catalog || []).filter(function (p) { return !/-vision$/i.test(p.id || ""); });

      var modes = null;
      var setModes = null;
      var modesState = useState(null);
      modes = modesState[0];
      setModes = modesState[1];

      var capabilities = null;
      var setCapabilities = null;
      var capsState = useState(null);
      capabilities = capsState[0];
      setCapabilities = capsState[1];

      var drafts = null;
      var setDrafts = null;
      var draftsState = useState({});
      drafts = draftsState[0];
      setDrafts = draftsState[1];
      var draftsRef = useRef({});
      draftsRef.current = drafts;

      var selected = null;
      var setSelected = null;
      var selState = useState(null);
      selected = selState[0];
      setSelected = selState[1];

      var status = null;
      var setStatus = null;
      var statusState = useState("");
      status = statusState[0];
      setStatus = statusState[1];

      var statusKind = null;
      var setStatusKind = null;
      var statusKindState = useState("ok");
      statusKind = statusKindState[0];
      setStatusKind = statusKindState[1];

      var loadError = null;
      var setLoadError = null;
      var loadErrorState = useState("");
      loadError = loadErrorState[0];
      setLoadError = loadErrorState[1];

      var capFailed = null;
      var setCapFailed = null;
      var capFailedState = useState("");
      capFailed = capFailedState[0];
      setCapFailed = capFailedState[1];

      var refreshing = null;
      var setRefreshing = null;
      var refreshingState = useState(false);
      refreshing = refreshingState[0];
      setRefreshing = refreshingState[1];

      var copySource = null;
      var setCopySource = null;
      var copySourceState = useState("");
      copySource = copySourceState[0];
      setCopySource = copySourceState[1];

      var integration = null;
      var setIntegration = null;
      var integrationState = useState(null);
      integration = integrationState[0];
      setIntegration = integrationState[1];

      var activeTab = null;
      var setActiveTab = null;
      var activeTabState = useState(0);
      activeTab = activeTabState[0];
      setActiveTab = activeTabState[1];

      var tested = null;
      var setTested = null;
      var testedState = useState(false);
      tested = testedState[0];
      setTested = testedState[1];

      var tiers = null;
      var setTiers = null;
      var tiersState = useState(null);
      tiers = tiersState[0];
      setTiers = tiersState[1];

      var tiersFailed = null;
      var setTiersFailed = null;
      var tiersFailedState = useState(false);
      tiersFailed = tiersFailedState[0];
      setTiersFailed = tiersFailedState[1];

      var refreshingTiers = null;
      var setRefreshingTiers = null;
      var refreshingTiersState = useState(false);
      refreshingTiers = refreshingTiersState[0];
      setRefreshingTiers = refreshingTiersState[1];

      var openVersions = null;
      var setOpenVersions = null;
      var openVersionsState = useState({});
      openVersions = openVersionsState[0];
      setOpenVersions = openVersionsState[1];

      var authDraft = null;
      var setAuthDraft = null;
      var authDraftState = useState(null);
      authDraft = authDraftState[0];
      setAuthDraft = authDraftState[1];

      var validateResults = null;
      var setValidateResults = null;
      var validateResultsState = useState({});
      validateResults = validateResultsState[0];
      setValidateResults = validateResultsState[1];

      var testRunning = null;
      var setTestRunning = null;
      var testRunningState = useState(false);
      testRunning = testRunningState[0];
      setTestRunning = testRunningState[1];

      var saving = null;
      var setSaving = null;
      var savingState = useState(false);
      saving = savingState[0];
      setSaving = savingState[1];

      var globalEnabled = null;
      var setGlobalEnabled = null;
      var globalEnabledState = useState(null);
      globalEnabled = globalEnabledState[0];
      setGlobalEnabled = globalEnabledState[1];

      var globalRevision = null;
      var setGlobalRevision = null;
      var globalRevisionState = useState(null);
      globalRevision = globalRevisionState[0];
      setGlobalRevision = globalRevisionState[1];

      var globalLoadFailed = null;
      var setGlobalLoadFailed = null;
      var globalLoadFailedState = useState(false);
      globalLoadFailed = globalLoadFailedState[0];
      setGlobalLoadFailed = globalLoadFailedState[1];

      var pendingGlobal = null;
      var setPendingGlobal = null;
      var pendingGlobalState = useState(false);
      pendingGlobal = pendingGlobalState[0];
      setPendingGlobal = pendingGlobalState[1];

      var pickAuth = null;
      var setPickAuth = null;
      var pickAuthState = useState("");
      pickAuth = pickAuthState[0];
      setPickAuth = pickAuthState[1];

      var authBlocked = null;
      var setAuthBlocked = null;
      var authBlockedState = useState("");
      authBlocked = authBlockedState[0];
      setAuthBlocked = authBlockedState[1];

      var aiBusy = null;
      var setAiBusy = null;
      var aiBusyState = useState(false);
      aiBusy = aiBusyState[0];
      setAiBusy = aiBusyState[1];

      var pickConfigureModel = null;
      var setPickConfigureModel = null;
      var pickConfigureModelState = useState("");
      pickConfigureModel = pickConfigureModelState[0];
      setPickConfigureModel = pickConfigureModelState[1];

      var pickRecommendModel = null;
      var setPickRecommendModel = null;
      var pickRecommendModelState = useState("");
      pickRecommendModel = pickRecommendModelState[0];
      setPickRecommendModel = pickRecommendModelState[1];

      var aiConfigResult = null;
      var setAiConfigResult = null;
      var aiConfigResultState = useState(null);
      aiConfigResult = aiConfigResultState[0];
      setAiConfigResult = aiConfigResultState[1];

      var aiRecommendResult = null;
      var setAiRecommendResult = null;
      var aiRecommendResultState = useState(null);
      aiRecommendResult = aiRecommendResultState[0];
      setAiRecommendResult = aiRecommendResultState[1];

      var releaseNotes = null;
      var setReleaseNotes = null;
      var releaseNotesState = useState(null);
      releaseNotes = releaseNotesState[0];
      setReleaseNotes = releaseNotesState[1];

      var releaseNotesFailed = null;
      var setReleaseNotesFailed = null;
      var releaseNotesFailedState = useState(false);
      releaseNotesFailed = releaseNotesFailedState[0];
      setReleaseNotesFailed = releaseNotesFailedState[1];

      var historyOpen = null;
      var setHistoryOpen = null;
      var historyOpenState = useState(false);
      historyOpen = historyOpenState[0];
      setHistoryOpen = historyOpenState[1];

      useEffect(function () {
        var alive = true;
        function guarded(handler) {
          return function (r) { if (alive) handler(r); };
        }
        // Each fetch is isolated: one GET throwing/rejecting must never block the
        // release notes or any of the other loaders.
        requestJson(MODES_PATH).then(guarded(function (r) {
          if (r && r.ok && r.data && r.data.ok) {
            setModes(r.data);
            setAuthDraft(clone(r.data.authorizedModels || []));
            var d = {};
            Object.keys(r.data.modes || {}).forEach(function (k) { d[k] = clone(r.data.modes[k]); });
            setDrafts(d);
            var sel = r.data.currentModeId;
            if (MODE_IDS.indexOf(sel) < 0) sel = MODE_IDS[0];
            setSelected(sel);
            setLoadError("");
          } else {
            setLoadError(copy.modesFailed + (r && r.data && r.data.error ? " " + r.data.error : ""));
          }
        })).catch(function () { if (alive) setLoadError(copy.modesFailed); });

        requestJson(CAPABILITIES_PATH).then(guarded(function (c) {
          if (c && c.ok && c.data && c.data.ok) {
            setCapabilities(c.data);
            setCapFailed("");
          } else {
            setCapFailed(copy.capFailed + (c && c.data && c.data.error ? " " + c.data.error : ""));
          }
        })).catch(function () { if (alive) setCapFailed(copy.capFailed); });

        requestJson(EXECUTION_INTEGRATION_PATH).then(guarded(function (it) {
          if (it && it.ok && it.data && it.data.ok) setIntegration(it.data);
        })).catch(function () {});

        requestJson(TIERS_PATH).then(guarded(function (t) {
          if (t && t.ok && t.data && t.data.ok) {
            setTiers(t.data);
            setTiersFailed(false);
          } else {
            setTiers(null);
            setTiersFailed(true);
          }
        })).catch(function () { if (alive) setTiersFailed(true); });

        requestJson(ROLES_PATH).then(guarded(function (g) {
          if (g && g.ok && g.data && g.data.ok) {
            if (typeof g.data.enabled === "boolean") setGlobalEnabled(g.data.enabled);
            if (typeof g.data.revision === "number") setGlobalRevision(g.data.revision);
            setGlobalLoadFailed(false);
          } else {
            setGlobalLoadFailed(true);
          }
        })).catch(function () { if (alive) setGlobalLoadFailed(true); });

        requestJson(RELEASE_NOTES_PATH).then(guarded(function (rn) {
          if (rn && rn.ok && rn.data && rn.data.versions && rn.data.versions.length) {
            setReleaseNotes(rn.data);
            setReleaseNotesFailed(false);
            var ov = {};
            var latestVersion = rn.data.versions[0];
            if (latestVersion && latestVersion.version) ov[latestVersion.version] = true;
            setOpenVersions(ov);
          } else {
            setReleaseNotes(null);
            setReleaseNotesFailed(true);
          }
        })).catch(function () { if (alive) setReleaseNotesFailed(true); });

        return function () { alive = false; };
      }, []);

      var capMap = useMemo(function () { return capMapOf(capabilities && capabilities.records); }, [capabilities]);
      var authorized = (authDraft || (modes && modes.authorizedModels) || []).filter(nonVisionRoute);
      var storedModes = (modes && modes.modes) || {};
      var currentDraft = selected ? drafts[selected] : null;
      var stored = selected ? storedModes[selected] : null;
      var authDirty = !!modes && JSON.stringify(authorized) !== JSON.stringify((modes.authorizedModels) || []);
      var dirty = authDirty || pendingGlobal || (!!(currentDraft && stored) && JSON.stringify(currentDraft) !== JSON.stringify(stored));
      var isCurrent = selected && modes ? modes.currentModeId === selected : false;
      var dirtyModeIds = MODE_IDS.filter(function (id) {
        var d = drafts[id];
        var s = storedModes[id];
        return d && s && JSON.stringify(d) !== JSON.stringify(s);
      });
      var saveAllCount = dirtyModeIds.length + (authDirty || pendingGlobal ? 1 : 0);

      function setStatusMsg(kind, msg) {
        setStatusKind(kind);
        setStatus(msg);
      }

      function updateDraft(modeId, updater) {
        setDrafts(function (prev) {
          var next = {};
          Object.keys(prev).forEach(function (k) {
            next[k] = k === modeId ? updater(clone(prev[k] || {})) : prev[k];
          });
          if (!next[modeId]) next[modeId] = updater({});
          return next;
        });
      }

      function modeLabel(id) {
        var names = { economy: "经济", normal: "普通", performance: "性能", broke: "穷鬼" };
        return names[id] || id;
      }

      function modeDescription(id) {
        var names = {
          economy: "经济：GPT 不可用或额度不足时，优先高质量、成本可控的国产模型。这是偏好而非禁用，任何已授权模型都可按需选用。",
          normal: "普通：在质量、速度与成本之间取平衡，按任务特点匹配合适的模型。",
          performance: "性能：质量与复杂任务优先，允许更高的推理预算与异构复核。",
          broke: "穷鬼：极限节约成本，优先低开销模型。这是成本偏好，不禁用任何已授权模型。",
        };
        return names[id] || "—";
      }

      // Legacy v2.3 broke preset used "吃土去" as the advisor-condition
      // sentinel. Show the neutral default in its place (display only — the
      // underlying draft value is not rewritten), so a stale backend or HMR
      // window can never surface the old sentinel in the input.
      function advisorConditionText(condition) {
        if (typeof condition === "string" && condition.trim() === "吃土去") {
          return "极限节约时默认关闭，可按需开启";
        }
        return condition || "";
      }

      function reloadModes() {
        return requestJson(MODES_PATH).then(function (r) {
          if (r && r.ok && r.data && r.data.ok) {
            setModes(r.data);
            var d = {};
            Object.keys(r.data.modes || {}).forEach(function (k) { d[k] = clone(r.data.modes[k]); });
            setDrafts(d);
            var sel = r.data.currentModeId;
            if (MODE_IDS.indexOf(sel) < 0) sel = MODE_IDS[0];
            setSelected(sel);
          }
          return r;
        });
      }

      // Refresh only the STORED snapshot (server truth), preserving every
      // unsaved draft and the current selection. Used after a 409 so the next
      // save attempt uses the fresh revision without overwriting edits.
      function refreshStoredModes() {
        return requestJson(MODES_PATH).then(function (r) {
          if (r && r.ok && r.data && r.data.ok) {
            setModes(r.data);
          }
          return r;
        });
      }

      function reloadGlobal() {
        return requestJson(ROLES_PATH).then(function (r) {
          if (r && r.ok && r.data && r.data.ok) {
            if (typeof r.data.enabled === "boolean") setGlobalEnabled(r.data.enabled);
            if (typeof r.data.revision === "number") setGlobalRevision(r.data.revision);
            setGlobalLoadFailed(false);
          } else {
            setGlobalLoadFailed(true);
          }
          return r;
        });
      }

      function selectMode(id) {
        if (id === selected) return;
        var d = drafts[selected];
        var s = storedModes[selected];
        var isDirty = d && s && JSON.stringify(d) !== JSON.stringify(s);
        if (isDirty) {
          if (!window.confirm(copy.unsavedSwitch.replace("{label}", modeLabel(selected)))) return;
        }
        setSelected(id);
        setStatus("");
      }

      function runGlobalSave(syncRoles) {
        // Block writes while the live store state is unknown: never assume an
        // enabled flag or drop the CAS revision when GET /roles failed to load.
        if (globalEnabled === null || globalRevision === null) {
          setPendingGlobal(true);
          setStatusMsg("err", copy.globalLoadFailed);
          return Promise.resolve();
        }
        // Only the current mode's roles are the live global set; saving any
        // other mode syncs authorizations only (using the stored current-mode
        // roles so an unrelated draft never silently overwrites the store).
        var globalRoles = syncRoles
          ? (currentDraft.roles || [])
          : (modes && modes.currentModeId && storedModes[modes.currentModeId]
              ? (storedModes[modes.currentModeId].roles || [])
              : []);
        var rolesBody = {
          enabled: globalEnabled === true,
          roles: globalRoles,
          authorizedModels: authorized,
          skipValidation: true,
          expectedRevision: globalRevision,
        };

        return requestJson(SAVE_PATH, { method: "POST", body: rolesBody }).then(function (rr) {
          var rd = rr && rr.data;
          if (rr && rr.ok && rd && rd.ok) {
            setModes(function (prev) {
              if (!prev) return prev;
              var next = clone(prev);
              next.authorizedModels = clone(authorized);
              return next;
            });
            setAuthDraft(clone(authorized));
            if (typeof rd.revision === "number") setGlobalRevision(rd.revision);
            setPendingGlobal(false);
            setStatusMsg("ok", copy.modeSaved);
          } else if (rr && rr.status === 409) {
            // Global store changed elsewhere: reload and keep the draft dirty so
            // the user can retry instead of believing the save succeeded.
            setPendingGlobal(true);
            reloadGlobal();
            setStatusMsg("warn", copy.rolesSaveConflict);
          } else {
            // Keep the unsaved authDraft; report partial failure explicitly and
            // never claim the global sync succeeded.
            setPendingGlobal(true);
            setStatusMsg("warn", copy.modeSaved + " " + copy.rolesSaveFailed);
          }
        });
      }

      function saveMode() {
        if (!selected || !currentDraft || saving) return;
        var s = storedModes[selected];
        var modeDirty = !!(currentDraft && s) && JSON.stringify(currentDraft) !== JSON.stringify(s);

        var storedAuth = (modes && modes.authorizedModels) || [];
        var authChanged = JSON.stringify(authorized) !== JSON.stringify(storedAuth);
        var syncRoles = !!(modes && modes.currentModeId === selected);
        var syncGlobal = authChanged || syncRoles;

        setSaving(true);
        setStatus("");

        // Auth-only change or a pending global retry: no mode draft to persist.
        if (!modeDirty) {
          if (syncGlobal || pendingGlobal) {
            runGlobalSave(syncRoles)
              .catch(function (e) {
                setPendingGlobal(true);
                setStatusMsg("err", copy.modesFailed + " " + String((e && e.message) || e));
              })
              .then(function () { setSaving(false); });
          } else {
            setStatusMsg("ok", copy.modeSaved);
            setSaving(false);
          }
          return;
        }

        var expectedRevision = s && typeof s.revision === "number" ? s.revision : null;
        var body = { modeId: selected, mode: currentDraft };
        if (expectedRevision !== null) body.expectedRevision = expectedRevision;

        requestJson(MODE_SAVE_PATH, { method: "POST", body: body })
          .then(function (r) {
            var d = r && r.data;
            if (!(r && r.ok && d && d.ok)) {
              if (r && r.status === 409) {
                setStatusMsg("err", copy.modeSaveConflict);
                reloadModes();
              } else if (r && r.status === 503) {
                setStatusMsg("err", copy.capNotPersistent);
              } else {
                setStatusMsg("err", copy.modesFailed + " " + (d && d.error ? d.error : (r ? String(r.status) : "")));
              }
              return null;
            }
            setModes(function (prev) {
              if (!prev) return prev;
              var next = clone(prev);
              if (!next.modes) next.modes = {};
              next.modes[selected] = d.mode;
              return next;
            });
            setDrafts(function (prev) {
              var next = {};
              Object.keys(prev).forEach(function (k) { next[k] = k === selected ? clone(d.mode) : prev[k]; });
              return next;
            });
            if (!syncGlobal) {
              setPendingGlobal(false);
              setStatusMsg("ok", copy.modeSaved);
              return null;
            }
            return runGlobalSave(syncRoles);
          })
          .catch(function (e) {
            setPendingGlobal(true);
            setStatusMsg("err", copy.modesFailed + " " + String((e && e.message) || e));
          })
          .then(function () {
            setSaving(false);
          });
      }

      function enableMode() {
        if (!selected) return;
        if (dirty) {
          setStatusMsg("warn", copy.modeEnableDirty);
          return;
        }
        var s = storedModes[selected];
        var expectedRevision = s && typeof s.revision === "number" ? s.revision : null;
        var body = { modeId: selected };
        if (expectedRevision !== null) body.expectedRevision = expectedRevision;
        setStatus("");
        requestJson(MODE_ENABLE_PATH, { method: "POST", body: body }).then(function (r) {
          var d = r && r.data;
          if (r && r.ok && d && d.ok) {
            setModes(function (prev) {
              if (!prev) return prev;
              var next = clone(prev);
              next.currentModeId = d.currentModeId;
              if (d.activeSnapshot) next.activeSnapshot = d.activeSnapshot;
              return next;
            });
            setStatusMsg("ok", wiringSummary(integration, copy, modeLabel(selected)));
          } else if (r && r.status === 409) {
            setStatusMsg("err", copy.modeEnableConflict);
            reloadModes();
          } else if (r && r.status === 422 && d && Array.isArray(d.errors)) {
            setStatusMsg("err", copy.modeEnableFailed + " " + d.errors.join("；"));
          } else {
            setStatusMsg("err", copy.modesFailed + " " + (d && d.error ? d.error : (r ? String(r.status) : "")));
          }
        });
      }

      function mergePresetRoles(currentRoles, presetRoles) {
        var presetIds = {};
        (presetRoles || []).forEach(function (r) { presetIds[r.id] = true; });
        var merged = (presetRoles || []).map(function (r) {
          var cur = null;
          (currentRoles || []).forEach(function (c) { if (c.id === r.id) cur = c; });
          var nr = clone(r);
          if (cur && cur.enabled === false) nr.enabled = false;
          return nr;
        });
        (currentRoles || []).forEach(function (c) {
          if (!presetIds[c.id]) merged.push(clone(c));
        });
        return merged;
      }

      function restorePreset() {
        if (!selected) return;
        var presets = modes && modes.recommendedPresets;
        var preset = presets && presets[selected];
        if (!preset) { setStatusMsg("err", copy.restorePresetMissing); return; }
        if (!window.confirm(copy.restorePresetConfirm.replace("{label}", modeLabel(selected)))) return;
        updateDraft(selected, function (d) {
          d.lead = clone(preset.lead);
          d.upgradeAdvisor = clone(preset.upgradeAdvisor);
          d.roles = mergePresetRoles(d.roles, preset.roles);
          d.team = clone(preset.team);
          d.taskTargets = clone(preset.taskTargets);
          return d;
        });
        // Merge every route referenced by the recommended preset into the
        // authorization draft (add-only). This never removes existing grants.
        var routes = [];
        collectRoutesOfMode(preset, routes);
        setAuthDraft(function (prev) {
          var keys = {};
          (prev || []).forEach(function (a) { keys[routeKeyOf(a)] = true; });
          var next = (prev || []).slice();
          routes.forEach(function (rt) {
            var k = routeKeyOf(rt);
            if (!keys[k]) { keys[k] = true; next.push({ provider: rt.provider, model: rt.model }); }
          });
          return next;
        });
        setStatusMsg("ok", copy.modeRestored);
      }

      function copyFrom() {
        if (!selected || !copySource || copySource === selected) return;
        var src = storedModes[copySource];
        if (!src) return;
        if (!window.confirm(copy.copyFromConfirm.replace("{source}", modeLabel(copySource)).replace("{target}", modeLabel(selected)))) return;
        updateDraft(selected, function (d) {
          d.lead = clone(src.lead);
          d.upgradeAdvisor = clone(src.upgradeAdvisor);
          d.roles = clone(src.roles);
          d.team = clone(src.team);
          d.taskTargets = clone(src.taskTargets);
          return d;
        });
        setStatusMsg("ok", copy.modeCopied);
      }

      function refreshCaps() {
        setRefreshing(true);
        setStatus("");
        requestJson(CAPABILITIES_REFRESH_PATH, { method: "POST", body: {} }).then(function (r) {
          setRefreshing(false);
          var d = r && r.data;
          if (r && r.ok && d && d.ok) {
            setCapabilities(d);
            setStatusMsg("ok", copy.capRefreshed);
          } else {
            setStatusMsg("err", copy.capFailed + " " + (d && d.error ? d.error : (r ? String(r.status) : "")));
          }
        });
      }

      function testConnections() {
        setTestRunning(true);
        setStatus("");
        var body = { enabled: true, authorizedModels: authorized, roles: currentDraft.roles || [] };
        requestJson(VALIDATE_PATH, { method: "POST", body: body }).then(function (r) {
          setTestRunning(false);
          var d = r && r.data;
          if (r && r.ok) {
            var map = {};
            var results = (d && d.results) || [];
            results.forEach(function (row) {
              if (row && row.provider && row.model) map[routeKeyOf(row)] = row;
            });
            setValidateResults(map);
            setTested(true);
            setStatusMsg("ok", copy.testedNote);
          } else {
            setStatusMsg("err", copy.capFailed + " " + (d && d.error ? d.error : (r ? String(r.status) : "")));
          }
        });
      }

      function loadTiers() {
        return requestJson(TIERS_PATH).then(function (r) {
          if (r && r.ok && r.data && r.data.ok) {
            setTiers(r.data);
            setTiersFailed(false);
          } else {
            setTiers(null);
            setTiersFailed(true);
          }
          return r;
        });
      }

      function refreshTiers() {
        setRefreshingTiers(true);
        setStatus("");
        requestJson(TIERS_REFRESH_PATH, { method: "POST", body: {} }).then(function () {
          return loadTiers();
        }).then(function () {
          setRefreshingTiers(false);
          setStatusMsg("ok", copy.capRefreshed);
        });
      }

      function toggleVersion(v) {
        setOpenVersions(function (prev) {
          var next = {};
          Object.keys(prev).forEach(function (k) { next[k] = prev[k]; });
          next[v] = !prev[v];
          return next;
        });
      }

      function patchAdvisor(v) {
        updateDraft(selected, function (d) {
          var prev = d.upgradeAdvisor || {};
          var enabled = prev.enabled !== false;
          var condition = typeof prev.condition === "string" ? prev.condition : "";
          if (v) {
            d.upgradeAdvisor = {
              enabled: enabled,
              condition: condition,
              provider: v.provider,
              model: v.model,
              reasoningPolicy: v.reasoningPolicy,
              reasoningEffort: v.reasoningEffort,
              smartMap: v.smartMap,
            };
          } else {
            d.upgradeAdvisor = { enabled: enabled, condition: condition };
          }
          return d;
        });
      }

      function patchTeam(fn) {
        updateDraft(selected, function (d) {
          d.team = d.team || {};
          fn(d.team);
          return d;
        });
      }

      function patchTargets(fn) {
        updateDraft(selected, function (d) {
          d.taskTargets = d.taskTargets || { native: { enabled: true }, taskBoard: { enabled: false } };
          fn(d.taskTargets);
          return d;
        });
      }

      var team = (currentDraft && currentDraft.team) || {};
      var targets = (currentDraft && currentDraft.taskTargets) || { native: { enabled: true }, taskBoard: { enabled: false } };
      var roles = (currentDraft && currentDraft.roles) || [];
      var taskBoardSupported = !!(integration && integration.taskBoard && integration.taskBoard.wired === true);
      var TEAM_LABELS = { planner: "teamPlanner", executor: "teamExecutor", reviewer: "teamReviewer", advisor: "teamAdvisor" };
      var records = (capabilities && capabilities.records) || [];

      function numText(v) {
        return v === null || v === undefined || v === "" ? "" : String(v);
      }
      function parseNum(s) {
        if (s === "") return null;
        var n = parseInt(s, 10);
        return isNaN(n) ? null : n;
      }

      var isEn = copy.nav !== "运行模式与团队路由";

      function refsOfHub(route) {
        var key = routeKeyOf(route);
        var out = [];
        (roles || []).forEach(function (role) {
          TIERS.forEach(function (tier) {
            var r = role[tier];
            if (r && routeKeyOf(r) === key) out.push({ roleName: role.name, roleId: role.id, tier: tier });
          });
          var pairings = role.pairings || [];
          pairings.forEach(function (p) {
            if (p.reviewer && routeKeyOf(p.reviewer) === key) out.push({ roleName: role.name, roleId: role.id, tier: null });
          });
        });
        return out;
      }

      function addAuthModel() {
        var route = parseRouteKey(pickAuth);
        if (!route) return;
        var exists = authorized.some(function (row) {
          return row.provider === route.provider && row.model === route.model;
        });
        if (exists) return;
        setAuthDraft(authorized.concat([route]));
        setPickAuth("");
        setAuthBlocked("");
      }

      function revokeAuthModel(route) {
        var refs = refsOfHub(route);
        if (refs.length > 0) {
          setAuthBlocked(
            copy.revokeBlocked
              .replace("{n}", String(refs.length))
              .replace(
                "{list}",
                refs
                  .map(function (row) {
                    return row.roleName + (row.tier ? " · " + tierLabel(copy, row.tier) : "");
                  })
                  .join("、"),
              ),
          );
          return;
        }
        setAuthBlocked("");
        setAuthDraft(
          authorized.filter(function (row) {
            return !(row.provider === route.provider && row.model === route.model);
          }),
        );
      }

      function restoreAuthorized() {
        var defs = modes && modes.recommendedAuthorizedModels;
        if (!defs || !defs.length) {
          setStatusMsg("err", copy.restorePresetMissing);
          return;
        }
        if (!window.confirm(copy.restoreAuthorizedConfirm.replace("{count}", String(defs.length)))) return;
        setAuthDraft(defs.map(function (r) {
          return { provider: r.provider, model: r.model };
        }));
        setAuthBlocked("");
        setStatusMsg("ok", copy.restoreAuthorizedDone.replace("{count}", String(defs.length)));
      }

      function toggleRole(roleId, enabled) {
        updateDraft(selected, function (d) {
          d.roles = (d.roles || []).map(function (r) {
            if (r.id !== roleId) return r;
            var nr = clone(r);
            nr.enabled = enabled;
            return nr;
          });
          return d;
        });
      }

      function removeRole(roleId) {
        var role = (roles || []).find(function (r) { return r.id === roleId; });
        if (!role) return;
        var name = role.name || role.id;
        if (!window.confirm(copy.deleteRoleConfirm.replace("{name}", name))) return;
        updateDraft(selected, function (d) {
          d.roles = (d.roles || []).filter(function (r) { return r.id !== roleId; });
          return d;
        });
      }

      function addRole() {
        var maxN = 0;
        (roles || []).forEach(function (r) {
          var m = /^custom-(\d+)$/.exec(r.id || "");
          if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
        });
        var id = "custom-" + (maxN + 1);
        updateDraft(selected, function (d) {
          d.roles = (d.roles || []).concat([
            {
              id: id,
              name: copy.newRoleName,
              kind: "standard",
              enabled: true,
              primary: null,
              backup: null,
              upgrade: null,
              switchRule: "confirm",
            },
          ]);
          return d;
        });
      }

      function collectRoutesOfMode(mode, out) {
        function push(rt) {
          if (rt && rt.provider && rt.model) out.push({ provider: rt.provider, model: rt.model });
        }
        push(mode.lead);
        if (mode.upgradeAdvisor) push(mode.upgradeAdvisor);
        var tm = mode.team || {};
        TEAM_KINDS.forEach(function (k) { push(tm[k]); });
        (mode.roles || []).forEach(function (role) {
          TIERS.forEach(function (t) { push(role[t]); });
          (role.pairings || []).forEach(function (p) { push(p.reviewer); });
        });
      }

      function aiOptionsList() {
        var labels = {};
        (catalog || []).forEach(function (p) {
          (p.models || []).forEach(function (m) {
            labels[routeKeyOf({ provider: p.id, model: m.id })] = (m.name || m.id) + " · " + p.id + "/" + m.id;
          });
        });
        return authorized.map(function (a) {
          var key = routeKeyOf(a);
          return { value: key, label: labels[key] || routeText(a) };
        });
      }

      function applyConfigureResult(result, snapshotDrafts, snapshotAuth) {
        var d = result;
        var merged = {};
        var failedResults = [];
        (d.results || []).forEach(function (res) {
          if (res && res.ok && res.mode && res.modeId) merged[res.modeId] = res.mode;
          else if (res) failedResults.push(res);
        });
        setDrafts(function (prev) {
          var next = {};
          Object.keys(prev).forEach(function (k) { next[k] = prev[k]; });
          Object.keys(merged).forEach(function (k) {
            var unchanged = JSON.stringify(prev[k]) === JSON.stringify(snapshotDrafts[k]);
            if (unchanged) next[k] = clone(merged[k]);
          });
          return next;
        });
        // Union newly-referenced routes into authDraft FUNCTIONALLY so any
        // authorization edit made during the request is preserved.
        var referenced = [];
        Object.keys(merged).forEach(function (k) { collectRoutesOfMode(merged[k], referenced); });
        var added = 0;
        referenced.forEach(function (rt) {
          var exists = snapshotAuth.some(function (a) { return a.provider === rt.provider && a.model === rt.model; });
          if (!exists) added++;
        });
        setAuthDraft(function (prevAuth) {
          var base = Array.isArray(prevAuth) ? prevAuth : [];
          var out = base.slice();
          referenced.forEach(function (rt) {
            var exists = out.some(function (a) { return a.provider === rt.provider && a.model === rt.model; });
            if (!exists) out.push({ provider: rt.provider, model: rt.model });
          });
          return out;
        });
        // Detect modes edited while the request was in flight (via the live
        // ref) so the warning is accurate even if the closure value is stale.
        var latestDrafts = draftsRef.current || {};
        var skipped = Object.keys(merged).filter(function (k) {
          return JSON.stringify(latestDrafts[k]) !== JSON.stringify(snapshotDrafts[k]);
        });
        setAiConfigResult({ results: d.results || [], newAuthCount: added, skipped: skipped });
        if (skipped.length > 0) {
          setStatusMsg("warn", copy.aiSkippedEdited + " " + skipped.map(function (k) { return modeLabel(k); }).join("、"));
        } else if (failedResults.length > 0) {
          setStatusMsg("warn", copy.aiSaveAllPartial + "（" + failedResults.length + "）");
        } else {
          setStatusMsg("ok", copy.aiConfigureDone);
        }
      }

      function applyRecommendResult(d) {
        setAiRecommendResult(d);
        var failed = (d.results || []).filter(function (mr) { return !mr.ok; });
        if (failed.length === 0) {
          setStatusMsg("ok", copy.aiRecommendDone);
        } else {
          var names = failed.map(function (mr) { return modeLabel(mr.modeId) + (mr.error ? "（" + mr.error + "）" : ""); }).join("、");
          setStatusMsg(failed.length === (d.results || []).length ? "err" : "warn", copy.aiRecommendPartial + " " + names);
        }
      }

      function pollAiJob(jobId) {
        return new Promise(function (resolve, reject) {
          var intervalMs = 1000;
          var deadline = Date.now() + 480000;
          var consecutiveFailures = 0;
          var timer = null;
          function stop() {
            if (timer !== null) { clearTimeout(timer); timer = null; }
          }
          function fail(kind, message, backendErr) {
            stop();
            reject({ kind: kind, message: message, backendErr: backendErr, jobId: jobId });
          }
          function succeed(result) {
            stop();
            resolve(result);
          }
          function tick() {
            if (Date.now() > deadline) {
              fail("timeout", jobId, null);
              return;
            }
            requestJson(AI_JOBS_PATH + "?id=" + encodeURIComponent(jobId), { method: "GET" })
              .then(function (r) {
                var d = r && r.data;
                if (r && r.status === 404) {
                  fail("gone", (d && d.message) || "", (d && d.error) || "job-not-found");
                  return;
                }
                if (r && r.ok && d && d.ok && d.job) {
                  consecutiveFailures = 0;
                  var job = d.job;
                  if (job.status === "succeeded") { succeed(job.result); return; }
                  if (job.status === "failed") { fail(job.kind || "unknown", job.error || "", null); return; }
                  timer = setTimeout(tick, intervalMs);
                  return;
                }
                if (r && (r.status === 502 || r.status === 503 || r.status === 504)) {
                  consecutiveFailures += 1;
                  if (consecutiveFailures >= 5) { fail("http", (d && d.message) || "", (d && d.error) || "poll-http-error"); return; }
                  timer = setTimeout(tick, intervalMs);
                  return;
                }
                var httpKind;
                var httpMessage;
                var backendErr;
                if (r && r.parseError) {
                  httpKind = "json";
                  httpMessage = clientFormatError(r.parseError);
                  backendErr = copy.aiJsonError;
                } else {
                  httpKind = (d && d.kind) || "http";
                  httpMessage = (d && d.message) || "";
                  backendErr = (d && d.error) || "";
                }
                fail(httpKind, httpMessage, backendErr);
              })
              .catch(function (e) {
                consecutiveFailures += 1;
                if (consecutiveFailures >= 5) {
                  var kind = (e && e.kind) || fetchErrorKind(e);
                  var rawCause = (e && e.cause) || e;
                  fail(kind, clientFormatError(rawCause), null);
                  return;
                }
                timer = setTimeout(tick, intervalMs);
              });
          }
          tick();
        });
      }

      function runAiConfigure() {
        if (!pickConfigureModel || aiBusy) return;
        var route = parseRouteKey(pickConfigureModel);
        if (!route) return;
        setAiBusy(true);
        setAiConfigResult(null);
        setStatus("");
        // Snapshot drafts/auth at request start. The response must only apply to
        // modes still identical to the snapshot, so an edit made while the AI
        // job is running is never silently overwritten.
        var snapshotDrafts = clone(drafts);
        var snapshotAuth = authorized.slice();
        requestJson(AI_JOBS_PATH, { method: "POST", body: { operation: "configure", provider: route.provider, model: route.model } })
          .then(function (r) {
            var d = r && r.data;
            if (r && r.ok && d && d.ok && d.jobId) {
              return pollAiJob(d.jobId);
            }
            if (r && r.parseError) {
              throw { kind: "json", message: clientFormatError(r.parseError), backendErr: copy.aiJsonError };
            }
            var httpKind = (d && d.kind) || "http";
            var httpMessage = (d && d.message) || "";
            var backendErr = (d && d.error) || "";
            throw { kind: httpKind, message: httpMessage, backendErr: backendErr };
          })
          .then(function (result) {
            if (result === null || result === undefined) throw { kind: "unknown", message: "", backendErr: copy.aiError };
            applyConfigureResult(result, snapshotDrafts, snapshotAuth);
          })
          .catch(function (e) {
            var kind = (e && e.kind) || fetchErrorKind(e);
            if (kind === "no-response") {
              var noRespCause = (e && e.cause) ? clientFormatError(e.cause) : ((e && e.message) || "");
              setAiConfigResult({ results: [], newAuthCount: 0, error: copy.aiNoResponse + (noRespCause ? "：" + noRespCause : "") });
              setStatusMsg("err", aiFailureMessage("no-response", noRespCause, null));
              return;
            }
            if (kind === "timeout") {
              setAiConfigResult({ results: [], newAuthCount: 0, error: copy.aiJobTimeout + "（" + (e && e.jobId) + "）" });
              setStatusMsg("err", copy.aiJobStillRunning + "（" + copy.aiJobTimeout + " " + (e && e.jobId) + "）");
              return;
            }
            if (kind === "gone") {
              setAiConfigResult({ results: [], newAuthCount: 0, error: copy.aiJobGone });
              setStatusMsg("err", copy.aiJobGone);
              return;
            }
            var message = (e && e.message) || clientFormatError(e);
            var backendErr = (e && e.backendErr) || null;
            setAiConfigResult({ results: [], newAuthCount: 0, error: backendErr || message || copy.aiError });
            setStatusMsg("err", aiFailureMessage(kind, message, backendErr));
          })
          .then(function () { setAiBusy(false); });
      }

      function runAiRecommend() {
        if (!pickRecommendModel || aiBusy) return;
        var route = parseRouteKey(pickRecommendModel);
        if (!route) return;
        setAiBusy(true);
        setAiRecommendResult(null);
        setStatus("");
        requestJson(AI_JOBS_PATH, { method: "POST", body: { operation: "recommend", provider: route.provider, model: route.model } })
          .then(function (r) {
            var d = r && r.data;
            if (r && r.ok && d && d.ok && d.jobId) {
              return pollAiJob(d.jobId);
            }
            if (r && r.parseError) {
              throw { kind: "json", message: clientFormatError(r.parseError), backendErr: copy.aiJsonError };
            }
            var httpKind = (d && d.kind) || "http";
            var httpMessage = (d && d.message) || "";
            var backendErr = (d && d.error) || "";
            throw { kind: httpKind, message: httpMessage, backendErr: backendErr };
          })
          .then(function (result) {
            if (result === null || result === undefined) throw { kind: "unknown", message: "", backendErr: copy.aiError };
            applyRecommendResult(result);
          })
          .catch(function (e) {
            var kind = (e && e.kind) || fetchErrorKind(e);
            if (kind === "no-response") {
              var noRespCause = (e && e.cause) ? clientFormatError(e.cause) : ((e && e.message) || "");
              setAiRecommendResult({ results: [], error: copy.aiNoResponse + (noRespCause ? "：" + noRespCause : "") });
              setStatusMsg("err", aiFailureMessage("no-response", noRespCause, null));
              return;
            }
            if (kind === "timeout") {
              setAiRecommendResult({ results: [], error: copy.aiJobTimeout + "（" + (e && e.jobId) + "）" });
              setStatusMsg("err", copy.aiJobStillRunning + "（" + copy.aiJobTimeout + " " + (e && e.jobId) + "）");
              return;
            }
            if (kind === "gone") {
              setAiRecommendResult({ results: [], error: copy.aiJobGone });
              setStatusMsg("err", copy.aiJobGone);
              return;
            }
            var message = (e && e.message) || clientFormatError(e);
            var backendErr = (e && e.backendErr) || null;
            setAiRecommendResult({ results: [], error: backendErr || message || copy.aiError });
            setStatusMsg("err", aiFailureMessage(kind, message, backendErr));
          })
          .then(function () { setAiBusy(false); });
      }

      function saveAllDrafts() {
        if (saving) return;
        setSaving(true);
        setStatus("");
        (async function () {
          var failures = 0;
          for (var i = 0; i < dirtyModeIds.length; i++) {
            var id = dirtyModeIds[i];
            var s = storedModes[id];
            var expectedRevision = s && typeof s.revision === "number" ? s.revision : null;
            var body = { modeId: id, mode: drafts[id] };
            if (expectedRevision !== null) body.expectedRevision = expectedRevision;
            try {
              var r = await requestJson(MODE_SAVE_PATH, { method: "POST", body: body });
              var d = r && r.data;
              if (r && r.ok && d && d.ok) {
                setModes(function (prev) {
                  if (!prev) return prev;
                  var next = clone(prev);
                  if (!next.modes) next.modes = {};
                  next.modes[id] = d.mode;
                  return next;
                });
                setDrafts(function (prev) {
                  var next = {};
                  Object.keys(prev).forEach(function (k) { next[k] = k === id ? clone(d.mode) : prev[k]; });
                  return next;
                });
              } else if (r && r.status === 409) {
                failures++;
                refreshStoredModes();
              } else {
                failures++;
              }
            } catch (e) {
              failures++;
            }
          }
          var currentId = modes && modes.currentModeId;
          // The global role store must be synced when authorizations changed, a
          // global sync is already pending, OR the CURRENT mode is itself dirty
          // (its roles are the live global set — a role-only current-mode change
          // must still reach /roles/save).
          var syncGlobal = authDirty || pendingGlobal || (currentId && dirtyModeIds.indexOf(currentId) >= 0);
          if (syncGlobal) {
            if (globalEnabled === null || globalRevision === null) {
              setPendingGlobal(true);
              failures++;
              setStatusMsg("err", copy.globalLoadFailed);
            } else {
              var globalRoles = (currentId && drafts[currentId] && drafts[currentId].roles) ||
                (currentId && storedModes[currentId] && storedModes[currentId].roles) || [];
              var rolesBody = {
                enabled: globalEnabled === true,
                roles: globalRoles,
                authorizedModels: authorized,
                skipValidation: true,
                expectedRevision: globalRevision,
              };
              try {
                var rr = await requestJson(SAVE_PATH, { method: "POST", body: rolesBody });
                var rd = rr && rr.data;
                if (rr && rr.ok && rd && rd.ok) {
                  setModes(function (prev) {
                    if (!prev) return prev;
                    var next = clone(prev);
                    next.authorizedModels = clone(authorized);
                    return next;
                  });
                  setAuthDraft(clone(authorized));
                  if (typeof rd.revision === "number") setGlobalRevision(rd.revision);
                  setPendingGlobal(false);
                } else if (rr && rr.status === 409) {
                  setPendingGlobal(true);
                  reloadGlobal();
                  failures++;
                } else {
                  setPendingGlobal(true);
                  failures++;
                }
              } catch (e) {
                setPendingGlobal(true);
                failures++;
              }
            }
          }
          setSaving(false);
          if (failures > 0) {
            setStatusMsg("warn", copy.aiSaveAllPartial + "（" + failures + "）");
          } else {
            setStatusMsg("ok", copy.aiSaveAllDone);
          }
        })();
      }

      function toggleHistory() {
        setHistoryOpen(function (v) { return !v; });
      }

      function renderTierBadges() {
        var byTier = {};
        TIER_ORDER.forEach(function (t) { byTier[t] = []; });
        authorized.forEach(function (a) {
          if (a && a.provider) {
            var t = routeTierId(a, tiers);
            if (byTier[t] && byTier[t].indexOf(a.model) < 0) byTier[t].push(a.model);
          }
        });
        return h("div", { className: "mrs-tierlegend" },
          TIER_ORDER.map(function (t) {
            return h("span", { className: "mrs-tierbadge", key: t },
              tierLabelOf(t, copy) + (byTier[t].length ? " · " + byTier[t].join(", ") : " · —")
            );
          })
        );
      }

      function renderAuthorizedList() {
        if (!authorized.length) return h("p", { className: "mrs-hint" }, copy.authorizedEmptyTab);
        return h("div", { className: "mrs-capgrid" },
          h("div", { className: "mrs-caprow mrs-caprow--head" },
            h("span", { className: "mrs-caprow__test" }, copy.testConnection),
            h("span", { className: "mrs-caprow__model" }, copy.authorizedTitle),
            h("span", { className: "mrs-caprow__tier" }, copy.tierTitle),
            h("span", { className: "mrs-caprow__cache" }, copy.capCacheStatus),
            h("span", { className: "mrs-caprow__efforts" }, copy.capEfforts),
            h("span", { className: "mrs-caprow__refs" }, copy.referencedBy),
            h("span", { className: "mrs-caprow__act" })
          ),
          authorized.map(function (a) {
            var key = routeKeyOf(a);
            var rec = capMap[key];
            var res = validateResults[key];
            var eff = capEffective(rec);
            var dotClass = res ? (res.ok ? "mrs-dot mrs-dot--ok" : "mrs-dot mrs-dot--bad") : "mrs-dot";
            var dotLabel = res ? (res.ok ? copy.testPass : copy.testFail) : copy.notTested;
            var effortsText;
            if (!rec) {
              effortsText = copy.capEffortsDefault;
            } else if (!rec.efforts || rec.efforts.length === 0) {
              effortsText = copy.capEffortsOff;
            } else {
              var ids = rec.efforts.map(function (e) { return e.id; }).join(", ");
              effortsText = rec.defaultEffort ? ids + " (" + copy.capEffortsDefault + ": " + rec.defaultEffort + ")" : ids;
            }
            var refs = refsOfHub(a);
            return h("div", { className: "mrs-caprow", key: key },
              h("span", { className: "mrs-caprow__test" },
                h("span", { className: dotClass, title: res && res.error ? res.error : "" }),
                h("span", { className: "mrs-hint" }, dotLabel)),
              h("span", { className: "mrs-caprow__model" }, routeText(a)),
              h("span", { className: "mrs-caprow__tier" }, h("span", { className: "mrs-badge" }, tierLabelOf(routeTierId(a, tiers), copy))),
              h("span", { className: "mrs-caprow__cache" },
                h("span", { className: capDotClass(eff) }),
                h("span", { className: "mrs-hint" }, capabilityStatus(eff, copy))),
              h("span", { className: "mrs-caprow__efforts" }, effortsText),
              h("span", { className: "mrs-caprow__refs" }, h("span", { className: refs.length ? "mrs-badge mrs-badge--warn" : "mrs-hint" }, refsText(copy, refs))),
              h("span", { className: "mrs-caprow__act" },
                h("button", { type: "button", className: "mrs-btn mrs-btn--ghost", onClick: function () { revokeAuthModel(a); } }, copy.revoke))
            );
          })
        );
      }

      function renderChangelog() {
        var versions = (releaseNotes && releaseNotes.versions) || [];
        if (releaseNotesFailed) {
          return h("div", { className: "mrs-mchangelog" },
            h("div", { className: "mrs-card__title" }, copy.changelogTitle),
            h("p", { className: "mrs-err" }, copy.releaseNotesFailed)
          );
        }
        if (!releaseNotes) {
          return h("div", { className: "mrs-mchangelog" },
            h("div", { className: "mrs-card__title" }, copy.changelogTitle),
            h("p", { className: "mrs-hint" }, copy.loading)
          );
        }
        function renderVersion(v) {
          var open = !!openVersions[v.version];
          var title = (v.title && (isEn ? v.title.en : v.title.zh)) || v.version;
          return h("div", { className: "mrs-mver", key: v.version },
            h("button", { type: "button", className: "mrs-mver__head", onClick: function () { toggleVersion(v.version); } },
              h("span", null, (v.version || "") + (v.date ? " · " + v.date : "")),
              h("span", { className: "mrs-hint" }, open ? "▾" : "▸")
            ),
            open ? h("div", { className: "mrs-mver__body" },
              title ? h("div", { className: "mrs-mver__sectitle" }, title) : null,
              (v.sections || []).map(function (sec, si) {
                return h("div", { className: "mrs-mver__sec", key: si },
                  h("div", { className: "mrs-mver__sectitle" }, (sec.title && (isEn ? sec.title.en : sec.title.zh)) || ""),
                  h("ul", null, ((sec.items && (isEn ? sec.items.en : sec.items.zh)) || []).map(function (it, ii) {
                    return h("li", { key: ii }, it);
                  })),
                  sec.files && sec.files.length ? h("div", { className: "mrs-hint" }, copy.releaseFiles + "：" + sec.files.join(", ")) : null
                );
              }),
              v.files && v.files.length ? h("div", { className: "mrs-hint" }, copy.releaseFiles + "：" + v.files.join(", ")) : null
            ) : null
          );
        }
        var currentVersion = releaseNotes.currentVersion || (versions[0] && versions[0].version) || "";
        var latest = versions.slice(0, 2);
        var history = versions.slice(2);
        return h("div", { className: "mrs-mchangelog" },
          h("div", { className: "mrs-card__title" }, copy.changelogTitle),
          currentVersion ? h("p", { className: "mrs-hint" }, copy.versionCurrent + "：" + currentVersion) : null,
          latest.map(renderVersion),
          history.length ? h("div", { className: "mrs-mver__history" },
            h("button", { type: "button", className: "mrs-mver__head", onClick: toggleHistory },
              h("span", null, copy.releaseHistory + "（" + history.length + "）"),
              h("span", { className: "mrs-hint" }, historyOpen ? "▾" : "▸")
            ),
            historyOpen ? history.map(renderVersion) : null
          ) : null
        );
      }

      function renderFoot() {
        return h("div", { className: "mrs-mbody" },
          h("div", { className: "mrs-mgroup" },
            h("h4", null, copy.recentDispatches),
            h("p", { className: "mrs-hint" }, copy.recentEmpty)
          ),
          h("div", { className: "mrs-mgroup" },
            h("h4", null, copy.advanced),
            modes && modes.file ? h("p", { className: "mrs-hint" }, modes.file) : null,
            h("p", { className: "mrs-hint" }, copy.wiringScopeNote)
          ),
          renderChangelog()
        );
      }

      function renderTeamTab() {
        return h("div", { className: "mrs-mbody" },
          h("div", { className: "mrs-mgroup" },
            h("h4", null, copy.leadTitle),
            h(ReasonedRouteEditor, {
              copy: copy, label: copy.leadLabel, value: currentDraft.lead, authorized: authorized, capMap: capMap,
              onChange: function (v) { updateDraft(selected, function (d) { d.lead = v; return d; }); },
            })
          ),
          h("div", { className: "mrs-mgroup" },
            h("h4", null, copy.dispatchTitle),
            h("div", { className: "mrs-mgrid" },
              h("label", { className: "mrs-field" },
                h("span", { className: "mrs-field__label" }, copy.teamConcurrency),
                h("input", { className: "mrs-input", type: "number", min: "1", value: numText(team.maxConcurrentWorkers), onChange: function (e) { patchTeam(function (t) { t.maxConcurrentWorkers = parseNum(e.target.value); }); } }),
                h("span", { className: "mrs-hint" }, copy.teamConcurrencyHint))
            ),
            h("label", { className: "mrs-check" },
              h("input", { type: "checkbox", checked: !!(targets.native && targets.native.enabled), onChange: function (e) { patchTargets(function (t) { t.native = t.native || {}; t.native.enabled = e.target.checked; }); } }),
              copy.targetNative),
            h("p", { className: "mrs-hint" }, copy.nativeScopeNote)
          )
        );
      }

      function renderAiConfigResult() {
        if (!aiConfigResult) return null;
        if (aiConfigResult.error) return h("p", { className: "mrs-err" }, aiConfigResult.error);
        return h("div", { className: "mrs-airesult" },
          h("div", { className: "mrs-card__title" }, copy.aiResultTitle),
          aiConfigResult.newAuthCount ? h("p", { className: "mrs-hint" }, copy.aiNewAuth + "：" + aiConfigResult.newAuthCount) : null,
          (aiConfigResult.results || []).map(function (mr, i) {
            return h("div", { className: "mrs-airesult__row", key: i },
              h("span", { className: "mrs-airesult__mode" }, modeLabel(mr.modeId)),
              mr.ok ? h("span", { className: "mrs-airesult__ok" }, copy.aiModeOk)
                : h("span", { className: "mrs-airesult__fail" }, copy.aiModeFail + (mr.error ? "：" + mr.error : "")),
              (mr.warnings && mr.warnings.length) ? h("span", { className: "mrs-aiwarn" }, copy.aiWarnings + "：" + mr.warnings.join("；")) : null
            );
          })
        );
      }

      function renderAiRecommendResult() {
        if (!aiRecommendResult) return null;
        if (aiRecommendResult.error) return h("p", { className: "mrs-err" }, aiRecommendResult.error);
        return h("div", { className: "mrs-recgroup" },
          h("p", { className: "mrs-hint" }, copy.aiRecommendNote),
          (aiRecommendResult.results || []).map(function (mr, i) {
            return h("div", { className: "mrs-recgroup", key: i },
              h("div", { className: "mrs-card__title" }, modeLabel(mr.modeId)),
              !mr.ok ? h("p", { className: "mrs-err" }, copy.aiModeFail + "：" + (mr.error || copy.aiError)) : (!mr.roles || !mr.roles.length) ? h("p", { className: "mrs-hint" }, copy.aiRecommendEmpty) : mr.roles.map(function (role, j) {
                var cands = role.candidates || [];
                return h("div", { className: "mrs-reccand", key: j },
                  h("div", { className: "mrs-reccand__model" }, role.name || role.id),
                  cands.length === 0 ? h("div", { className: "mrs-hint" }, copy.aiNone) : cands.map(function (c, k) {
                    return h("div", { className: "mrs-reccand", key: k },
                      h("div", { className: "mrs-reccand__model" }, c.provider + " / " + c.model),
                      h("div", { className: "mrs-reccand__meta" },
                        h("span", { className: "mrs-badge" }, c.source === "local-catalog" ? copy.aiSourceLocal : copy.aiSourceMarket),
                        c.availableLocally ? h("span", { className: "mrs-badge mrs-badge--warn" }, copy.aiAvailableLocal) : null
                      ),
                      c.reason ? h("div", { className: "mrs-hint" }, copy.aiReason + "：" + c.reason) : null,
                      c.strengths ? h("div", { className: "mrs-hint" }, copy.aiStrength + "：" + c.strengths) : null,
                      c.cautions ? h("div", { className: "mrs-hint" }, copy.aiCaution + "：" + c.cautions) : null
                    );
                  })
                );
              })
            );
          })
        );
      }

      function renderModelsTab() {
        return h("div", { className: "mrs-mbody" },
          h("div", { className: "mrs-mgroup" },
            h("div", { className: "mrs-card__title" }, copy.aiTitle),
            h("div", { className: "mrs-aicards" },
              h("div", { className: "mrs-aicard" },
                h("div", { className: "mrs-aicard__title" }, copy.aiConfigureTitle),
                h("div", { className: "mrs-aicard__desc" }, copy.aiConfigureDesc),
                h("select", { className: "mrs-select", value: pickConfigureModel, onChange: function (e) { setPickConfigureModel(e.target.value); } },
                  h("option", { value: "" }, copy.unset),
                  aiOptionsList().map(function (opt) {
                    return h("option", { key: opt.value, value: opt.value }, opt.label);
                  })
                ),
                h("button", { type: "button", className: "mrs-btn mrs-btn--primary", onClick: runAiConfigure, disabled: !pickConfigureModel || aiBusy }, aiBusy ? copy.aiBusy : copy.aiConfigureButton),
                h("div", { className: "mrs-hint" }, copy.aiPaidHint)
              ),
              h("div", { className: "mrs-aicard" },
                h("div", { className: "mrs-aicard__title" }, copy.aiRecommendTitle),
                h("div", { className: "mrs-aicard__desc" }, copy.aiRecommendDesc),
                h("select", { className: "mrs-select", value: pickRecommendModel, onChange: function (e) { setPickRecommendModel(e.target.value); } },
                  h("option", { value: "" }, copy.unset),
                  aiOptionsList().map(function (opt) {
                    return h("option", { key: opt.value, value: opt.value }, opt.label);
                  })
                ),
                h("button", { type: "button", className: "mrs-btn mrs-btn--primary", onClick: runAiRecommend, disabled: !pickRecommendModel || aiBusy }, aiBusy ? copy.aiBusy : copy.aiRecommendButton),
                h("div", { className: "mrs-hint" }, copy.aiPaidHint)
              )
            ),
            h("button", { type: "button", className: "mrs-btn", onClick: saveAllDrafts, disabled: saveAllCount === 0 || saving }, copy.aiSaveAll + "(" + saveAllCount + ")"),
            renderAiConfigResult(),
            renderAiRecommendResult()
          ),
          h("div", { className: "mrs-mgroup" },
            h("div", { className: "mrs-mactions" },
              h("button", { type: "button", className: "mrs-btn mrs-btn--primary", onClick: testConnections, disabled: testRunning }, testRunning ? copy.capRefreshing : copy.testConnection),
              h("button", { type: "button", className: "mrs-btn mrs-btn--ghost", onClick: refreshCaps, disabled: refreshing }, copy.capRefresh),
              h("button", { type: "button", className: "mrs-btn mrs-btn--ghost", onClick: refreshTiers, disabled: refreshingTiers }, copy.refreshTiers)
            ),
            h("p", { className: "mrs-hint" }, copy.testConnectionHint),
            tiersFailed ? h("p", { className: "mrs-hint" }, copy.tiersFallbackNote) : null,
            h("div", { className: "mrs-card__title" }, copy.tierTitle),
            h("p", { className: "mrs-hint" }, copy.tierHint),
            renderTierBadges(),
            h("div", { className: "mrs-card__title" }, copy.authorizedTitle),
            h("p", { className: "mrs-hint" }, copy.authorizedTabHint),
            renderAuthorizedList(),
            h("div", { className: "mrs-btnrow" },
              h("select", { className: "mrs-select", style: { maxWidth: "320px" }, value: pickAuth, onChange: function (e) { setPickAuth(e.target.value); } },
                h("option", { value: "" }, copy.unset),
                catalogOptions(catalog, authorized).map(function (opt) {
                  return h("option", { key: opt.value, value: opt.value }, opt.label);
                })
              ),
              h("button", { type: "button", className: "mrs-btn", onClick: addAuthModel, disabled: pickAuth === "" }, copy.addAuthorized),
              h("button", { type: "button", className: "mrs-btn mrs-btn--ghost", onClick: restoreAuthorized }, copy.restoreAuthorized)
            ),
            authBlocked ? h("p", { className: "mrs-err" }, authBlocked) : null
          )
        );
      }

      function renderRolesTab() {
        return h("div", { className: "mrs-mbody" },
          h("div", { className: "mrs-mgroup" },
            h("h4", null, copy.rolesTitle),
            h("p", { className: "mrs-hint" }, copy.rolesHint),
            h("div", { className: "mrs-btnrow" },
              h("button", { type: "button", className: "mrs-btn", onClick: addRole }, copy.addRole)
            ),
            roles.map(function (role) {
              return h(ModeRoleCard, {
                key: role.id || role.name || Math.random().toString(36).slice(2),
                copy: copy, role: role, authorized: authorized, capMap: capMap,
                onPatch: function (fn) {
                  updateDraft(selected, function (d) {
                    d.roles = (d.roles || []).map(function (r) {
                      return r.id === role.id ? fn(clone(r)) : r;
                    });
                    return d;
                  });
                },
                onToggle: function (en) { toggleRole(role.id, en); },
                onRemove: function () { removeRole(role.id); }
              });
            })
          ),
          h("details", { className: "mrs-details" },
            h("summary", null, copy.teamOverrideTitle),
            h("div", { className: "mrs-details__body" },
              h("p", { className: "mrs-hint" }, copy.teamOverrideHint),
              TEAM_KINDS.map(function (k) {
                return h(ReasonedRouteEditor, {
                  key: k,
                  copy: copy, label: copy[TEAM_LABELS[k]], value: team[k], authorized: authorized, capMap: capMap,
                  onChange: function (v) { patchTeam(function (t) { t[k] = v; }); },
                });
              })
            )
          ),
          h("details", { className: "mrs-details" },
            h("summary", null, copy.advisorGroupTitle),
            h("div", { className: "mrs-details__body" },
              h("p", { className: "mrs-hint" }, copy.advisorGroupHint),
              h("label", { className: "mrs-check" },
                h("input", { type: "checkbox", checked: currentDraft.upgradeAdvisor ? currentDraft.upgradeAdvisor.enabled !== false : true, onChange: function (e) { updateDraft(selected, function (d) { d.upgradeAdvisor = d.upgradeAdvisor || {}; d.upgradeAdvisor.enabled = e.target.checked; return d; }); } }),
                copy.advisorEnabled),
              h("label", { className: "mrs-field" },
                h("span", { className: "mrs-field__label" }, copy.advisorCondition),
                h("input", { className: "mrs-input", type: "text", value: advisorConditionText(currentDraft.upgradeAdvisor && currentDraft.upgradeAdvisor.condition), onChange: function (e) { updateDraft(selected, function (d) { d.upgradeAdvisor = d.upgradeAdvisor || {}; d.upgradeAdvisor.condition = e.target.value; return d; }); } })
              ),
              h(ReasonedRouteEditor, {
                copy: copy, label: copy.advisorLabel, value: currentDraft.upgradeAdvisor, authorized: authorized, capMap: capMap,
                onChange: patchAdvisor,
              })
            )
          )
        );
      }

      return h("div", { className: "mrs-mmodes" + (saving ? " mrs-mmodes--saving" : "") },
        h("div", { className: "mrs-mhead" },
          h("h3", { className: "mrs-card__title" }, copy.runModeTitle),
          h("p", { className: "mrs-hint" }, copy.runModeSubtitle),
          modes && modes.persistent === false ? h("p", { className: "mrs-warn" }, copy.capNotPersistent) : null,
          loadError ? h("p", { className: "mrs-err" }, loadError) : null,
          capFailed ? h("p", { className: "mrs-warn" }, capFailed) : null
        ),
        modes
          ? h("div", { className: "mrs-mbar" },
              MODE_IDS.map(function (id) {
                var m = storedModes[id];
                var label = modeLabel(id);
                var isSel = id === selected;
                var isCur = modes.currentModeId === id;
                var d = drafts[id];
                var isDirty = d && m && JSON.stringify(d) !== JSON.stringify(m);
                return h("button", {
                  type: "button",
                  key: id,
                  className: "mrs-mtab" + (isSel ? " mrs-mtab--active" : ""),
                  onClick: function () { selectMode(id); },
                },
                  h("span", null, label),
                  isCur ? h("span", { className: "mrs-mdot--current" }, "● " + copy.modeCurrentShort) : null,
                  isDirty ? h("span", { className: "mrs-mdot--dirty" }, "● " + copy.modeDirtyShort) : null
                );
              })
            )
          : h("p", { className: "mrs-hint" }, copy.loading),
        currentDraft && stored ? h("div", { className: "mrs-mdesc" },
          h("span", { className: "mrs-mdesc__title" }, copy.modeDescTitle),
          h("span", { className: "mrs-mdesc__body" }, modeDescription(selected))
        ) : null,
        currentDraft ? h("div", { className: "mrs-msubtabs" },
          [copy.tabTeam, copy.tabHub, copy.tabModels].map(function (lab, i) {
            return h("button", {
              type: "button",
              key: i,
              className: "mrs-msubtab" + (activeTab === i ? " mrs-msubtab--active" : ""),
              onClick: function () { setActiveTab(i); },
            }, lab);
          })
        ) : null,
        currentDraft ? h("div", { className: "mrs-mactions" },
          h("button", { type: "button", className: "mrs-btn mrs-btn--primary", onClick: saveMode, disabled: !dirty || saving }, saving ? copy.saving : copy.saveSettings),
          h("button", { type: "button", className: "mrs-btn", onClick: saveAllDrafts, disabled: saveAllCount === 0 || saving }, copy.aiSaveAll + "(" + saveAllCount + ")"),
          h("button", { type: "button", className: "mrs-btn", onClick: enableMode, disabled: dirty || isCurrent || saving }, copy.enableMode),
          h("button", { type: "button", className: "mrs-btn mrs-btn--ghost", onClick: restorePreset }, copy.restorePreset),
          h("label", { className: "mrs-field" },
            h("span", { className: "mrs-field__label" }, copy.copyFromLabel),
            h("select", { className: "mrs-select", value: copySource, onChange: function (e) { setCopySource(e.target.value); } },
              h("option", { value: "" }, copy.unset),
              MODE_IDS.filter(function (id) { return id !== selected; }).map(function (id) {
                return h("option", { value: id, key: id }, modeLabel(id));
              })
            )),
          h("button", { type: "button", className: "mrs-btn mrs-btn--ghost", onClick: copyFrom, disabled: !copySource }, copy.copyMode)
        ) : null,
        currentDraft
          ? (activeTab === 0 ? renderTeamTab() : activeTab === 1 ? renderRolesTab() : renderModelsTab())
          : null,
        status ? h("p", { className: statusKind === "err" ? "mrs-err" : (statusKind === "warn" ? "mrs-warn" : "mrs-ok") }, status) : null,
        renderFoot()
      );
    }

    /* ---------------------------------------------------------------- *
     * Registration
     * ---------------------------------------------------------------- */

    var hostContext = null;

    function registerSlot(ctx, slotName, componentName, Component, extra) {
      try {
        ctx.slots.inject(slotName, function () {
          var definition = Object.assign(
            {
              name: componentName,
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: function () {
                return COPY[readLanguage(ctx)].nav;
              },
            },
            extra || {},
          );
          /* SlotCore.register(definition, component): the renderable is the
           * SECOND argument. Passing it inside the definition leaves the
           * entry's component undefined and React throws #130 when the
           * settings page renders the section. */
          return ctx.slots.register(definition, Component);
        });
      } catch (error) {
        console.error("[" + PACKAGE_ID + "] could not register " + slotName, error);
      }
    }

    function apply(ctx) {
      hostContext = ctx;
      installStyles();
      registerSlot(ctx, SETTINGS_SLOT, "settings.section", SettingsPage);
      registerSlot(ctx, SETTINGS_ICON_SLOT, "settings.section.icon", SettingsIcon, { label: function () { return COPY[readLanguage(ctx)].nav; } });
    }

    /** Small monogram so the settings list shows an icon for this section. */
    function SettingsIcon() {
      return h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 8, cy: 8, r: 6.2, stroke: "currentColor", strokeWidth: 1.2 }),
        h("path", { d: "M8 4.6v6.8M4.6 8h6.8", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" }),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.SettingsPage = SettingsPage;
    exports.ModesPanel = ModesPanel;
    exports.__modesHelpers = {
      COPY: COPY,
      capabilitySource: capabilitySource,
      capabilityStatus: capabilityStatus,
      capMapOf: capMapOf,
      effortOptionsOf: effortOptionsOf,
      normalizeReasonedRoute: normalizeReasonedRoute,
      reasoningPreview: reasoningPreview,
      reasoningValid: reasoningValid,
      wiringSummary: wiringSummary,
      modeRouteOptions: modeRouteOptions,
      tierOfProvider: tierOfProvider,
      tierLabelOf: tierLabelOf,
      routeTierId: routeTierId,
      versionList: versionList,
    };

    return module.exports;
  },
});

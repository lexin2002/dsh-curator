window.__ModuleLoader__.load({
	id: "dsh-curator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/* ================================================================ *
		 * i18n
		 * ================================================================ */

		const NS = "dsh-curator";
		let tr = (key) => key;

		/**
		 * curator 版 renderSlot —— 原生组件融合的核心。
		 *
		 * 原理（与官方页完全同一机制）：插件作者把 React 组件注册进全宿主共享的
		 * 槽位注册表（ctx.slots，类型为 @deepseek-ai/dsh-client-ui-slots 的 SlotCore），
		 * 官方插件页只是用 renderSlot 把它们读出来渲染 —— 注册表不是官方页私有的。
		 * curator 同样持有 ctx.slots，用同样的 key/props 读，就能渲染出与原生页
		 * 一模一样的内容（配置页、「打开 IM 机器人」类按钮、徽章）。
		 * **对新装插件自动成立**：作者注册了什么，这里就能显示什么，无需二次开发。
		 *
		 * 对齐官方调用约定（读 app.asar 的 dsh-client-ui-plugin-manager 核实）：
		 *   renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
		 *   renderSlot("plugins.detail.actions", { subject })
		 *   renderSlot("plugins.detail.badge",   { subject })
		 *   renderSlot("plugins.row.config",     { subject })  ← 行级，key 为 `bundle#rowId`
		 * 官方页把它做成 React hook 订阅变更；这里简化为「挂载时读一次 +
		 * 订阅变更重渲染」，够覆盖配置页与按钮的场景。
		 *
		 * ⚠️ locale 注入（2026-10-17 崩溃后补）：entry.options.locale 是作者注册时
		 * 声明的命名空间（如 workbuddy 的 `settings.workbuddy`）。官方的 renderSlot
		 * 会读它、用 ctx.locale.bind(ns) 生成 `t` 并**自动注入组件 props** ——
		 * workbuddy 的 WorkBuddyConfigPage({ view, t }) 没有 t 会直接 throw
		 * （"WorkBuddy plugin card requires its translation function"）。
		 * 我此前只传 view/subject，漏了这一层，整个插件页崩掉。
		 */
		function SlotRenderer(props) {
			const name = props.name;
			const injectProps = props.injectProps ?? {};
			const opts = props.opts ?? {};
			const [, bump] = react.useState(0);
			react.useEffect(() => {
				if (!hostSlots || typeof hostSlots.subscribe !== 'function') return undefined;
				// 槽位表任何变更都可能影响这一条；bump 让 React 重读
				return hostSlots.subscribe(() => bump((v) => v + 1));
			}, [name]);
			const render = () => {
				if (!hostSlots) return null;
				// 读侧用 entriesOfSlot（选举胜者，官方渲染同款语义），失败退回裸 entries
				let entries = [];
				try {
					entries = (hostSlots.entriesOfSlot ?? hostSlots.entries).call(hostSlots, name) ?? [];
				} catch {
					try { entries = hostSlots.entries(name) ?? []; } catch { return null; }
				}
				// keyed 槽位按 opts.entryKey 过滤（官方约定：key = bundle 包名）
				if (opts.entryKey) entries = entries.filter((e) => e?.options?.key === opts.entryKey);
				if (entries.length === 0) return null;
				return entries.map((entry, idx) => {
					const Comp = entry?.component ?? null;
					if (!Comp) return null;
					// 官方行为：entry 声明了 locale 命名空间 → 把该命名空间的 t 注入 props
					// （作者组件普遍解构 { t }；缺了会 throw，见上方警告）
					let merged = injectProps;
					const ns = entry?.options?.locale;
					if (ns) {
						let tFn;
						try { tFn = hostLocale?.bind(ns) ?? undefined; } catch { tFn = undefined; }
						if (tFn) merged = { ...injectProps, t: tFn };
					}
					try {
						return h('div', { key: (entry?.options?.key ?? entry?.options?.id ?? idx) + ':' + idx }, h(Comp, merged));
					} catch (e) {
						// 插件组件抛错不能拖垮整个抽屉 —— 单条隔离
						return h('div', { key: 'err' + idx, className: 'ss-slot-err' }, String(e?.message ?? e).slice(0, 200));
					}
				});
			};
			return h('div', { className: 'ss-slot-host', 'data-slot': name }, render());
		}

		/**
		 * 所有插件的运行状态：一次取回，全页共用。
		 *
		 * 原来每个徽标自己调 `listBundles()` + `listPlugins()` —— 14 行插件就是
		 * 28 次宿主 IPC，而且每次重新渲染列表都要再打一遍。现在模块级缓存 +
		 * in-flight 去重：5 秒内重复挂载不再打宿主，启停/卸载后主动失效。
		 *
		 * 相位来源与官方插件页一致：bundle.rows[].entryId → listPlugins 的
		 * fiberPhase（active/loading/failed/pending/unloading）。
		 */
		const PHASE_TTL = 5000;
		let phaseCache = { at: 0, map: new Map(), inflight: null };

		function invalidatePhases() {
			phaseCache = { at: 0, map: phaseCache.map, inflight: phaseCache.inflight };
		}

		function loadPhases() {
			if (!hostRemote || typeof hostRemote.listPlugins !== "function") return Promise.resolve(new Map());
			if (Date.now() - phaseCache.at < PHASE_TTL && phaseCache.map.size > 0) return Promise.resolve(phaseCache.map);
			if (phaseCache.inflight !== null) return phaseCache.inflight;
			const run = (async () => {
				try {
					const [bundles, plugins] = await Promise.all([hostRemote.listBundles(), hostRemote.listPlugins()]);
					const bList = bundles?.value ?? bundles ?? [];
					const pList = plugins?.value ?? plugins ?? [];
					const byEntry = new Map();
					for (const p of Array.isArray(pList) ? pList : []) if (p?.entryId !== undefined) byEntry.set(p.entryId, p);
					const map = new Map();
					for (const b of Array.isArray(bList) ? bList : []) {
						if (!b?.name) continue;
						let phase;
						let running = false;
						for (const row of b.rows ?? []) {
							const live = row?.entryId === undefined ? undefined : byEntry.get(row.entryId);
							if (live === undefined) continue;
							if (live.fiberPhase === "active") running = true;
							phase = phase ?? live.fiberPhase ?? null;
						}
						// 一个 bundle 下多个组件：只要有一个在跑就算运行中
						map.set(String(b.name), running ? "active" : phase ?? null);
					}
					phaseCache = { at: Date.now(), map, inflight: null };
					return map;
				} catch {
					// 拿不到就当作没有数据；徽标缺席好于显示假状态
					phaseCache = { at: 0, map: new Map(), inflight: null };
					return new Map();
				}
			})();
			phaseCache.inflight = run;
			return run;
		}

		/**
		 * 插件名字旁边的运行状态徽标：一个点 + 两个字。
		 * 数据来自上面那份共享缓存，不单独发请求。
		 */
		function PluginRunningBadge(props) {
			const name = props.name;
			const problem = props.runtimeError;
			const [phase, setPhase] = react.useState(() => phaseCache.map.get(name));
			react.useEffect(() => {
				let alive = true;
				loadPhases().then((map) => { if (alive) setPhase(map.get(name)); }).catch(() => {});
				return () => { alive = false; };
			}, [name]);

			// 「配置已启用、宿主没加载」：光写"已关闭"会让人以为开关坏了。
			// 宿主侧已经把原因（兼容性拒绝/加载失败）放进 runtimeError，这里优先说明它。
			const blocked = problem !== undefined && problem !== null && phase !== "active";
			const known = phase !== undefined && phase !== null;
			// 只在"有异常/有变化"时出声：
			//   运行中 = 常态，不挂徽标（每行一个绿点就是纯噪音）；
			//   已停用 = 行内已经有「已停用」文字，不再重复一遍「已关闭」；
			//   读不到运行时状态 = 不猜，宁可不显示。
			if (!blocked && (phase === "active" || !known)) return null;
			if (!blocked && phase === "off" && props.enabled === false) return null;
			const label = blocked
				? tr("pluginNotLoaded")
				: phase === "loading" ? tr("stLoading")
					: phase === "failed" ? tr("stFailed")
					: phase === "unloading" ? tr("stUnloading")
					: phase === "pending" ? tr("stPending")
					: tr("stOff");
			const tone = blocked ? "fail" : phase === "failed" ? "fail" : phase === "off" ? "off" : "run";
			return h(
				"span",
				{ className: "ss-runbadge " + tone, title: blocked ? problem.text : tr("stState") },
				h("span", { className: "ss-live-dot", "aria-hidden": "true" }),
				label,
			);
		}

		/**
		 * 配置区：只渲染作者注册的原生组件，展示方式与官方插件页完全一致。
		 *
		 * 用户明确要求：插件作者怎么开发的，官方怎么展示的，这里就怎么显示 ——
		 * 不加任何额外的东西（无兜底编辑器、无包装容器、无默认折叠）。
		 * 作者没注册配置页的插件，这里就是空的（和官方页一样），不强塞内容。
		 */
		/** 读某个槽位当前的条目（与官方 entriesOfSlot 同一约定；拿不到退回裸 entries）。 */
		function slotEntries(name, entryKey) {
			if (!hostSlots) return [];
			let entries = [];
			try {
				entries = (hostSlots.entriesOfSlot ?? hostSlots.entries).call(hostSlots, name) ?? [];
			} catch {
				try { entries = hostSlots.entries(name) ?? []; } catch { return []; }
			}
			if (entryKey) entries = entries.filter((e) => e?.options?.key === entryKey);
			return entries;
		}

		/**
		 * 槽位里有没有内容。详情页据此决定「配置」整节是否出现 ——
		 * 作者没注册配置页时渲染一个空标题，比不显示更糟：用户会以为加载失败。
		 * 订阅槽位变更，插件晚注册也能补上。
		 */
		function useSlotPresence(name, entryKey) {
			const [, bump] = react.useState(0);
			react.useEffect(() => {
				if (!hostSlots || typeof hostSlots.subscribe !== "function") return undefined;
				return hostSlots.subscribe(() => bump((v) => v + 1));
			}, [name, entryKey]);
			return slotEntries(name, entryKey).length > 0;
		}

		function PluginNativeConfigSection(props) {
			const name = props.name;
			// hooks 必须无条件调用（不能用 && 短路）
			const hasConfig = useSlotPresence("plugins.bundle.config", name);
			if (!hasConfig) return null;
			return h(
				'div',
				{ className: 'ss-slot-host' },
				h(SlotRenderer, { name: 'plugins.bundle.config', injectProps: { view: 'page' }, opts: { entryKey: name } }),
			);
		}


		const zh = {
			panelTitle: "技能中枢",
			tabHarness: "Harness 技能",
			tabAgents: "其他 Agent",
			tabPlugins: "插件",
			tabMarket: "技能市场",
			tabSettings: "设置",
			scanning: "加载中…",
			rescan: "刷新",
			filter: "筛选技能名称或描述…",
			filterPlugins: "筛选插件名称或描述…",
			skillsUnit: "个技能",
			noSkills: "没有扫到技能。到「设置」检查技能来源。",
			noMatch: "没有匹配的技能",
			clearFilter: "清除筛选",
			clearInput: "清除",
			loadFail: "加载失败",
			modelInvocable: "模型可见",
			userInvocable: "用户可调",
			// 可见性：DSH 原生 frontmatter 键（disable-model-invocation / user-invocable）
			visibilityModelHint: "关闭后模型不会自动看到这个技能（不进技能目录），用户仍可手动调用",
			visibilityUserHint: "关闭后不在列表里给用户直接调用",
			visibilityReadonlyHint: "这个来源是只读的，不能改可见性",
			visibilitySaved: "已更新",
			visibilityFail: "改可见性失败",
			// 总开关：一次关掉两个面 = 事实上的"禁用"
			disable: "禁用",
			enable: "启用",
			disabledTag: "已禁用",
			partialDisabledTag: "部分禁用",
			disableHint: "关掉后模型和你都调不到它。文件仍在原处，随时可以启用回来",
			enableHint: "启用中：模型能看到它，你也能用 / 调用它",
			partialDisableHint: "现在只关了一边，点这里会把两边都关掉",
			advancedVisibility: "高级：分别控制两个面",
			advancedVisibilityHint: "「禁用」是两边一起关。这里可以只关一边，比如留给模型、但不让用户在列表里直接调",
			visibilityModelShort: "模型侧",
			visibilityUserShort: "用户侧",
			// 注入开销已移除：只留逐字分析用的字符/词量说明（详情页不再展示数字）
			// 删除 → 回收站
			remove: "删除",
			removeConfirm: "移到回收站？之后可以随时恢复。",
			removedToTrash: "已移入回收站",
			removeHint: "移入回收站，之后可以恢复",
			// 溯源（导入台账）
			originLabel: "来源",
			originImportedAt: "导入于",
			originMarket: "技能市场",
			originAvailable: "来源仍在，可重新导入",
			originGone: "来源已不在",
			originAlsoIn: "同名来源",
			// 回收站
			tabTrash: "回收站",
			trashHint: "删掉的技能先放这里，可以恢复",
			trashEmptyTitle: "回收站是空的",
			trashEmptyDesc: "在技能库里删掉的技能会出现在这里",
			trashRestore: "恢复",
			trashPurge: "彻底删除",
			trashPurgeConfirm: "彻底删除后不可恢复，确定吗？",
			trashEmptyAll: "清空回收站",
			trashEmptyConfirm: "清空回收站后不可恢复，确定吗？",
			trashRestored: "已恢复",
			trashPurged: "已彻底删除",
			trashEmptied: "回收站已清空",
			trashBroken: "目录已不在，只能清理这条记录",
			trashAt: "删除于",
			trashOriginalAt: "原位置",
			trashCountUnit: "条",
			viewDetail: "详情",
			import: "导入 DSH",
			imported: "已在 DSH",
			reimport: "覆盖导入",
			importing: "导入中…",
			// 来源内部列表（176 条那一屏）：搜索 / 排序 / 只看未导入 / 批量导入
			sortLabel: "排序",
			sortDefault: "默认",
			sortUnimported: "未导入优先",
			onlyUnimported: "只看未导入",
			allImported: "都已导入，没有新的了",
			importedHint: "DSH 用户库里已有同名技能，再导一次会覆盖它",
			batchMode: "批量导入",
			batchExit: "退出批量",
			selectAll: "全选",
			selectNone: "全不选",
			selectUnimported: "全选未导入",
			selectedCount: "已选",
			itemsUnit: "条",
			policyLabel: "撞名时",
			policySkip: "跳过已存在",
			policyOverwrite: "覆盖已存在",
			policySkipHint: "撞名的原样留着，只导入新的（默认）",
			policyOverwriteHint: "撞名的先用来源目录覆盖掉，再导入",
			runBatch: "导入选中",
			batchStop: "停止",
			batchSummary: "导入完成",
			batchOkLabel: "成功",
			batchSkipLabel: "跳过",
			batchFailLabel: "失败",
			batchFailDetail: "失败明细",
			batchRollbackNote: "已成功导入的会保留，不会回滚。",
			noPicked: "先勾选要导入的技能",
			analyze: "AI 分析",
			analyzing: "分析中…",
			analyzed: "分析完成",
			analyzeHint: "批量分析本地技能：一句话说明它能做什么、怎么用",
			analyzeDisabled: "AI 分析未启用：到「设置」开启",
			analyzeAllDone: "已全部分析",
			analyzeAllDoneHint: "当前没有待分析的技能；新增技能或改了 SKILL.md 之后这里会自动亮起",
			analyzeNoSkills: "没扫到可分析的技能，先去「设置」检查技能来源",
			rescanBusyHint: "分析正在进行，先点「停止」再刷新",
			analyzeFail: "分析失败",
			analyzeStop: "停止",
			analyzeStopHint: "停掉后面的批次；已经分析好的会保留",
			analyzedCached: "命中缓存",
			analyzeTruncated: "已到时间上限，没跑完的已保留，下次接着分析",
			analyzeCircuitBreak: "连续失败已自动停止，检查端点后再试",
			// 详情抽屉里的 AI 说明区块（技能库 / 其他 Agent / 已装插件 三处共用一份）
			aiBlockTitle: "AI 说明",
			aiUsageLabel: "用法",
			aiNoneTitle: "还没分析过",
			aiNoneHint: "分析会读一遍 SKILL.md 全文（正文会发给模型，详见「设置」里的隐私提示），给出一句话说明和用法。",
			failures: "失败",
			copy: "复制",
			renderError: "渲染出错",
			back: "返回",
			cancel: "取消",
			// 插件 tab
			noPlugins: "没扫到 DSH 插件",
			pluginsHint: "本机已装 · 启停、更新、卸载、AI 说明",
			pluginDisabled: "已停用",
			// 「本面板」= 技能中枢自己。它不能在这里停用（停掉就没有入口再开回来），
			// 所以开关直接置灰，并把原因写在这一行上，而不是等用户点了再弹错误。
			selfPanel: "本面板",
			selfDisableHint: "这是技能中枢自己：停用后没有入口再打开。要停用它请用 DSH 自带插件页或 dsh CLI。",
			moreActions: "更多操作",
			pluginEnable: "启用",
			pluginDisable: "停用",
			pluginUninstall: "卸载",
			pluginUninstalling: "卸载中…",
			pluginEnableConfirm: "确认启用这个插件？会写入 profile 配置。",
			pluginDisableConfirm: "确认停用这个插件？会写入 profile 配置。",
			pluginUninstallConfirm: "确认卸载这个插件？",
			pluginUninstallWarn: "将从 profile 里移除包本体；自建插件的本地源码目录不受影响。",
			pluginManageDone: "操作完成",
			viewList: "列表显示",
			viewCard: "卡片显示",
			// 插件市场 tab（独立实现：公开目录 + dsh CLI，不依赖 dshmarket）
			// 二级页签叫「插件市场」而不是「发现」：技能那边有个「技能市场」，
			// 两边都叫市场，用户一眼就知道哪儿能装技能、哪儿能装插件。
			pmSubMarket: "插件市场",
			pmSubInstalled: "已安装",
			pmResultCount: "结果",
			pmSearchHint: "搜索插件，例如：通知、终端、记忆…",
			pmNoMatch: "没有匹配的插件",
			pmMore: "加载更多",
			pmInstall: "安装",
			pmInstalledChip: "已安装",
			pmInstalling: "安装中…",
			pmInstallConfirm: "确认安装这个插件？会写入 profile 配置。",
			pmInstallDone: "安装完成",
			pmUpdate: "更新",
			pmUpdating: "更新中…",
			pmUpdateConfirm: "确认更新到最新版？会写入 profile 配置。",
			pmUpdateAll: "全部更新",
			pmHasUpdate: "可更新",
			pmOnlyUpdatable: "只看可更新",
			pmFromCatalog: "目录数据可能滞后",
			pmUpdateFailed: "更新未生效",
			toastExpand: "展开详情",
			toastCollapse: "收起",
			toastDismiss: "关闭提示",
			pluginOverridden: "已保存，但被更高优先级的配置覆盖，当前未生效",
			secConfig: "配置",
			secMore: "说明文档",
			// 详情页「信息」事实表 + 原生配置区的说明
			detailInfo: "信息",
			detailDir: "安装目录",
			detailNativeHint: "由插件作者提供",
			backToList: "返回插件列表",
			stState: "运行状态",
			stLoading: "加载中",
			stFailed: "异常",
			stUnloading: "卸载中",
			stPending: "等待依赖",
			stOff: "已关闭",
			// 配置已启用、但宿主没加载（版本不兼容 / 加载失败 / 启动时被跳过）
			pluginNotLoaded: "未加载",
			pluginOverrideChip: "被配置覆盖",
			pmRefresh: "刷新目录",
			// 热重载：不重启 DSH 让磁盘上的插件代码生效
			hotReload: "重载插件代码",
			hotReloadBusy: "重载中…",
			hotReloadDone: "已重新组合，改动的插件代码已生效",
			hotReloadRestart: "有改动需要重启 DSH 才能生效",
			hotReloadUnavailable: "当前部署拿不到宿主插件管理器，改完代码请重启 DSH",
			hotReloadHint: "不用重启 DSH：按磁盘上的文件重新组合，替换改动的插件代码",
			pmRefreshing: "刷新中…",
			pmRefreshDone: "目录已刷新",
			pmOpenPage: "主页",
			pmFilter: "筛选",
			pmSortBy: "排序字段",
			pmSortDownloads: "下载量（近 30 天）",
			pmSortStars: "Star 数",
			pmSortAdded: "发布时间",
			pmSortDir: "排序方向",
			pmSortDesc: "降序",
			pmSortAsc: "升序",
			pmTime: "发布时间",
			pmTimeAll: "全部时间",
			pmTime7: "最近 7 天",
			pmTime30: "最近 30 天",
			pmTime90: "最近 90 天",
			pmTime365: "最近 1 年",
			pmMoreCats: "更多分类",
			pmLessCats: "收起分类",
			pmLoading: "加载目录…",
			pmRedLines: "高危能力",
			// 插件市场详情（右侧抽屉）
			pmCapabilities: "能力",
			pmCatCount: "分类",
			pmRedLinesHint: "标记了高危能力，安装前先确认你真的需要它。",
			pmDetailIntro: "简介",
			pmSpecLabel: "安装标识",
			pmOpenNpm: "npm 页面",
			pmReset: "重置筛选",
			pmUpdates: "个可更新",
			pmCatalogCache: "目录缓存",
			pmStale: "拉取失败，用的是旧缓存",
			tabSkills: "技能",
			setMaintain: "维护 / 诊断",
			setMaintainHint: "按包名安装、目录缓存状态。",
			setAnalyzeMode: "分析通道",
			setModeHost: "用 Harness 当前模型",
			setModeHostShort: "推荐 · 零配置",
			// 两条通道的说明都要点明"内容会去对方那里"——
			// 只写"不用填 Key""适合本地小模型"会让用户以为分析在本地跑。
			setModeHostHint: "直接调用 DSH 当前默认模型，不用填端点或 Key。分析内容会发送给该模型的服务商。",
			setModeEndpoint: "自定义端点",
			setModeEndpointShort: "OpenAI 兼容",
			setModeEndpointHint: "填自建/局域网端点，适合本地小模型。分析内容会发送到你填的这个地址。",
			hostModelUnknown: "读取中…",
			scanDepthHint: "从来源目录往下找几层里的技能（默认 3；调小会漏，调大更慢）",
			scanMaxHint: "单个来源最多收多少条，防止目录过大拖死扫描",
			scanFound: "当前扫到",
			scanTry: "试扫一次",
			pmRefreshAll: "刷新目录",
			pmCatalogNoCache: "还没有缓存，进一次插件市场即可生成",
			maintInstallTitle: "按包名安装插件",
			maintInstallPlaceholder: "包名 / 包名@版本 / github:owner/repo / 本地绝对路径",
			maintInstallGo: "安装",
			maintInstallHint: "逃生舱：市场里搜不到的插件可以在这里直接装。",
			// 「所有分类」还给技能市场用：那是远端 SkillHub 的类目，不在这次简化范围内
			allCategories: "所有分类",
			ok: "确定",
			// 市场（卡片网格布局）
			tabAll: "全部",
			tabHot: "近期飙升",
			tabDownloads: "下载量",
			tabUpdated: "最近上新",
			allCategories: "所有分类",
			allSources: "所有来源",
			browseAll: "浏览全部技能",
			dirMissing: "目录不存在",
			apiKeyAll: "不限 API Key",
			apiKeyNeed: "需要 API Key",
			apiKeyNo: "无需 API Key",
			needApiKey: "需配置 API Key",
			enterprise: "企业",
			filterCurrentPage: "只筛当前页",
			searchPlaceholder: "搜索技能名称、描述或关键词…",
			search: "搜索",
			pageWord: "第",
			install: "安装",
			installing: "安装中…",
			installed: "✓ 已安装",
			installFail: "安装失败",
			verified: "认证",
			prevPage: "上一页",
			nextPage: "下一页",
			marketEmpty: "没有结果，换个关键词试试。",
			downloadsLabel: "下载量",
			starsLabel: "收藏",
			versionsLabel: "历史版本",
			commentsLabel: "评论",
			updatedLabel: "更新",
			authorLabel: "作者",
			// 设置
			setSources: "其他 Agent 技能目录",
			setSourcesHint: "自动发现的目录可直接启停；也可手动添加。改完点保存。",
			addSource: "新增来源",
			newSource: "新来源",
			sourceLabel: "显示名",
			sourcePath: "路径",
			enabled: "启用",
			removeSource: "删除",
			builtinCannotRemove: "内置",
			typeHarness: "Harness 库",
			typeShared: "共享池",
			typeExternal: "外部",
			setAnalyze: "AI 分析（本地技能）",
			setAnalyzeHint: "默认关闭。开启后「其他 Agent」页的「AI 分析」才可用：读 SKILL.md 全文，一句话说明它能做什么、怎么用。市场技能自带中文，无需处理。",
			// 隐私提示单独成块（不混在上面那句里）——这段是用户真正需要停下来看的东西，
			// 塞进长句里就等于没有。措辞上先说清"发什么、发给谁"，再说"我们做了什么兜底"，
			// 最后给出用户自己要做的动作。不夸大也不遮掩。
			analyzePrivacyTitle: "会把技能全文发出去",
			analyzePrivacyBody:
				"AI 分析要把 SKILL.md 全文发给模型（每条最多 8KB）。技能里如果写了密钥、令牌或内网地址，会跟着一起发出去；分析结果还会落到本地 analyses.json 并显示在卡片上。发送前会按常见密钥形态打码，但打码是启发式的、覆盖不全，来源不放心时先自己看一眼。首次点「AI 分析」时还会再确认一次。",
			analyzeFirstLead: "AI 分析会把技能正文原样发给模型。技能里如果写了密钥、令牌或内网地址，会跟着一起发出去。",
			analyzeFirstWhere: "发送目标：",
			analyzeFirstTail: "发送前已按常见密钥形态打码，但打码是启发式的、覆盖不全。确认这些技能里没有你不希望外传的内容。",
			analyzeFirstOk: "开始分析",
			analyzeEnable: "启用 AI 分析",
			baseUrl: "接口地址",
			baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
			apiKey: "API Key",
			apiKeyKeep: "留空表示保持不变",
			model: "模型名",
			modelPlaceholder: "gpt-4o-mini / qwen2.5:7b",
			batchSize: "单批条数",
			batchSizeHint: "一次分析几个，1最稳",
			concurrency: "并发数",
			concurrencyHint: "同时几个请求，本地模型别超2",
			maxTokens: "最大输出Token",
			maxTokensHint: "留空或 0 = 不限制，由端点决定",
			useHostFallback: "直连失败时回退宿主模型",
			cacheInfo: "缓存",
			cacheCount: "条分析结果",
			clearCache: "清空",
			clearCacheConfirm: "清空全部 AI 分析缓存？下次分析会重新调用模型。",
			setScan: "扫描",
			scanDepth: "深度",
			maxPerSource: "上限",
			saving: "保存中…",
			saved: "已保存",
			saveFail: "保存失败",
			// 设置页自动保存 + 悬浮保存条
			saveNow: "立即保存",
			stClean: "已保存 · 改动会自动保存",
			stDirty: "有改动，待保存",
			stSaved: "已自动保存",
			stError: "保存失败",
			stBlocked: "自动保存已暂停：有来源没填路径",
			reset: "恢复默认",
			resetConfirm: "恢复默认配置？自定义来源与 AI 分析设置会丢失。",
			configPathLabel: "配置文件",
			testAnalyze: "测试",
			testUsesSaved: "测试前会自动保存当前设置",
			testing: "测试中…",
			testOk: "可用",
			testFail: "不可用",
		};

		const en = {
			panelTitle: "Skill Station",
			tabHarness: "Harness skills",
			tabAgents: "Other agents",
			tabPlugins: "Plugins",
			tabMarket: "Skill market",
			tabSettings: "Settings",
			scanning: "Loading…",
			rescan: "Refresh",
			filter: "Filter skills…",
			filterPlugins: "Filter plugins…",
			skillsUnit: "skills",
			noSkills: "No skills found. Check sources in Settings.",
			noMatch: "No matching skills",
			clearFilter: "Clear filter",
			clearInput: "Clear",
			loadFail: "Load failed",
			modelInvocable: "Model visible",
			userInvocable: "User callable",
			// Visibility: DSH-native frontmatter keys (disable-model-invocation / user-invocable)
			visibilityModelHint: "When off, the model no longer sees this skill in its catalog; manual invocation still works",
			visibilityUserHint: "When off, the skill is not offered for direct user invocation",
			visibilityReadonlyHint: "This source is read-only; visibility can't be changed here",
			visibilitySaved: "Updated",
			visibilityFail: "Failed to update visibility",
			// Master switch: closing both surfaces at once is what "disabled" means
			disable: "Disable",
			enable: "Enable",
			disabledTag: "Disabled",
			partialDisabledTag: "Partly hidden",
			disableHint: "Closed: neither the model nor you can reach it. The file stays in place and can be enabled again",
			enableHint: "Enabled: the model sees it and you can invoke it with /",
			partialDisableHint: "Only one surface is closed right now; this closes both",
			advancedVisibility: "Advanced: control each surface",
			advancedVisibilityHint: "\"Disable\" closes both at once. Here you can close just one, for example keep it for the model but hide it from your own picker",
			visibilityModelShort: "Model side",
			visibilityUserShort: "User side",
			// Injected cost: context budget taken by name + description
			// Delete -> trash
			remove: "Delete",
			removeConfirm: "Move to trash? You can restore it at any time.",
			removedToTrash: "Moved to trash",
			removeHint: "Move to trash: restorable",
			// Origin (import ledger)
			originLabel: "Origin",
			originImportedAt: "Imported",
			originMarket: "Skill market",
			originAvailable: "Source still present: can re-import",
			originGone: "Source is gone",
			originAlsoIn: "Also in",
			// Trash
			tabTrash: "Trash",
			trashHint: "Deleted skills land here first and can be restored",
			trashEmptyTitle: "Trash is empty",
			trashEmptyDesc: "Skills you delete from the library show up here",
			trashRestore: "Restore",
			trashPurge: "Delete forever",
			trashPurgeConfirm: "This cannot be undone. Delete permanently?",
			trashEmptyAll: "Empty trash",
			trashEmptyConfirm: "This cannot be undone. Empty the trash?",
			trashRestored: "Restored",
			trashPurged: "Permanently deleted",
			trashEmptied: "Trash emptied",
			trashBroken: "Folder is gone; only this record can be cleaned up",
			trashAt: "Deleted",
			trashOriginalAt: "Original path",
			trashCountUnit: "items",
			viewDetail: "Detail",
			import: "Import to DSH",
			imported: "In DSH",
			reimport: "Overwrite",
			importing: "Importing…",
			// Skill list inside a source: search / sort / unimported-only / bulk import
			sortLabel: "Sort",
			sortDefault: "Default",
			sortUnimported: "Unimported first",
			onlyUnimported: "Unimported only",
			allImported: "Nothing new: every skill is already imported",
			importedHint: "A folder with the same name already exists in the DSH library; importing again overwrites it",
			batchMode: "Bulk import",
			batchExit: "Exit bulk",
			selectAll: "Select all",
			selectNone: "Clear",
			selectUnimported: "Select unimported",
			selectedCount: "Selected",
			itemsUnit: "items",
			policyLabel: "On conflict",
			policySkip: "Skip existing",
			policyOverwrite: "Overwrite existing",
			policySkipHint: "Keep the existing copy and import only new skills (default)",
			policyOverwriteHint: "Replace the existing copy with the source version, then import",
			runBatch: "Import selected",
			batchStop: "Stop",
			batchSummary: "Import finished",
			batchOkLabel: "ok",
			batchSkipLabel: "skipped",
			batchFailLabel: "failed",
			batchFailDetail: "Failures",
			batchRollbackNote: "Successfully imported skills are kept: nothing is rolled back.",
			noPicked: "Pick at least one skill first",
			analyze: "AI Analyze",
			analyzing: "Analyzing…",
			analyzed: "Analyzed",
			analyzeHint: "Batch-analyze local skills: one line on what it does and how to use it",
			analyzeDisabled: "AI analysis off: enable it in Settings",
			analyzeAllDone: "All analyzed",
			analyzeAllDoneHint: "Nothing left to analyze: this lights up again when a skill is added or its SKILL.md changes",
			analyzeNoSkills: "No analyzable skills found: check your sources in Settings",
			rescanBusyHint: "Analysis in progress: stop it before rescanning",
			analyzeFail: "Analysis failed",
			analyzeStop: "Stop",
			analyzeStopHint: "Stop the remaining batches: finished ones are kept",
			analyzedCached: "from cache",
			analyzeTruncated: "Time limit reached: unfinished items are kept for the next run",
			analyzeCircuitBreak: "stopped after repeated failures: check the endpoint and retry",
			// The AI block inside the detail drawer (shared by library / agents / plugins)
			aiBlockTitle: "AI summary",
			aiUsageLabel: "Usage",
			aiTriggersLabel: "Triggers",
			aiNoneTitle: "Not analyzed yet",
			aiNoneHint: "Analysis reads the whole SKILL.md (the text is sent to the model: see the privacy note in Settings) and writes one line on what it does and how to use it.",
			failures: "failed",
			copy: "Copy",
			renderError: "render error",
			back: "Back",
			cancel: "Cancel",
			// plugins tab
			noPlugins: "No DSH plugins found",
			pluginsHint: "Installed · enable, update, uninstall, AI notes",
			pluginDisabled: "disabled",
			selfPanel: "this panel",
			selfDisableHint: "This is Skill Station itself: disabling it removes the only entry point back. Use DSH's built-in plugin page or the dsh CLI instead.",
			moreActions: "More actions",
			pluginEnable: "Enable",
			pluginDisable: "Disable",
			pluginUninstall: "Uninstall",
			pluginUninstalling: "Uninstalling…",
			pluginEnableConfirm: "Enable this plugin? This writes the profile config.",
			pluginDisableConfirm: "Disable this plugin? This writes the profile config.",
			pluginUninstallConfirm: "Uninstall this plugin?",
			pluginUninstallWarn: "The package is removed from the profile; local source dirs of linked plugins are untouched.",
			pluginManageDone: "Done",
			viewList: "List view",
			viewCard: "Card view",
			// Plugin market tab (standalone: public catalog + dsh CLI, no dshmarket dependency)
			pmSubMarket: "Plugin market",
			pmSubInstalled: "Installed",
			pmResultCount: "Results",
			pmSearchHint: "Search plugins, e.g. notify, terminal, memory…",
			pmNoMatch: "No matching plugins",
			pmMore: "Load more",
			pmInstall: "Install",
			pmInstalledChip: "Installed",
			pmInstalling: "Installing…",
			pmInstallConfirm: "Install this plugin? This writes the profile config.",
			pmInstallDone: "Installed",
			pmUpdate: "Update",
			pmUpdating: "Updating…",
			pmUpdateConfirm: "Update to the latest version? This writes the profile config.",
			pmUpdateAll: "Update all",
			pmHasUpdate: "Update available",
			pmOnlyUpdatable: "Only updatable",
			pmFromCatalog: "Catalog data may lag",
			pmUpdateFailed: "Update did not take effect",
			secConfig: "Configuration",
			secMore: "Documentation",
			detailInfo: "Details",
			detailDir: "Install directory",
			detailNativeHint: "Provided by the plugin author",
			backToList: "Back to plugin list",
			stState: "Status",
			stLoading: "Loading",
			stFailed: "Failed",
			stUnloading: "Unloading",
			stPending: "Pending deps",
			stOff: "Off",
			pluginNotLoaded: "Not loaded",
			toastExpand: "Show details",
			toastCollapse: "Collapse",
			toastDismiss: "Dismiss",
			pluginOverridden: "Saved, but a higher-priority config overrides it; not currently in effect",
			pluginOverrideChip: "Overridden",
			pmRefresh: "Refresh catalog",
			hotReload: "Reload plugin code",
			hotReloadBusy: "Reloading…",
			hotReloadDone: "Recomposed; changed plugin code is live",
			hotReloadRestart: "Some changes need a DSH restart",
			hotReloadUnavailable: "Host plugin manager unavailable; restart DSH to apply code changes",
			hotReloadHint: "No DSH restart: recompose from the files on disk and replace changed plugin code",
			pmRefreshing: "Refreshing…",
			pmRefreshDone: "Catalog refreshed",
			pmOpenPage: "Home",
			pmFilter: "Filter",
			pmSortBy: "Sort by",
			pmSortDownloads: "Downloads (30d)",
			pmSortStars: "Stars",
			pmSortAdded: "Published",
			pmSortDir: "Direction",
			pmSortDesc: "Descending",
			pmSortAsc: "Ascending",
			pmTime: "Published",
			pmTimeAll: "All time",
			pmTime7: "Last 7 days",
			pmTime30: "Last 30 days",
			pmTime90: "Last 90 days",
			pmTime365: "Last year",
			pmMoreCats: "More categories",
			pmLessCats: "Fewer categories",
			pmLoading: "Loading catalog…",
			pmRedLines: "High privilege",
			// Plugin market detail (right-side drawer)
			pmCapabilities: "Capabilities",
			pmCatCount: "Categories",
			pmRedLinesHint: "Flagged with high-privilege capabilities: make sure you really need this before installing.",
			pmDetailIntro: "About",
			pmSpecLabel: "Install spec",
			pmOpenNpm: "npm page",
			pmReset: "Reset filters",
			pmUpdates: "updatable",
			pmCatalogCache: "Catalog cache",
			pmStale: "fetch failed, using stale cache",
			tabSkills: "Skills",
			setMaintain: "Maintenance",
			setMaintainHint: "Install by spec, catalog cache status.",
			setAnalyzeMode: "Analyze channel",
			setModeHost: "Use the current Harness model",
			setModeHostShort: "Recommended · zero setup",
			setModeHostHint: "Calls the DSH default model directly. No endpoint or key needed. Analysis content is sent to that model's provider.",
			setModeEndpoint: "Custom endpoint",
			setModeEndpointShort: "OpenAI compatible",
			setModeEndpointHint: "Point at your own/LAN endpoint, good for small local models. Analysis content is sent to the address you enter.",
			hostModelUnknown: "Reading…",
			scanDepthHint: "How many levels under each source to look for skills (3 by default)",
			scanMaxHint: "Max skills collected per source, keeps a huge folder from stalling the scan",
			scanFound: "Found",
			scanTry: "Try a scan",
			pmRefreshAll: "Refresh catalog",
			pmCatalogNoCache: "No cache yet: open the plugin market once to build it",
			maintInstallTitle: "Install a plugin by spec",
			maintInstallPlaceholder: "name / name@version / github:owner/repo / local absolute path",
			maintInstallGo: "Install",
			maintInstallHint: "Escape hatch: install plugins the market cannot find.",
			// "All categories" still serves the skill market: those are remote SkillHub categories.
			allCategories: "All categories",
			ok: "OK",
			tabAll: "All",
			tabHot: "Trending",
			tabDownloads: "Downloads",
			tabUpdated: "Recently updated",
			allCategories: "All categories",
			allSources: "All sources",
			browseAll: "Browse all skills",
			dirMissing: "Directory not found",
			apiKeyAll: "Any API key",
			apiKeyNeed: "Needs API key",
			apiKeyNo: "No API key",
			needApiKey: "API key required",
			enterprise: "Enterprise",
			filterCurrentPage: "current page only",
			searchPlaceholder: "Search skill names, descriptions or keywords…",
			search: "Search",
			pageWord: "Page",
			install: "Install",
			installing: "Installing…",
			installed: "✓ Installed",
			installFail: "Install failed",
			verified: "verified",
			prevPage: "Prev",
			nextPage: "Next",
			marketEmpty: "No results: try another keyword.",
			downloadsLabel: "Downloads",
			starsLabel: "Stars",
			versionsLabel: "Versions",
			commentsLabel: "Comments",
			updatedLabel: "Updated",
			authorLabel: "Author",
			setSources: "Other agent skill roots",
			setSourcesHint: "Toggle auto-discovered roots, or add any path. Click Save when done.",
			addSource: "Add source",
			newSource: "New source",
			sourceLabel: "Label",
			sourcePath: "Path",
			enabled: "Enabled",
			removeSource: "Remove",
			builtinCannotRemove: "Built-in",
			typeHarness: "Harness library",
			typeShared: "Shared pool",
			typeExternal: "External",
			setAnalyze: "AI analysis (local skills)",
			setAnalyzeHint: "Off by default. Enable it to unlock AI analysis on the Other agents tab: it reads the full SKILL.md and writes one line on what it does and how to use it. Market skills are natively Chinese.",
			analyzePrivacyTitle: "Sends the full skill text out",
			analyzePrivacyBody:
				"AI analysis sends the full SKILL.md to your model (up to 8KB per item). Keys, tokens or internal addresses written inside a skill go with it, and results are cached to a local analyses.json and shown on cards. Common key shapes are masked before sending, but masking is heuristic and incomplete , check unfamiliar skills yourself first. The first time you press Analyze there is also a one-time confirmation.",
			analyzeFirstLead: "AI analysis sends each skill's full text to the model: keys, tokens or internal addresses inside a skill go with it.",
			analyzeFirstWhere: "Sending to: ",
			analyzeFirstTail: "Common key shapes are masked before sending, but masking is heuristic and incomplete. Make sure these skills hold nothing you'd rather not send.",
			analyzeFirstOk: "Start analysis",
			analyzeEnable: "Enable AI analysis",
			baseUrl: "Base URL",
			baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
			apiKey: "API Key",
			apiKeyKeep: "Leave blank to keep",
			model: "Model",
			modelPlaceholder: "gpt-4o-mini / qwen2.5:7b",
			batchSize: "Batch size",
			batchSizeHint: "How many per call: 1 is safest",
			concurrency: "Concurrency",
			concurrencyHint: "Parallel requests: keep ≤2 for a local model",
			maxTokens: "Max output tokens",
			maxTokensHint: "Blank or 0 = let the endpoint decide",
			useHostFallback: "Fall back to host model",
			cacheInfo: "Cache",
			cacheCount: "analyses",
			clearCache: "Clear",
			clearCacheConfirm: "Clear the whole analysis cache? The next run will call the model again.",
			setScan: "Scan",
			scanDepth: "Depth",
			maxPerSource: "Max",
			saving: "Saving…",
			saved: "Saved",
			saveFail: "Save failed",
			saveNow: "Save now",
			stClean: "Saved · changes save automatically",
			stDirty: "Unsaved changes",
			stSaved: "Auto-saved",
			stError: "Save failed",
			stBlocked: "Auto-save paused: a source has no path",
			reset: "Reset",
			resetConfirm: "Reset to defaults? Custom sources and AI analysis settings are lost.",
			configPathLabel: "Config file",
			testAnalyze: "Test",
			testUsesSaved: "Saves the current settings before testing",
			testing: "Testing…",
			testOk: "Works",
			testFail: "Unavailable",
		};

		/* ================================================================ *
		 * api
		 * ================================================================ */

		const API = {
			harness: "api/dsh-curator/harness",
			plugins: "api/dsh-curator/plugins",
			pluginToggle: "api/dsh-curator/plugins/toggle",
			pluginUninstall: "api/dsh-curator/plugins/uninstall",
			pluginInstall: "api/dsh-curator/plugins/install",
			marketCatalog: "api/dsh-curator/market/catalog",
			marketStatus: "api/dsh-curator/market/status",
			config: "api/dsh-curator/config",
			reset: "api/dsh-curator/config/reset",
			scan: "api/dsh-curator/scan",
			skill: "api/dsh-curator/skill",
			importSkill: "api/dsh-curator/import",
			removeSkill: "api/dsh-curator/remove",
			skillVisibility: "api/dsh-curator/skill/visibility",
			trash: "api/dsh-curator/trash",
			trashRestore: "api/dsh-curator/trash/restore",
			trashPurge: "api/dsh-curator/trash/purge",
			trashEmpty: "api/dsh-curator/trash/empty",
			analyze: "api/dsh-curator/analyze",
			analyzeCache: "api/dsh-curator/analyze/cache",
			marketSearch: "api/dsh-curator/market/search",
			marketCategories: "api/dsh-curator/market/categories",
			marketInstall: "api/dsh-curator/market/install",
			reload: "api/dsh-curator/reload",
			diagnostics: "api/dsh-curator/diagnostics",
		};

		/**
		 * 把失败响应里的原因抠出来，拼成一句人能读的话。
		 *
		 * 以前这里只写 `throw new Error("HTTP " + res.status)`，于是后端精心写的
		 * 「插件不存在或已卸载: xxx」「已保存，但被更高优先级的配置覆盖」全被丢掉，
		 * 用户只看得到一个「HTTP 400」—— 这就是"UI 反馈烂透"的来源：
		 * 不是后端没说，是前端把它扔了。
		 *
		 * 后端的错误体是 { error: "..." }（少数是 { message }），两个都认；
		 * 解析不出来才退回状态码，至少不假装成功。
		 */
		async function failureText(res) {
			const fallback = "HTTP " + res.status;
			try {
				const data = await res.json();
				const msg = data?.error ?? data?.message;
				if (typeof msg === "string" && msg.trim() !== "") return msg.trim();
				if (msg !== undefined && msg !== null) return String(msg);
			} catch {
				/* 响应不是 JSON（网关错误页之类）—— 退回状态码 */
			}
			return fallback;
		}

		async function getJson(path) {
			const res = await fetch(path, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(await failureText(res));
			return await res.json();
		}

		const sendJson = async (path, method, body) => {
			const res = await fetch(path, {
				method,
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (!res.ok) throw new Error(await failureText(res));
			return await res.json();
		};

		/* ================================================================
		 * 全局提示条（toast）
		 *
		 * 为什么不是每个页签各存一份 useState：之前就是那样，结果是
		 * 「在插件页点了开关 → 切到别的页签 → 提示没了」。用户操作完只要
		 * 视线一移开，就再也看不到刚才成功还是失败 —— 这正是
		 * 「不知道到底成没成功」的根源之一（实测：切页签后提示消失）。
		 *
		 * 现在改成模块级的单一来源：任何页签 setToast 都写同一个格子，
		 * 由顶层组件统一渲染。附带两个改进：
		 *   1. 成功提示 4 秒后自动消失（失败提示留着，用户要看清原因）；
		 *   2. 新提示覆盖旧提示，不会在页面上堆一列。
		 * ================================================================ */
		const TOAST_OK_MS = 4000;
		let toastState = undefined;
		const toastSubs = new Set();
		let toastTimer = null;

		function emitToast(next) {
			toastState = next;
			for (const fn of toastSubs) {
				try { fn(next); } catch { /* 单个订阅者出错不影响其余 */ }
			}
		}

		/** 组件内用：const [toast, setToast] = useToast()，与原 useState 用法完全一致。 */
		function useToast() {
			const [local, setLocal] = react.useState(toastState);
			react.useEffect(() => {
				toastSubs.add(setLocal);
				// 订阅前可能已经有提示（比如切页签时），补一次当前值
				setLocal(toastState);
				return () => { toastSubs.delete(setLocal); };
			}, []);
			const set = react.useCallback((next) => {
				if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
				emitToast(next);
				// 只给成功提示自动消失；失败信息留着，用户得看清原因
				if (next !== undefined && next.kind === "ok") {
					toastTimer = setTimeout(() => { toastTimer = null; emitToast(undefined); }, TOAST_OK_MS);
				}
			}, []);
			return [local, set];
		}

		/**
		 * 提示条组件。所有页签统一用它渲染，替换掉原先 9 处
		 * `h("div", {className:"ss-ok"|"ss-err"}, toast.text)`。
		 *
		 * 为什么值得抽出来：
		 *   - 成功/失败有明确区分（图标 + 语义色 + 左边线），不再"成功了没提示"；
		 *   - **长错误不再撑爆界面**：默认只显示约 3 行，超出可展开、内部可滚动。
		 *     之前 pnpm 那 1202 字符的日志会把整个面板顶掉。
		 *   - 带 role=status + aria-live=polite，读屏能播报操作结果；
		 *   - 有关闭按钮，长错误看完能手动收掉（失败提示本来不自动消失）。
		 */
		function Toast(props) {
			const t = props.toast;
			if (t === undefined || t === null) return null;
			const isOk = t.kind === "ok";
			const [open, setOpen] = react.useState(false);
			const text = String(t.text ?? "");
			// 粗略判断是否超过 3 行：按 60 字/行估。够用即可，不需要精确测量。
			const long = text.length > 180 || text.split("\n").length > 3;
			return h(
				"div",
				{
					className: "ss-toast " + (isOk ? "ok" : "err"),
					role: "status",
					"aria-live": "polite",
				},
				h("span", { className: "ss-toast-icon", "aria-hidden": "true" }, isOk ? "✓" : "!"),
				h(
					"div",
					{ className: "ss-toast-body" },
					h("div", { className: "ss-toast-text", "data-open": open ? "" : undefined }, text),
					long
						? h(
								"button",
								{
									type: "button",
									className: "ss-toast-dismiss",
									style: { marginLeft: 0, opacity: 0.85, fontSize: 11 },
									onClick: () => setOpen((v) => !v),
								},
								open ? tr("toastCollapse") : tr("toastExpand"),
							)
						: null,
				),
				// 失败提示不自动消失（用户要看原因），所以给一个显式关闭
				isOk ? null : h(
					"button",
					{
						type: "button",
						className: "ss-toast-dismiss",
						"aria-label": tr("toastDismiss"),
						title: tr("toastDismiss"),
						onClick: () => setToastGlobal(undefined),
					},
					"×",
				),
			);
		}

		/** 供 Toast 内部关闭用（模块级，不依赖某个页签的实例）。 */
		function setToastGlobal(next) {
			if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
			emitToast(next);
		}

		/* ================================================================ *
		 * styles —— 视觉调性参照 SkillHub 官网自写：干净的白卡、行式列表、chips 筛选。
		 * 只借鉴观感，颜色一律取宿主（DSH）暴露的 --dsw-* 变量，不搬任何外部样式表。
		 * ================================================================ */

		const CSS = `
/* ==== 设计 token：颜色取 DSH 宿主变量 --dsw-*，宿主没给的才用本插件自备兜底值
 * （视觉调性参照 iOS 毛玻璃风：半透明层 + 模糊 + 单一强调色）。
 * --ss-glass-bg   毛玻璃底（半透明白）
 * --ss-glass-blur 毛玻璃模糊
 * --ss-accent     iOS 蓝
 *
 * 底色一律取 bg-layer-*，**不取 bg-base**：
 * 鲸鱼娘皮肤（@smalltailqwq/dsh-client-ui-skin-maid-atelier）把
 * body[data-dsh-maid-atelier] 的 --dsw-alias-bg-base 设成了 transparent，
 * 好让壁纸透出来；任何拿 bg-base 当底色的面板，文字就直接叠在壁纸上。
 * 皮肤只给 bg-layer-1/2/3 保留了接近不透明的值（dark 下 #121f43e6 等），
 * 所以「不透底」这件事要靠 bg-layer-* 才成立 —— 见下面的 --ss-surface。
 *
 * 实测（tools/curator-contrast-audit.mjs，模拟壁纸为纯白/纯黑的最坏情况）：
 *   文字 label-primary / label-secondary 压在 --ss-surface 上，
 *   对比度 10.2–14.1，全部通过 WCAG AA(4.5)；压在半透明 --ss-glass-bg 上时
 *   label-secondary 会掉到 4.17（白壁纸），所以玻璃底只用于装饰性分区，
 *   正文层一律走 --ss-surface。 */
.ss-root{
  --ss-accent:var(--dsw-alias-state-business-primary,#007aff);
  /* 彩色底 / 彩色文字要过 WCAG AA(4.5)。--ss-accent 本身不够：
   * 浅色的 #4176e6 在白底上只有 4.23、深色的 #7aaaff 配白字只有 2.35。
   * 所以拆两支：accent-strong 是"当文字/当实心底色"用的加深版，
   * on-accent 是"压在实心底色上的文字"（深色主题用近黑，不用白）。 */
  --ss-accent-strong:color-mix(in srgb,var(--ss-accent) 84%,#000);
  --ss-on-accent:#fff;
  --ss-glass-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#ffffffcc) 82%,transparent);
  --ss-glass-bg-strong:var(--dsw-alias-bg-layer-2,#ffffffd9);
  --ss-glass-border:var(--dsw-alias-border-l2,#3c3c4321);
  --ss-glass-blur:blur(24px) saturate(160%);
  /* 正文容器的底色。
   * 取「overlay 94% + layer-3」而不是 bg-layer-1：皮肤把 bg-base 设成 transparent，
   * 而 layer-1 只有 72%（浅色）的 alpha —— 故意配深色壁纸时，浅色主题面板会被壁纸
   * 拉成灰色，灰字直接掉到 3.3（实测 tools/curator-contrast-audit.mjs）。
   * overlay 在皮肤里是 96%-97% 不透明，且两套主题各有一支，是最接近"页面底"的 token。 */
  --ss-surface:color-mix(in srgb,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#ffffff)) 94%,var(--dsw-alias-bg-layer-3,#f2f2f7));
  /* 状态色一律走宿主语义 token，不写死 iOS 数值。
   * 为什么必须这样（实测 tools/curator-status-contrast.mjs）：
   * 原来写死的 #34c759 / #ff9500 / #ff9f0a 在鲸鱼娘皮肤**浅色主题**下，
   * 压在面板底色上的对比度只有 2.12 / 2.10 / 1.96 —— 全部低于 WCAG AA(4.5)。
   * 这几支固定色是按"纯白底"挑的，遇到皮肤那种带蓝的浅底就崩了。
   * 宿主的 --dsw-alias-state-* 是按主题成对调过的（浅色用深阶、深色用浅阶），
   * 所以它天然在两个主题里都成立，换肤也自动跟随。 */
  --ss-ok:var(--dsw-alias-state-success-primary,#1d8a3e);
  --ss-warn:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#8a5a00));
  --ss-danger:var(--dsw-alias-state-error-primary,#c0392b);
  /* v2 标尺：界面只有这一套线、一个控件高度、一个圆角。
   * 之前每个组件各自写 border/radius/shadow，攒出 6 种"卡片"长相；
   * 现在统一成：列表 = 一个容器 + 发丝分隔线，卡片 = 一层描边，浮层才给阴影。 */
  --ss-line:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,transparent);
  --ss-line-strong:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);
  --ss-ctl-h:32px;
  --ss-r:10px;
  display:flex;flex-direction:column;height:100%;min-height:0;gap:0;padding:18px 24px 14px;
  /* 容器查询：让子元素按「面板自己的宽度」响应，而不是按视口宽度。
   * 官方插件（deliverables / settings-plugin-inventory / trajectory）都是这个路子：
   * 根上声明 container-type:inline-size，子规则写 @container (width<=620px)。
   * 和下面 data-ss-w 那套 JS 分档并存：JS 档管网格列数这类需要换结构的地方，
   * @container 管 padding / 字号 / 行数这类纯 CSS 就能解决的细节，
   * 后者在面板刚挂载、JS 还没量到宽度时就已经生效，不会闪一下错版。 */
  container-type:inline-size;
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);box-sizing:border-box;
  background:var(--ss-surface)
}
/* 一级页签：底部下划线式，不再用彩色药丸。
 * 原来一级页签（浅底药丸）和二级分段（描边药丸）、分类筛选（实心药丸）是三种
 * 不同的"药丸"，同屏叠在一起分不清哪个是换页面。现在层级定死：
 *   换一级页面 = 下划线；换二级分区 = 分段控件；筛条件 = 文字 chip。 */
.ss-tabs{display:flex;gap:22px;flex:none;align-items:center;border-bottom:1px solid var(--ss-line);padding:0 2px;width:100%;max-width:1120px;margin-left:auto;margin-right:auto}
/* 深色主题下 --ss-accent 本身就是浅蓝：实心底色不用再压暗，但压在上面的文字必须变深 */
body[data-ds-dark-theme] .ss-root{--ss-accent-strong:var(--ss-accent);--ss-on-accent:#0b1020}
.ss-tab{background:0 0;border:none;border-radius:0;padding:11px 0 12px;font-size:14px;font-weight:500;cursor:pointer;color:var(--dsw-alias-label-secondary);white-space:nowrap;position:relative;transition:color .15s}
.ss-tab:hover{color:var(--dsw-alias-label-primary);background:0 0}
.ss-tab[data-active]{color:var(--dsw-alias-label-primary);background:0 0;font-weight:600}
.ss-tab[data-active]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--ss-accent)}
.ss-body{flex:1;min-height:0;overflow:auto;padding:2px 2px 20px}
.ss-toolbar{display:flex;gap:8px;align-items:center;margin:0 0 12px;flex-wrap:wrap}
/* 工具栏右半区：动作收进一组，跟搜索/筛选分开。
 * 以前搜索框、分类、视图切换、AI 分析、全部更新、只看可更新、刷新全挤在一行，
 * 其中两个还是实心蓝按钮 —— 一屏出现两个 primary，等于没有 primary。 */
.ss-toolbar-end{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto}
.ss-input{height:var(--ss-ctl-h);padding:0 12px;font-size:13px;border:1px solid var(--ss-line);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);box-sizing:border-box;outline:none;transition:border-color .15s,box-shadow .15s}
.ss-select{height:var(--ss-ctl-h);padding:0 8px;font-size:12.5px;border:1px solid var(--ss-line);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);outline:none;cursor:pointer}
.ss-seg{display:inline-flex;border:1px solid var(--ss-line);border-radius:9px;padding:2px;gap:2px;background:var(--dsw-alias-bg-layer-1,#fff);flex:none;align-self:center}
.ss-seg-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 12px;cursor:pointer;font-size:12.5px;line-height:1.5;font-weight:500;border-radius:7px;transition:color .15s,background .15s}
.ss-seg-btn+.ss-seg-btn{border-left:0}
.ss-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.ss-seg-btn.on{background:color-mix(in srgb,var(--ss-accent) 10%,transparent);color:var(--ss-accent-strong);font-weight:600}
/* 二级分区：分段控件是"换分区"，用浅色选中；一级页签已经是下划线，两者不会混。
 * 这里不再给分段加实心强调色 —— 实心色是"筛选条件"的语言。 */
.ss-subbar .ss-seg-btn.on{background:color-mix(in srgb,var(--ss-accent) 10%,transparent);color:var(--ss-accent-strong);font-weight:600}
.ss-input:focus{border-color:var(--ss-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ss-accent) 12%,transparent)}
input.ss-input{flex:1;min-width:160px}
select.ss-input{flex:none;cursor:pointer}
/* 带清除按钮的搜索框：包一层只为定位，宽度行为跟裸 input 保持一致 */
.ss-inputwrap{position:relative;display:flex;flex:1;min-width:140px}
.ss-inputwrap > .ss-input{flex:1;min-width:0;padding-right:30px}
/* 没有 × 的时候不用给它留位置（留了就是一块点不到的空档） */
.ss-inputwrap[data-clear="0"] > .ss-input{padding-right:14px}
.ss-input-clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}
.ss-input-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 来源内部的子工具栏（搜索 / 排序 / 只看未导入 / 批量导入）+ 批量条。
 * 类名不能叫 .ss-subbar —— 那是二级页签（技能/插件…）的容器，早就占了。
 * 用 flex-wrap 而不是写死一行：面板收窄时这几个控件要能自己掉到下一行，
 * 不然会横向溢出（同一个坑见 .ss-grid3 的注释）。 */
.ss-listbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0}
.ss-listbar > .ss-inputwrap{flex:1 1 200px;min-width:0}
.ss-batchbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin-bottom:10px;border:1px solid var(--ss-glass-border);background:var(--ss-glass-bg);border-radius:10px}
.ss-batch-count{font-size:12px;font-weight:600;white-space:nowrap}
.ss-batch-policy{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ss-batch-label{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ss-batch-result{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;margin-bottom:10px}
.ss-batch-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ss-check{width:15px;height:15px;flex:none;margin:0;cursor:pointer;accent-color:var(--ss-accent)}
.ss-check:disabled{cursor:default}
.ss-item[data-picked]{border-color:var(--ss-accent);background:color-mix(in srgb,var(--ss-accent) 8%,transparent)}
.ss-btn{height:var(--ss-ctl-h);padding:0 13px;font-size:13px;border:1px solid var(--ss-line);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .15s,border-color .15s,color .15s}
.ss-btn:hover:not(:disabled){border-color:var(--ss-line-strong);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ss-btn:disabled{opacity:.45;cursor:default}
/* 一屏只留一个实心主操作。取消阴影：色块本身已经够重，再发光就变成"卡片在发蓝光"。 */
.ss-btn[data-primary]{background:var(--ss-accent-strong);color:var(--ss-on-accent);border-color:transparent;box-shadow:none}
.ss-btn[data-primary]:hover:not(:disabled){opacity:.9;background:var(--ss-accent-strong);color:var(--ss-on-accent);box-shadow:none}
.ss-btn[data-danger]{color:var(--ss-danger);border-color:color-mix(in srgb,var(--ss-danger) 35%,transparent);background:transparent}
.ss-btn[data-danger]:hover:not(:disabled){color:var(--dsw-alias-label-primary-inverted,#fff);background:var(--ss-danger);border-color:transparent}
/* 「更多」：一个方点按钮 + 浮层菜单。低频动作收进去，工具栏只留主操作。 */
.ss-more{position:relative;flex:none}
/* 窄屏直排版的壳：display:contents 让它在布局里消失，
 * 三个小按钮直接参与工具栏的 flex 换行，和视图切换并排。 */
.ss-more-inline{display:contents}
.ss-btn-icon{width:var(--ss-ctl-h);padding:0;font-size:16px;line-height:1;letter-spacing:1px}
.ss-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:70;min-width:176px;padding:5px;border-radius:10px;border:1px solid var(--ss-line);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 10px 28px -12px #00000059;display:flex;flex-direction:column;gap:2px}
.ss-menu-item{border:0;background:none;text-align:left;padding:8px 10px;border-radius:7px;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.ss-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ss-menu-item:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
/* 筛选行：跟列表标题同一行的高度，用文字按钮而不是再占一行控件 */
.ss-push-right{margin-left:auto}
.ss-textbtn{border:0;background:none;padding:2px 0;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.ss-textbtn:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:2px}
.ss-textbtn[data-active]{color:var(--ss-accent-strong);font-weight:600}
/* 卡片里没有内容的状态行不要留空（否则每张卡都多出一条 12px 的空档） */
.ss-card .ss-chips:empty{display:none}
.ss-chips{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
/* 卡片里的 chips 由 .ss-card 的 gap 统一控制间距，别再叠底边距 */
.ss-card .ss-chips{margin-bottom:0;gap:8px}
.ss-chip{padding:6px 16px;font-size:13px;border:1px solid var(--ss-glass-border);border-radius:999px;background:var(--ss-glass-bg-strong);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color .2s,border-color .2s,background-color .2s}
.ss-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--ss-accent)}
.ss-chip[data-active]{background:var(--ss-accent-strong);color:var(--ss-on-accent);border-color:transparent;font-weight:500;box-shadow:0 2px 8px color-mix(in srgb,var(--ss-accent) 35%,transparent)}
/* 列表 = 一个容器 + 发丝分隔线。
 * 之前每行都是独立描边卡片（14 行 = 14 个盒子 + 14 圈边框 + 14 层阴影），
 * 视觉上像 14 张互不相干的卡；现在收进一个容器，行与行之间只有一条线。 */
.ss-list{display:flex;flex-direction:column;gap:0;border:1px solid var(--ss-line);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
/* 市场/其他Agent 的卡片网格 */
.ss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
/* 其他Agent：来源选择卡片 */
.ss-src-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-top:14px}
.ss-src-card{display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#000) 20%,transparent);background:var(--ss-glass-bg);cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .2s}
.ss-src-card:hover{border-color:var(--ss-accent);transform:translateY(-2px)}
.ss-src-card[data-missing]{opacity:.5;cursor:default}
.ss-src-card:focus-visible{outline:2px solid var(--ss-accent);outline-offset:2px}
.ss-src-card[data-missing]:hover{transform:none;border-color:var(--ss-glass-border)}
.ss-src-card-head{display:flex;align-items:center;gap:12px}
.ss-src-card-head .ss-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ss-src-card-head > div:nth-child(2){margin-right:2px}
.ss-src-card-head .ss-avatar{width:44px;height:44px;font-size:18px}
.ss-src-card-count{flex:none;align-self:center;padding:4px 10px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgb(128 128 128 / 10%));font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ss-src-card-label{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:2px}
/* 来源图标（img 或字母方块）：必须限死尺寸，否则原图撑爆屏幕。
 * 字母方块以前是蓝紫渐变（135deg #0a63d6→#4b49c9）+ 蓝色发光——
 * 那是 antislop R-01 点名的"默认 AI 配色"（蓝紫渐变当默认底色），
 * 而且每个头像都发光违反 R-13。现在改成中性的实心底：
 * 色相不参与表意（首字母只是占位），所以它不该吸引注意力，
 * 只靠字重和对比度让人认出是"首字母块"即可。 */
.ss-icon{width:44px;height:44px;border-radius:12px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-3,var(--ss-glass-bg-strong));box-shadow:none}
.ss-icon[data-letter]{display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:16px;background:var(--dsw-alias-bg-layer-3,var(--ss-glass-bg-strong));box-shadow:none;border:0}
/* 卡片：只留一层描边，不加投影。
 * 原来的 inset 高光 + 双层投影是 iOS 玻璃卡的画法，但一屏 6-9 张卡同时投影，
 * 页面看起来像浮了一地；而且 hover 再换一次阴影，滚动时整屏都在闪。
 * 现在 hover 只换描边颜色，卡本身不动。 */
.ss-card{
  display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:12px;
  border:1px solid var(--ss-line);background:var(--dsw-alias-bg-layer-1,#fff);
  box-shadow:none;
  transition:border-color .15s ease
}
.ss-card:hover{border-color:var(--ss-line-strong);box-shadow:none}
.ss-card-head{display:flex;align-items:center;gap:10px;min-width:0}
.ss-card-id{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
/* 卡片头像收小一号：44px 是给来源选择页的，内容卡片 34px 刚好 */
.ss-card-head .ss-avatar{width:32px;height:32px;font-size:12.5px;border-radius:9px;box-shadow:none}
/* 头像 = 名称首字母的占位块。以前是蓝紫渐变 + 蓝色发光（同 .ss-icon[data-letter]
 * 的问题，R-01/R-13），现在改为中性描边块。
 * 这里刻意**不做**"按名字哈希出彩色"那套：本机 14 个插件里 11 个首字母撞脸
 * （@scope/... 全剥成同一个字母），随机配色只会制造噪声，不会增加辨识度。 */
.ss-avatar{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:16px;flex:none;background:var(--dsw-alias-bg-layer-3,var(--ss-glass-bg-strong));box-shadow:none;border:0}
.ss-card-title{font-weight:600;font-size:13.5px;line-height:1.5;min-width:0;display:flex;align-items:center;gap:8px}
/* 技能名普遍很长，而且区别常在中间
 * （android-emulator-adb-testing vs android-emulator-testing 尾部省略后完全一样），
 * 所以卡片里允许两行 + 悬停看全名（.ss-name 上都挂了 title）。 */
.ss-card-title .ss-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:normal}
.ss-card[data-disabled]{opacity:.78}
.ss-item[data-disabled]{opacity:.78}
.ss-card-desc{font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;min-height:40px}
.ss-card-desc[data-zh]{color:var(--dsw-alias-label-primary)}
/* 描述行数截断：卡片 2 行、行 1 行，高度才齐 */
.ss-clamp2{-webkit-line-clamp:2;min-height:40px}
.ss-clamp1{-webkit-line-clamp:1;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:20px}
/* 插件市场：搜索行 + 筛选浮层 */
.ss-pop-wrap{position:relative;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.ss-btn-on{border-color:var(--ss-accent);color:var(--ss-accent);background:color-mix(in srgb,var(--ss-accent) 8%,var(--ss-glass-bg-strong))}
.ss-pop-mask{position:fixed;inset:0;z-index:55}
.ss-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:60;min-width:360px;max-width:88vw;padding:14px 16px;border-radius:14px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#000) 22%,transparent);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 12px 40px #0000002e}
.ss-pop-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 0}
.ss-pop-row+.ss-pop-row{border-top:1px solid var(--ss-glass-border)}
.ss-pop-label{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:66px;flex:none}
.ss-pop-foot{display:flex;justify-content:flex-end;padding-top:10px;margin-top:4px;border-top:1px solid var(--ss-glass-border)}
.ss-pop-chip{font-size:12px;padding:4px 11px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#000) 20%,transparent);background:var(--ss-glass-bg-strong);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color .18s,border-color .18s,background-color .18s}
.ss-pop-chip:hover{border-color:var(--ss-accent);color:var(--ss-accent)}
.ss-pop-chip.on{background:var(--ss-accent-strong);border-color:transparent;color:var(--ss-on-accent)}
/* 分类标签条 */
.ss-catbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px}
/* 卡片脚部：margin-top:auto 让它永远是卡片最底一行，同一网格里所有卡片
 * 的操作按钮因此底部对齐在一条视觉线上（参考 skills-management 的做法）；
 * border-top 把「信息区 / 操作区」分开，否则按钮和描述会黏在一起。 */
.ss-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid var(--ss-line);flex-wrap:wrap}
/* 脚部只剩一组操作时贴右：space-between 对单个子元素会把它顶到左边，
 * 同一网格里就会出现「有的卡按钮在左、有的在右」。 */
.ss-foot > :only-child{margin-left:auto}
/* 归属信息（来源/分类/AI 状态）：纯文字，不加胶囊底。
 * 胶囊是"需要被扫到的状态"（可更新/被覆盖/已停用）专用；
 * 来源和分类属于解释性信息，给它们描边只是让每一行多出四五个盒子。 */
.ss-chip2{display:inline-flex;align-items:center;gap:4px;padding:0;border-radius:0;background:none;border:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.ss-chip2.accent{color:var(--ss-accent-strong);border:0}
.ss-chip2.ok{color:var(--ss-ok);border:0}
/* 真正需要被看见的状态才给底色 */
.ss-chip2.upd{color:var(--ss-warn);border:0;background:color-mix(in srgb,var(--ss-warn) 13%,transparent);padding:1px 8px;border-radius:999px;font-weight:500}
.ss-rowbtns{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
/* 列表行：容器里的一条，不是一张卡。hover 只换底色，不换边框、不投影。 */
.ss-item{display:flex;gap:12px;align-items:center;flex-wrap:nowrap;padding:12px 14px;border-radius:0;background:transparent;border:0;border-top:1px solid var(--ss-line);box-shadow:none;transition:background .15s ease}
.ss-item:first-child{border-top:0}
.ss-item:hover{border-color:var(--ss-line);background:var(--dsw-alias-interactive-bg-hover)}
/* 行内头像与卡片同尺寸 */
.ss-item .ss-icon{width:34px;height:34px;font-size:13.5px;border-radius:9px;box-shadow:none}
.ss-name{font-size:14px;font-weight:600;line-height:1.5;min-width:0;overflow-wrap:anywhere}
.ss-name[data-link]{cursor:pointer}
.ss-name[data-link]:hover{text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-primary)}
.ss-name-row{display:flex;align-items:center;gap:8px;margin-bottom:2px;min-width:0;flex-wrap:wrap}
.ss-name-row .ss-name{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:normal}
.ss-main{flex:1;min-width:0}
/* 行右侧操作区：横排，永远靠右对齐；窄时整体换行而不是各自乱掉 */
.ss-side{display:flex;flex-direction:row;align-items:center;justify-content:flex-end;gap:8px;flex:none;flex-wrap:wrap}
.ss-stat{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;gap:4px;align-items:center;white-space:nowrap}
.ss-src{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;opacity:.7}
/* 关键词/触发场景：纯文字，不再做成一个个描边小方块。
 * 一个技能挂 4 个关键词就是 4 圈边框 —— 列表里 14 行等于 56 个盒子。 */
.ss-tag{font-size:11.5px;padding:0;border-radius:0;background:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ss-tag[data-verified]{background:none;color:var(--ss-ok)}
.ss-tag[data-apikey]{background:none;color:var(--ss-warn)}
/* 关闭态标签：降透明度即可，不再用虚线框（虚线和"失败"共用一种视觉语言） */
.ss-tag[data-off]{background:0 0;border:0;color:var(--dsw-alias-label-tertiary);opacity:.85}
/* 行内状态文字：停用 / 本面板 / 已导入这类「一个词说明状态」的位置。
 * 刻意不做成胶囊：一屏十几行、每行两三个胶囊，就是之前那种杂乱感的来源。 */
.ss-state{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* 一行解释（比如本面板为什么不能停用）：只在真需要说明时出现 */
.ss-note{margin-top:4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
/* 设置页内联徽标（此前用了类名但没写样式，渲染成裸文本） */
.ss-badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--ss-line);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.ss-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace);margin-top:4px;word-break:break-all}
.ss-desc{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
/* 列表行只留一行描述：列表用来扫和操作，细读去详情 */
.ss-item .ss-desc{-webkit-line-clamp:1;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 行内补充信息：单一小字行，用 · 分隔，不再每条一个盒子 */
.ss-metaline{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;display:flex;gap:0;align-items:center;white-space:nowrap;overflow:hidden}
.ss-metaline > span{display:inline-flex;align-items:center;min-width:0}
.ss-metaline > span + span::before{content:"·";margin:0 6px;color:var(--dsw-alias-label-tertiary)}
.ss-desc[data-zh]{color:var(--dsw-alias-label-primary)}
.ss-mini{height:var(--ss-ctl-h);padding:0 10px;font-size:12px;border-radius:7px;border:1px solid var(--ss-line);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s,color .15s}
.ss-mini:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--ss-line-strong);background:var(--dsw-alias-interactive-bg-hover)}
.ss-mini:disabled{opacity:.45;cursor:default}
/* 破坏性小按钮（删除 / 彻底删除）：平时跟普通按钮同色，hover 才变红。
 * 一屏 14 行的列表里挂 14 个红色描边按钮，红色本身就成了背景噪音；
 * 破坏性操作靠 hover/focus 的反馈 + 确认框就够拦人了。 */
.ss-mini[data-danger]{color:var(--dsw-alias-label-secondary)}
.ss-mini[data-danger]:hover:not(:disabled){color:var(--dsw-alias-label-primary-inverted,#fff);background:var(--ss-danger);border-color:var(--ss-danger)}
/* 只读来源的可见性开关：看得出来是开关，但点不动 */
.ss-switch.readonly{cursor:default;opacity:.55}
.ss-switch.readonly input{cursor:default}
/* 回收站里的残缺项（目录已被手动删掉，只剩一条记录） */
.ss-item[data-broken]{opacity:.75;border-style:dashed}
.ss-trash-when{font-family:var(--dsw-font-family-mono,monospace)}
/* 溯源块（详情页）：来源 / 导入时间 / 来源是否还在 / 同名来源 */
.ss-origin{margin:8px 0;padding:8px 10px;border:1px solid var(--ss-glass-border);background:var(--ss-glass-bg);border-radius:10px;display:flex;flex-direction:column;gap:6px}
.ss-origin-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;min-width:0}
.ss-origin-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22ch}
.ss-origin-when{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.ss-origin-avail{font-size:11px;color:var(--ss-ok)}
.ss-origin-avail[data-gone]{color:var(--ss-warn)}
/* 已禁用 / 部分禁用 徽章：用琥珀色而不是灰虚线——data-off 那套是"失败"用的，
   两者同时出现时必须一眼分开 */
.ss-tag.ss-off{background:color-mix(in srgb,var(--ss-warn) 16%,transparent);color:var(--ss-warn);border:0}
/* 详情页的"高级：分别控制两个面"块（<details>，默认折叠） */
.ss-adv{margin:10px 0 14px;padding:10px 12px;border:1px solid var(--ss-glass-border);background:var(--ss-glass-bg);border-radius:10px}
.ss-adv-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ss-adv-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ss-adv-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.ss-adv-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.9;margin-top:8px;line-height:1.5}
/* 折叠态：这是个低频治理开关，不该压在正文之上抢位置。
 * 摘要行本身就能看出状态（后面跟着"已禁用/部分禁用"胶囊），展开才见两个开关。
 * 自绘三角：原生三角在 flex 布局里位置很飘，不同浏览器还不一样。 */
.ss-adv > summary{cursor:pointer;user-select:none;list-style:none}
.ss-adv > summary::-webkit-details-marker{display:none}
.ss-adv > summary::after{content:"▾";margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.7;transition:transform .2s ease}
.ss-adv[open] > summary::after{transform:rotate(180deg)}
.ss-adv[open] > summary{margin-bottom:8px}
.ss-adv > summary:hover .ss-adv-title{color:var(--ss-accent-strong,var(--ss-accent))}
.ss-adv > summary:focus-visible{outline:2px solid var(--ss-accent);outline-offset:2px;border-radius:6px}
/* ==== 详情抽屉：AI 说明区块 ====
 * 三处详情共用。左边一道强调色细条 + 极浅底，读的时候一眼分得清
 * "这段是模型总结的"和下面的原文。不用玻璃底：那套是给溯源/统计这类中性块用的，
 * AI 摘要是要抢注意力的东西，得有自己的颜色身份。 */
.ss-ai{margin:10px 0 14px;padding:11px 13px;border-radius:12px;background:color-mix(in srgb,var(--ss-accent) 6%,transparent);border:1px solid color-mix(in srgb,var(--ss-accent) 22%,transparent);border-left-width:3px}
.ss-ai-head{display:flex;align-items:center;gap:7px;margin-bottom:7px}
.ss-ai-badge{font-size:10px;font-weight:700;letter-spacing:.04em;line-height:1;padding:3px 6px;border-radius:6px;background:var(--ss-accent);color:var(--ss-on-accent,#fff)}
.ss-ai-title{font-size:12.5px;font-weight:600;color:var(--ss-accent-strong,var(--ss-accent))}
.ss-ai-summary{font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ss-ai-row{display:flex;gap:8px;margin-top:8px;font-size:12.5px;line-height:1.6;align-items:flex-start}
.ss-ai-key{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.9;padding-top:2px}
.ss-ai-val{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;min-width:0}
.ss-ai-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
/* 未分析态：中性底。这时候没有任何"AI 的结论"可看，用强调色会像是已经分析过了 */
.ss-ai-empty{background:var(--ss-glass-bg);border-color:var(--ss-glass-border)}
.ss-ai-empty .ss-ai-badge{background:var(--dsw-alias-label-secondary);opacity:.75}
.ss-ai-empty .ss-ai-title{color:var(--dsw-alias-label-secondary)}
/* 抽屉里的状态胶囊行：贴着头像下面一排，和正文之间留点气 */
.ss-drawer-body .ss-chips.ss-drawer-tags{margin:0 0 12px}
/* 插件市场详情里的"高危能力"提示：琥珀色。和 .ss-ai / .ss-privacy 的强调色分开 ——
 * 这条说的是"这个插件要动你的东西"，比一般提示更该被看见。 */
.ss-warnbox{margin:10px 0;padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--ss-warn) 10%,transparent);border:1px solid color-mix(in srgb,var(--ss-warn) 35%,transparent);border-left-width:3px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ss-warnbox b{color:var(--ss-warn)}
/* 版本例外命令：等宽、可换行、可选中复制 */
.ss-warn-fix{margin-top:8px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ss-warn-fix code{font-family:var(--dsw-font-family-mono,monospace);background:color-mix(in srgb,var(--ss-warn) 10%,transparent);border-radius:4px;padding:3px 6px;overflow-wrap:anywhere;user-select:text}
/* 抽屉里的小节标签（"能力" / "简介"），比正文低一级 */
.ss-drawer-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:14px 0 6px}
/* 详情页头部：技能名 + 路径（.ss-meta 是等宽小字，名字要反着来）。
 * .ss-meta-name 是被 .ss-meta 包裹的子选择器（挂父类上），JS 侧不会直接引用 —— 保留。 */
.ss-meta .ss-meta-name{font-size:13px;font-weight:600;font-family:inherit;color:var(--dsw-alias-label-primary)}
.ss-meta .ss-meta-sub{font-family:var(--dsw-font-family-mono,monospace);font-size:11px;margin-top:2px}
.ss-pager{display:flex;gap:10px;align-items:center;justify-content:center;margin-top:16px}
.ss-pre{white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-family-mono,monospace);font-size:12px;line-height:1.6;background:var(--ss-glass-bg-strong);border:1px solid var(--ss-glass-border);border-radius:12px;padding:14px}
/* 详情页的轻量 Markdown */
.ss-md{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);word-break:break-word}
.ss-md-h{font-weight:700;margin:14px 0 6px}
.ss-md-h[data-level="1"]{font-size:18px}
.ss-md-h[data-level="2"]{font-size:16px}
.ss-md-h[data-level="3"]{font-size:14.5px}
.ss-md-h[data-level="4"],.ss-md-h[data-level="5"],.ss-md-h[data-level="6"]{font-size:13.5px;color:var(--dsw-alias-label-secondary)}
.ss-md-p{margin:8px 0;white-space:pre-wrap}
.ss-md-ul{margin:8px 0;padding-left:20px}
.ss-md-ul li{margin:3px 0}
/* 有序列表要保住序号（README 里的操作步骤全靠它） */
.ss-md-ol{margin:8px 0;padding-left:22px;list-style:decimal}
.ss-md-ol li{margin:3px 0}
.ss-md-quote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--ss-glass-border);color:var(--dsw-alias-label-secondary)}
.ss-code{font-family:var(--dsw-font-family-mono,monospace);font-size:12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:4px;padding:1px 5px}
.ss-link{color:var(--ss-accent-strong);text-decoration:none}
.ss-link:hover{text-decoration:underline}
/* README 里的图片：徽章（shields.io/*.svg）排成小图标，截图按块级缩到抽屉宽度内。
 * 没这两条的话一张 2000px 的封面图会把 520px 的抽屉撑出横向滚动条。 */
.ss-md-img{max-width:100%;height:auto;border-radius:8px;vertical-align:middle;margin:6px 0;display:inline-block}
.ss-md-img[data-badge]{height:18px;width:auto;margin:0 4px 0 0;border-radius:3px;vertical-align:middle}
/* ==== 确认弹窗 ====
 * 从 inline 样式挪成 class，顺便补上"破坏性操作"的红色确认键。
 * 遮罩的 left/top/width/height 由 JS 按 .ss-root 的包围盒写入（见 panelBox），
 * 没量到就落回全视口。 */
.ss-modal-mask{position:fixed;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:#0008;box-sizing:border-box}
.ss-modal{width:min(440px,100%);max-height:100%;overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));border:1px solid var(--dsw-alias-border-l2,var(--ss-glass-border));border-radius:12px;padding:20px 22px;box-shadow:0 8px 30px #0004}
.ss-modal-msg{font-size:13px;line-height:1.7;margin-bottom:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.ss-modal-btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}

/* ---------------------------------------------------------------
 * 把边框/阴影从主题皮肤手里夺回来（抽屉 + 确认弹窗）。
 *
 * 问题同「+ 技能」浮层：两者自己声明了外观，却被
 * @smalltailqwq 的 maid-atelier 皮肤按 role 覆盖掉。皮肤那条规则是
 *
 *   body[data-dsh-maid-atelier] :is(dialog,[role=dialog],[role=alertdialog],...)
 *   { border-color:#c5a46885; box-shadow:var(--maid-shadow) }
 *
 * :is() 取参数中最高的特异度，[role=dialog] 是 (0,1,0)，加上 body 与
 * [data-dsh-maid-atelier] 合起来 (0,2,1)；暗色主题那套再多一个 body 属性，
 * 是 (0,3,1)。而 .ss-drawer / .ss-modal 只有 (0,1,0) —— 全数输掉，
 * 于是抽屉的 -8px 横向投影被换成四周均匀投影、弹窗被描上一圈金边。
 *
 * 这里给出的选择器是 (0,4,0)（四个属性/类各计 (0,1,0)），高过暗色的 (0,3,1)。
 * 之所以写得这么啰嗦，是因为没有更干净的办法在不改第三方皮肤的前提下
 * 赢过一条按 role 命中的规则 —— 只能在同一个 role 上叠更高的特异度。
 * 属性一个一个写出来（而不是 :is() 里塞多个）是为了让特异度可数、可复核。
 * --------------------------------------------------------------- */
.ss-drawer[role=dialog][aria-modal="true"]:is([role=dialog]){
  box-shadow:-8px 0 40px #0005
}
.ss-modal[role][aria-modal="true"]:is([role=dialog],[role=alertdialog]){
  border:1px solid var(--dsw-alias-border-l2,var(--ss-glass-border));
  box-shadow:0 8px 30px #0004
}
/* 分析失败：默认只露一行，展开看完整错误并可复制 */
.ss-fail{margin:6px 0;font-size:11px;color:var(--ss-danger)}
.ss-fail summary{cursor:pointer;word-break:break-all}
.ss-fail-body{margin:6px 0;white-space:pre-wrap;word-break:break-all;background:color-mix(in srgb,var(--ss-danger) 12%,transparent);border-radius:8px;padding:8px;font-family:var(--dsw-font-family-mono,monospace);line-height:1.5;max-height:200px;overflow:auto}
.ss-center{text-align:center;padding:36px 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.8}
/* 空状态：光一行灰字，用户分不清"是搜没了"还是"本来就没有"，
 * 所以补一个标题 + 查询词回显 + 一键清除。 */
.ss-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:6px}
.ss-empty-q{display:inline-block;max-width:60ch;padding:3px 10px;border-radius:8px;background:var(--ss-glass-bg-strong);border:1px solid var(--ss-glass-border);font-family:var(--dsw-font-family-mono,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
/* 提示条。
 * 之前是两行裸文字：成功只闪一下、失败却把整份 pnpm 日志（实测 1202 字符）铺满
 * 面板 —— 用户的原话是"失败了就大面积的占用ui界面出现一堆报错乱码，成功了就没有
 * 任何提示"。两个毛病都出在这里：
 *   1. 成功/失败长相全一样，成功没有存在感 → 现在都做成带底色和左边线的条，
 *      成功用 ok 色、失败用 danger 色，一眼能分。
 *   2. 没有长度上限，长文本会把界面顶乱 → 限定 max-height 并可滚动，
 *      超长时给一个「展开」开关；默认只显示前几行。
 * 同时给 role=status / aria-live，屏幕阅读器也能读到操作结果。 */
.ss-toast{display:flex;gap:10px;align-items:flex-start;margin:8px 0;padding:9px 12px;border-radius:8px;border:1px solid transparent;border-left-width:3px;font-size:12px;line-height:1.6;
  /* ★ 吸顶。
   * 之前它只是普通块级元素，位置在「工具栏之后、列表之前」。而插件列表有 15 行，
   * 用户要操作某一行时早就滚下去了 —— 于是提示渲染在**视野上方看不见的地方**。
   * 这就是「更新后虽然 UI 变动了，但为什么没有提示」的直接原因：
   * 不是没提示，是提示出现在用户看不到的位置。
   * sticky 后无论滚到哪里都贴在容器顶部。z-index 保证盖住下面的卡片。
   *
   * 刻意**不加 backdrop-filter**：本项目 R-10 规定玻璃效果最多 2 处
   * （已给 .ss-drawer-mask 与 .ss-savebar），吸顶条再来一层就是第 3 处。
   * 而且提示条本来就有不透明的语义底色（ok 8% / danger 8% 叠在面板底上），
   * 模糊对可读性没有帮助，只是白白掉帧。 */
  position:sticky;top:0;z-index:5}
.ss-toast.ok{color:var(--ss-ok);background:color-mix(in srgb,var(--ss-ok) 8%,transparent);border-color:color-mix(in srgb,var(--ss-ok) 30%,transparent);border-left-color:var(--ss-ok)}
.ss-toast.err{color:var(--ss-danger);background:color-mix(in srgb,var(--ss-danger) 8%,transparent);border-color:color-mix(in srgb,var(--ss-danger) 30%,transparent);border-left-color:var(--ss-danger)}
.ss-toast-icon{flex:none;font-weight:700;line-height:1.5}
.ss-toast-body{flex:1;min-width:0}
.ss-toast-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:4.8em;overflow:hidden}
.ss-toast-text[data-open]{max-height:16em;overflow:auto}
.ss-toast-dismiss{margin-left:auto;flex:none;background:none;border:0;color:inherit;opacity:.7;cursor:pointer;font-size:14px;line-height:1;padding:0 2px}
.ss-toast-dismiss:hover{opacity:1}
/* 兼容：其它地方仍在用 .ss-err / .ss-ok 作为行内状态文字 */
.ss-err{color:var(--ss-danger);font-size:12px;margin:8px 0;white-space:pre-wrap}
.ss-ok{color:var(--ss-ok);font-size:12px;margin:8px 0;white-space:pre-wrap}
/* 详情抽屉里的通用配置区：逐键一行（键名 / 值 / 操作）。
 * 不复用 .ss-field（那个是为设置页 label+控件横排设计的），
 * 这里键名在上、值占满宽，嵌套键才放得下。 */
/* 运行状态小圆点：抽屉标题徽标与列表行共用同一种状态色 */
.ss-live-dot{width:8px;height:8px;border-radius:50%;flex:none}
.ss-live-dot.run{background:var(--ss-ok)}
.ss-live-dot.off{background:var(--dsw-alias-label-tertiary)}
.ss-live-dot.fail{background:var(--ss-danger)}
/* 插件原生组件的宿主：不设边框/背景 —— 组件自带皮肤，
 * 容器加壳会和作者的设计打架（maid 皮肤下尤其明显）。 */
.ss-slot-host{display:flex;flex-direction:column;gap:8px;min-width:0}
.ss-slot-host > *{min-width:0}
.ss-slot-err{font-size:11px;color:var(--ss-danger);white-space:pre-wrap;overflow-wrap:anywhere}
/* 运行状态徽标：小圆点 + 两个字，与列表行的状态心智一致。
 * unknown 态（宿主服务没给数据）灰色降级，绝不显示假状态。 */
.ss-runbadge{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
.ss-runbadge .ss-live-dot{width:7px;height:7px}
.ss-runbadge.run{color:var(--ss-ok)}
.ss-runbadge.fail{color:var(--ss-danger)}
.ss-runbadge.unknown .ss-live-dot{opacity:.4}
/* 折叠区（README）：整行可点，右侧一个方向箭头。
 * 原来的原生三角标记只有 8px，在 1100px 宽的页面里几乎看不见，
 * 用户根本不知道下面还有内容。 */
.ss-more{margin:0}
.ss-more > summary{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none;padding:11px 0;display:flex;align-items:center;gap:8px;list-style:none}
.ss-more > summary::-webkit-details-marker{display:none}
.ss-more > summary::after{content:"";width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);margin-left:auto;margin-right:4px;transition:transform .18s ease}
.ss-more[open] > summary::after{transform:rotate(-135deg)}
.ss-more > summary:hover{color:var(--dsw-alias-label-primary)}
.ss-more[open] > summary{border-bottom:1px solid var(--ss-line);margin-bottom:10px}
/* 二级页面（插件详情）：一屏只讲一个插件。
 * 排版按官方插件页的同一套规矩：20px 标题、14px 正文、32px 分区间距。
 * 宽度策略分三档（不是一条 max-width 了事）：
 *   默认（<1500px）：单列，内容封在 1120px 并居中；
 *   xwide（>=1500px，最大化/超宽屏）：正文 + 360px 信息侧栏两列，整体封 1400px；
 *   窄屏：头部操作条从右侧掉到身份区下方。
 * 之前详情 fixed 880px 且不居中 —— 2560 窗口下右边直接空掉 1400px。 */
.ss-detail{display:flex;flex-direction:column;gap:22px;padding:2px 0 32px;width:100%;max-width:1120px;margin:0 auto}
.ss-back{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;background:none;border:0;padding:2px 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:4px}
.ss-back:hover{color:var(--dsw-alias-label-primary)}
.ss-back:focus-visible{outline:2px solid var(--ss-accent);outline-offset:2px}
.ss-back-arrow{font-size:15px;line-height:1;margin-top:-1px}
/* 头部三列：头像 / 身份 / 操作。操作贴右，不再单独占一整行。 */
.ss-detail-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px 20px;align-items:start;padding-bottom:18px;border-bottom:1px solid var(--ss-line)}
.ss-detail-avatar{width:44px;height:44px;font-size:17px;border-radius:12px;flex:none}
.ss-detail-id{display:flex;flex-direction:column;gap:6px;min-width:0}
.ss-detail-title-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
.ss-detail-title{margin:0;font-size:20px;font-weight:500;line-height:28px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ss-detail-version{font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family-mono,monospace);font-variant-numeric:tabular-nums}
.ss-detail-meta{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.ss-detail-desc{margin:2px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);max-width:74ch}
.ss-detail-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-self:end;align-self:start;max-width:100%}
.ss-detail-actions .ss-detail-danger{margin-left:0}
/* 主体：单列默认；xwide 变两列，侧栏承接宽屏空白 */
.ss-detail-body{display:grid;grid-template-columns:minmax(0,1fr);gap:24px 32px}
.ss-detail-main{display:flex;flex-direction:column;gap:24px;min-width:0}
.ss-detail-aside{min-width:0;display:flex;flex-direction:column;gap:10px}
.ss-detail-section{display:flex;flex-direction:column;gap:10px}
.ss-detail-section-title{margin:0;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ss-detail-section-hint{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
/* 「信息」事实表：官方插件详情同款，左标签右值，最小 42px 行高 */
.ss-facts{margin:0;border-top:1px solid var(--ss-line)}
.ss-fact{display:flex;align-items:baseline;justify-content:space-between;gap:16px;min-height:42px;padding:9px 0;border-bottom:1px solid var(--ss-line);font-size:13px;line-height:20px}
.ss-fact dt{flex:none;color:var(--dsw-alias-label-secondary)}
.ss-fact dd{margin:0;min-width:0;text-align:right;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.ss-fact code{font-family:var(--dsw-font-family-mono,monospace);font-size:12px;background:var(--dsw-alias-bg-layer-3,var(--ss-glass-bg-strong));border-radius:4px;padding:1px 6px}
.ss-detail-readme{border:1px solid var(--ss-line);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 14px}
.ss-detail-readme > summary{padding:11px 0}
.ss-detail-readme > div{max-height:420px;overflow:auto;padding-bottom:12px;max-width:74ch}
/* 批量分析的进度条：一个分析要跑几分钟，至少让人看见在动 */
.ss-progress{height:3px;border-radius:2px;background:var(--ss-glass-border);overflow:hidden;margin:8px 0 4px}
.ss-progress > i{display:block;height:100%;background:var(--ss-accent);border-radius:2px;transition:width .25s ease}
.ss-field{display:grid;grid-template-columns:104px minmax(0,1fr);gap:12px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.ss-field > label{font-size:12.5px;min-width:0;color:var(--dsw-alias-label-secondary);flex:none}
/* 设置页的分区大块。这里**不用** backdrop-filter：
 * 文件上方 .ss-card 的注释已经立了规矩 ——「backdrop-filter 在大面积上很贵，
 * 模糊留给容器/抽屉这类小面积元素」，而 .ss-section 恰恰是可能很长的大块，
 * 一页四个分区同时采样就是白白掉帧。
 * 现在全插件的模糊只剩两处，且各有实际理由（antislop R-10 的剂量上限是 1-2）：
 *   .ss-drawer-mask —— 抽屉遮罩，模糊是"前后景分层"的信号；
 *   .ss-savebar     —— 吸附保存条，正文会从它下面滚过去，模糊防止两行字互相干扰。 */
/* 设置分区：一层描边 + 白底，和列表容器同一套线。
 * 不再用半透明玻璃底：这里一屏四五个分区叠着，玻璃底会让下层文字隐约透出来。 */
/* box-sizing 必须显式写：.ss-root 上有，但子组件不继承。
 * 漏写的后果（实测）：.ss-section 宽 990 而父级 .ss-body 只有 952，
 * 越出 16px —— 正好是左右各 20px 的 padding。默认 content-box 下
 * width 不含 padding/border，于是"宽度刚好"的元素总比父级宽一圈。
 * 给设置页两个直接子块补上；savebar 同因（越出 4px = 左右各 1px 边框 + 2px）。 */
.ss-section{border:1px solid var(--ss-line);border-radius:12px;padding:18px 20px;margin-bottom:16px;background:var(--dsw-alias-bg-layer-1,#fff);box-sizing:border-box;max-width:100%}
.ss-section h3{margin:0 0 3px;font-size:14px;font-weight:600;line-height:20px}
.ss-section p{margin:0 0 14px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;max-width:74ch}
.ss-switch{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;flex:none;color:var(--dsw-alias-label-primary);white-space:nowrap}
/* 开关旁的文字标签：详情页用，光一个滑块看不出控制的是什么 */
.ss-switch-text{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
/* 开关：iOS 风胶囊滑块。
 * 用 appearance:none 把原生 checkbox 的框直接画成轨道，而不是外面套一层 div 再把 input 藏掉 ——
 * 这样键盘空格切换、读屏朗读 checked、:disabled 灰化全是白拿的，换成 div 模拟就得自己补一套，
 * 而本插件没有任何测试能覆盖键盘行为。
 * 颜色绑 --ss-accent：全插件只有一个强调色，换肤和深色主题自动跟上，
 * 不必再写一条 body[data-ds-dark-theme] 覆盖。 */
.ss-switch input[type=checkbox]{
  appearance:none;-webkit-appearance:none;margin:0;padding:0;flex:none;position:relative;
  width:40px;height:22px;border-radius:999px;cursor:pointer;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary) 34%,transparent);
  transition:background-color .2s ease;
}
/* 圆钮用 transform 位移而不是改 left：走合成层，不触发重排 */
.ss-switch input[type=checkbox]::after{
  content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;
  background:#fff;box-shadow:0 1px 3px #00000038,0 0 0 .5px #00000014;
  transition:transform .2s cubic-bezier(.32,.72,0,1);
}
.ss-switch input[type=checkbox]:checked{background:var(--ss-accent)}
.ss-switch input[type=checkbox]:checked::after{transform:translateX(18px)}
.ss-switch:hover input[type=checkbox]:not(:disabled){box-shadow:0 0 0 3px color-mix(in srgb,var(--ss-accent) 14%,transparent)}
.ss-switch input[type=checkbox]:focus-visible{outline:2px solid var(--ss-accent);outline-offset:2px}
.ss-switch input[type=checkbox]:disabled{cursor:default;opacity:.45}
/* 来源行：列对齐。原来是 flex 自由分配，四行的"路径"和"类型"各自落在不同位置，
 * 一眼扫过去像四行不同的表单。现在开关 / 名称 / 路径 / 类型 / 操作固定五列。 */
.ss-srcrow{display:grid;grid-template-columns:auto minmax(110px,0.9fr) minmax(160px,1.4fr) 132px auto;gap:8px;align-items:center;padding:9px 0;border-top:1px solid var(--ss-line)}
.ss-srcrow .ss-input{height:var(--ss-ctl-h);min-width:0;width:100%}
/* 窄面板：开关/名称一行，路径/类型/操作一行 */
@media (max-width:900px){
  .ss-srcrow{grid-template-columns:auto minmax(0,1fr) auto}
}
.ss-group-title{font-size:13px;font-weight:600;margin:2px 0 10px;padding:0;border:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ss-group-hint{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.ss-path{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace)}
/* 详情抽屉 */
.ss-drawer-mask{position:fixed;inset:0;background:#0006;z-index:9998;backdrop-filter:blur(2px)}
.ss-drawer{position:fixed;top:0;right:0;bottom:0;width:520px;max-width:90vw;background:var(--dsw-alias-bg-layer-1,#fff);z-index:9999;display:flex;flex-direction:column;box-shadow:-8px 0 40px #0005;animation:ssSlideIn .25s ease-out}
@keyframes ssSlideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
.ss-drawer-head{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid var(--ss-glass-border);flex:none}
.ss-drawer-head .ss-avatar{width:56px;height:56px;font-size:22px;border-radius:14px}
.ss-drawer-body{flex:1;min-height:0;overflow:auto;padding:18px 20px}
.ss-drawer-foot{flex:none;padding:14px 20px;border-top:1px solid var(--ss-glass-border);display:flex;gap:10px;align-items:center}
.ss-drawer-title{font-size:18px;font-weight:700}
.ss-drawer-handle{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.ss-drawer-subtitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow-wrap:anywhere}
.ss-detail-subtitle{font-size:13px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow-wrap:anywhere}
.ss-close{margin-left:auto;background:0 0;border:none;font-size:20px;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:4px 8px;border-radius:8px;line-height:1}
.ss-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 详情抽屉：统计卡片 */
.ss-stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}
.ss-stat-cell{background:var(--ss-glass-bg-strong);border:1px solid var(--ss-glass-border);border-radius:12px;padding:10px 8px;text-align:center}
.ss-stat-cell b{display:block;font-size:18px;font-weight:700;color:var(--dsw-alias-label-primary)}
.ss-stat-cell span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ss-sec-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.ss-sec-ok{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--ss-ok) 12%,transparent);color:var(--ss-ok);border:1px solid color-mix(in srgb,var(--ss-ok) 30%,transparent)}
.ss-sec-ok::before{content:"✓";font-weight:700;opacity:.75}
/* ==== 二级 hub：分段切换 ==== */
.ss-hub{display:flex;flex-direction:column;flex:1;min-height:0}
.ss-subbar{display:flex;align-items:center;gap:8px;margin:0 auto 12px;flex:none;width:100%;max-width:1120px}
@keyframes ssPulse{0%,100%{opacity:1}50%{opacity:.3}}
/* ==== 设置页：AI 通道二选一 ==== */
.ss-mode{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%}
.ss-mode-card{display:flex;flex-direction:column;gap:3px;text-align:left;padding:12px 14px;border-radius:10px;border:1px solid var(--ss-line);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .15s,background-color .15s;font:inherit}
.ss-mode-card:hover{border-color:var(--ss-line-strong)}
.ss-mode-card.on{border-color:var(--ss-accent);background:color-mix(in srgb,var(--ss-accent) 6%,var(--dsw-alias-bg-layer-1,#fff));box-shadow:none}
.ss-mode-card b{font-size:13px;font-weight:600}
.ss-mode-sub{font-size:11.5px;color:var(--ss-accent-strong)}
.ss-mode-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}
/* ==== 设置页：AI 分析的隐私提示块 ====
 * 不塞进 .ss-mode-hint 那种小灰字里 —— 这段是"按下分析之前值得停下来看一眼"的内容，
 * 混进说明文字里就等于没有。左边条用强调色，明暗主题自动跟随；
 * 不用红色：这是"请注意"不是"出错了"，红块会让人以为功能坏了。 */
.ss-privacy{display:flex;flex-direction:column;gap:3px;margin:10px 0 0;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--ss-accent) 5%,transparent);border:1px solid color-mix(in srgb,var(--ss-accent) 18%,transparent);border-left-width:3px}
.ss-privacy b{font-size:12.5px;font-weight:600;color:var(--ss-accent-strong)}
.ss-privacy span{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
/* ==== 设置页：悬浮保存条 ====
 * sticky 吸在 .ss-body 底部，滚动时一直可见；本体仍在文档流里。
 * 不再用 backdrop-filter：它下面是滚动内容，模糊反而让"哪些字属于本页、
 * 哪些是被盖住的"更难分。改成实底 + 一条描边，层级靠位置说明。 */
.ss-savebar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:10px;flex-wrap:nowrap;margin-top:6px;padding:10px 14px;border-radius:10px;border:1px solid var(--ss-line);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 -6px 16px -12px #00000040;box-sizing:border-box}
.ss-savedot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary)}
.ss-savedot[data-state=clean],.ss-savedot[data-state=saved]{background:var(--ss-ok)}
.ss-savedot[data-state=dirty],.ss-savedot[data-state=blocked]{background:var(--ss-warn)}
.ss-savedot[data-state=error]{background:var(--ss-danger)}
.ss-savedot[data-state=saving]{background:var(--ss-accent);animation:ssPulse 1.2s ease-in-out infinite}
.ss-savetext{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap}
.ss-savebar-btns{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
/* 路径占满剩余宽度并自己截断。之前是 flex-wrap:wrap + max-width:42ch，
 * 窄屏下路径被挤到第二行、按钮跑到左边，整个悬浮条看上去像散了架。 */
.ss-savepath{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace);opacity:.8;flex:1 1 auto;min-width:0;max-width:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:560px){
  /* 太窄时路径优先让位，宁可换行也别把按钮挤出去 */
  .ss-savebar{flex-wrap:wrap}
  .ss-savebar .ss-savepath{flex-basis:100%;order:9;max-width:100%}
  .ss-savebar-btns{margin-left:0}
}
/* ==== 设置页：双列字段 / 字段说明 / 试扫元信息行 ==== */
.ss-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px}
.ss-flabel{display:block;font-size:12px;margin-bottom:4px;color:var(--dsw-alias-label-secondary)}
.ss-fhint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.75;margin-top:4px}
.ss-metarow{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:12px;border-top:1px solid var(--ss-glass-border)}
.ss-metaname{font-weight:600;flex:none;min-width:88px}
.ss-metarow .ss-clamp1{flex:1;font-size:11px;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace);min-height:0}
.ss-metarow .ss-badge{margin-left:auto;flex:none}
/* 三列并排的数值字段（批量/并发/输出上限）。
 * 之前在 JSX 里写死 1fr 1fr 1fr，面板收窄到 640 时三列各自只剩 ~198px，
 * 而 input.ss-input 的 min-width 是 180px —— 加起来撑破容器，出现横向滚动条。 */
.ss-field.ss-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
@media (max-width:760px){.ss-grid3{grid-template-columns:repeat(2,minmax(0,1fr))}}
/* ==== 容器查询：窄面板下的细节修正 ====
 * 上面 data-ss-w 那套管的是"换结构"（网格列数、工具栏换行、抽屉全屏），
 * 这里管的是"细节收缩"——padding、字号、描述行数。两者目的不同：
 *   - data-ss-w 由 JS 量宽度写属性，面板刚挂载那一下还没量到，会闪一帧宽版；
 *   - @container 是纯 CSS，浏览器算完容器尺寸立即生效，无闪帧。
 * 实测（430px 容器）：.ss-desc 的 scrollWidth 693 vs clientWidth 302，
 * 两行 clamp 下每行只剩约 150px，中文描述被切掉一半以上。 */
@container (width <= 640px){
  .ss-root{padding-left:14px;padding-right:14px}
  /* 描述文字：窄容器下两行 clamp 每行太短，改成三行、字号降一档，
   * 单行 clip（列表行）保持 nowrap 但允许更激进的省略 */
  .ss-desc{font-size:12px;line-height:1.55;-webkit-line-clamp:3}
  .ss-item .ss-desc{-webkit-line-clamp:2;white-space:normal;display:-webkit-box}
  /* 金属信息行同样容易挤：允许换行 */
  .ss-metaline{flex-wrap:wrap;row-gap:2px}
  /* 头部：标题行和操作行分开，别挤在一行 */
  .ss-detail-head{grid-template-columns:minmax(0,1fr)}
  .ss-detail-actions{grid-column:1/-1;justify-self:start;margin-top:2px}
  /* 表单标签不要固定宽度，否则右边控件被推出容器 */
  .ss-field > label{min-width:0;flex-basis:auto}
  .ss-src-grid{grid-template-columns:minmax(0,1fr)}

  /* 窄容器：工具条换行后，右侧动作组（AI 分析 / 停止 / 刷新）要整体贴右，
   * 并且不许把组内最后一个按钮单独甩到下一行 —— 那是 flex-wrap 逐项换行的结果，
   * 观感是一条工具栏被劈成两半。给最后两个按钮加 margin-left:auto +
   * 让它们成为不可拆的一对：把「刷新」绑在「AI 分析」右侧，
   * 前一个按钮给 margin-left:auto 顶到右边，后一个自然跟随。 */

  /* 页签太多会横向溢出：允许滚动而不是撑破容器 */
  .ss-tabs{overflow-x:auto;scrollbar-width:none}
  .ss-tabs::-webkit-scrollbar{display:none}
  /* 详情页侧栏回到正文下方 */
  .ss-detail-body{grid-template-columns:minmax(0,1fr)}
  .ss-detail-aside{position:static}
}
/* 更窄（手机竖屏 400 上下）：进一步收紧 */
@container (width <= 420px){
  .ss-root{padding-left:10px;padding-right:10px}
  .ss-desc{font-size:11.5px;-webkit-line-clamp:3}
  .ss-grid3{grid-template-columns:minmax(0,1fr)}
  .ss-chip{padding:5px 12px;font-size:12px}
  /* 设置页来源卡片：repeat(auto-fill,minmax(260px,1fr)) 在窄容器里
   * 会按 260px 的轨道尝试建列，轨道宽度大于容器就直接溢出（实测 390px 下
   * .ss-section 被顶出 root）。改用 1fr 单列，或者让轨道本身可压缩：
   * minmax(min(260px,100%),1fr) —— 这是 grid 溢出陷阱的标准写法，
   * 容器比 260px 窄时轨道自动收缩到 100%，不会撑破父级。 */
  .ss-src-grid{grid-template-columns:minmax(min(260px,100%),1fr)}
  /* 表单输入框：固定 min-width 会把控件推出容器 */
  .ss-input{min-width:0}
  /* 来源行：5 列 grid 的最小宽度合计约 549px（开关 109 + 标签 110 +
   * 路径 160 + 下拉 132 + 徽章 38），336px 容器下 grid 只能等比压缩，
   * 标签输入框被压到 38px —— 只剩一个字母（实测截图里是 "DS"）。
   * 改成两行：第一行 开关+标签+徽章，第二行 路径+下拉 各占一半。
   * 用 grid-auto-flow:row 显式重排，比让 grid 自己挤更可控。 */
  .ss-srcrow{
    grid-template-columns:auto minmax(0,1fr) auto;
    row-gap:8px;
  }
  .ss-srcrow > .ss-input:nth-of-type(1){grid-column:2}
  .ss-srcrow > .ss-input:nth-of-type(2){grid-column:1 / -1}
  .ss-srcrow > select{grid-column:1 / -1}
}
/* 面板宽度分档（JS 量 .ss-root 的宽度写 data-ss-w，见 useWidthBucket）。
 * 补在 media query 之外，因为 media query 看视口、不看面板 —— 见那个函数的注释。 */
.ss-root[data-ss-w="narrow"] .ss-grid3,
.ss-root[data-ss-w="xs"] .ss-grid3{grid-template-columns:repeat(2,minmax(0,1fr))}
.ss-root[data-ss-w="narrow"] .ss-mode,
.ss-root[data-ss-w="narrow"] .ss-grid2,
.ss-root[data-ss-w="xs"] .ss-mode,
.ss-root[data-ss-w="xs"] .ss-grid2{grid-template-columns:1fr}
.ss-root[data-ss-w="xs"] .ss-grid3{grid-template-columns:minmax(0,1fr)}
.ss-root[data-ss-w="xs"] input.ss-input{min-width:0}
.ss-root[data-ss-w="xs"] .ss-field > label{min-width:0}
.ss-root[data-ss-w="xs"] .ss-src-grid{grid-template-columns:minmax(0,1fr)}
.ss-root[data-ss-w="xs"] .ss-drawer{width:100%;max-width:100vw}
/* 窄面板：工具栏动作先独占一行，行内操作掉到内容下方。
 * 520px 时一行塞不下「搜索 + 分类 + 更新 + 分析 + 筛选 + 视图 + 刷新」，
 * 硬塞会挤成四行、按钮还错位；让主操作成组换行更可读。 */
.ss-root[data-ss-w="xs"] .ss-toolbar-end,
.ss-root[data-ss-w="narrow"] .ss-toolbar-end{margin-left:0;width:auto}

/* 窄屏不再有 ⋯ 浮层：MoreMenu 在 xs/narrow 下直接铺成小按钮（见组件注释），
 * 所以以前的底部动作面板样式已删除。宽屏仍是原来的下拉浮层。 */
/* 行内操作（开关/更新）永远跟名称同一行：窄面板里掉到下一行会悬在描述下面，
 * 看起来像另一条记录的一部分。挤压从描述那里让（.ss-desc 有省略号）。 */
.ss-root[data-ss-w="xs"] .ss-item{align-items:center}
/* ==== 内容栏：所有页签统一居中 ====
 * 之前只有详情页有 max-width 且没居中，最大化窗口下内容全贴左边、右边空一大片。
 * 现在 .ss-body 的直接子块统一 1120px 居中；设置页表单更窄（1040）；
 * 详情页 xwide 放宽到 1400。用 margin:auto 而不是只给 max-width ——
 * 单边留白会看起来像布局坏了。
 * 必须覆盖 .ss-body > *：技能页把「分区标题 + 列表」包在 .ss-group 里，
 * 只点 .ss-list 会漏掉整块（实测 2300px 下技能页仍贴左边）。
 * 用 :where 保持 0 特异性，后代里更具体的规则（详情 xwide / 设置窄栏）都能覆盖。
 * 排除两个浮层：确认弹窗与抽屉是 fixed 定位，不能套内容宽度。 */
.ss-body > *:where(:not(.ss-modal-mask):not(.ss-drawer-mask):not(.ss-pop-mask)){width:100%;max-width:1120px;margin-left:auto;margin-right:auto}
.ss-body > .ss-section,
.ss-body > .ss-savebar{max-width:1040px}
/* xwide（>=1500px）：详情改成「正文 + 360px 信息侧栏」，侧栏吸附在顶部。
 * 这是最大化窗口下唯一值得用掉右侧空间的页面；列表仍保持一栏（行太长不好扫）。 */
.ss-root[data-ss-w="xwide"] .ss-detail{max-width:1400px}
.ss-root[data-ss-w="xwide"] .ss-detail-body{grid-template-columns:minmax(0,1fr) 360px}
.ss-root[data-ss-w="xwide"] .ss-detail-aside{position:sticky;top:8px;align-self:start}
/* 中窄屏：头部从三列变两列，操作条掉到身份区下方，避免标题被操作挤成一列字 */
.ss-root[data-ss-w="mid"] .ss-detail-head,
.ss-root[data-ss-w="narrow"] .ss-detail-head,
.ss-root[data-ss-w="xs"] .ss-detail-head{grid-template-columns:auto minmax(0,1fr)}
.ss-root[data-ss-w="mid"] .ss-detail-actions,
.ss-root[data-ss-w="narrow"] .ss-detail-actions,
.ss-root[data-ss-w="xs"] .ss-detail-actions{grid-column:1/-1;justify-self:start;margin-top:2px}
.ss-root[data-ss-w="narrow"] .ss-savebar,
.ss-root[data-ss-w="xs"] .ss-savebar{flex-wrap:wrap}
.ss-root[data-ss-w="narrow"] .ss-savepath,
.ss-root[data-ss-w="xs"] .ss-savepath{flex-basis:100%;order:9;max-width:100%}
.ss-root[data-ss-w="narrow"] .ss-savebar-btns,
.ss-root[data-ss-w="xs"] .ss-savebar-btns{margin-left:0}
/* 子工具栏在窄面板里把搜索框独占一行，排序/筛选/批量掉到下一行；
 * 批量条里的策略分段控件同样允许换行 */
.ss-root[data-ss-w="narrow"] .ss-listbar > .ss-inputwrap,
.ss-root[data-ss-w="xs"] .ss-listbar > .ss-inputwrap{flex:1 1 100%}
.ss-root[data-ss-w="xs"] .ss-listbar,
.ss-root[data-ss-w="xs"] .ss-batchbar{flex-direction:column;align-items:stretch}
.ss-root[data-ss-w="xs"] .ss-batch-policy{flex-wrap:wrap}
.ss-root[data-ss-w="narrow"] .ss-batchbar .ss-seg,
.ss-root[data-ss-w="xs"] .ss-batchbar .ss-seg{flex-wrap:wrap;border-radius:10px}
@media (max-width:640px){
  .ss-mode,.ss-grid2{grid-template-columns:1fr}
  .ss-grid3{grid-template-columns:minmax(0,1fr)}
  /* 窄屏下输入框不许再抢固定宽度，交给 flex 分配 */
  input.ss-input{min-width:0;flex:1 1 100%}
  .ss-inputwrap{min-width:0;flex:1 1 100%}
  .ss-field > label{min-width:0}
  .ss-src-grid{grid-template-columns:minmax(0,1fr)}
  .ss-drawer{width:100%;max-width:100vw}
}
/* 焦点环统一走宿主 token。以前只有抽屉/弹窗/开关/返回按钮有 :focus-visible，
 * 行内那排文字按钮（详情/卸载/更新）用键盘 Tab 过去是没有任何视觉反馈的。 */
.ss-root button:focus-visible,
.ss-root select:focus-visible,
.ss-root summary:focus-visible,
.ss-root a:focus-visible{outline:2px solid var(--ss-accent);outline-offset:2px}
/* 尊重系统的「减少动态效果」偏好。
 * 本插件只有两处动画（抽屉滑入、保存点脉冲），但它们都不承载信息 ——
 * 关掉之后状态照样读得出来（保存点仍有颜色，抽屉仍然出现，只是不再滑）。
 * 前庭功能敏感的用户开着这个系统开关时，任何位移或循环闪动都是负担。 */
@media (prefers-reduced-motion:reduce){
  .ss-drawer{animation:none}
  .ss-savedot[data-state=saving]{animation:none}
  .ss-root *{transition-duration:.01ms !important}
}

/* ================================================================
 * 「+ 技能」浮层皮肤（只改外观，不改行为）
 *
 * 这个浮层不属于本插件：@weibaohui/skills-management 用
 * ReactDOM.createPortal 把它渲染到 document.body。这里按它自己声明的
 * .sk-picker-* 类名覆盖外观，**不碰它的搜索 / 键盘 / 选中逻辑**。
 *
 * 两条自我约束：
 *   1. 每条规则都以 .sk-picker 开头 —— 不会有任何一条泄漏到别的界面。
 *   2. 不改它的 DOM 结构（只加一个 data-ss-skin 标记属性），
 *      React 重渲染不会冲突。撤掉只需删掉这一段 + apply() 里的调用。
 *
 * 为什么不做左侧头像：试过 30px 字母方块，但那让 400px 宽度里的可用文字
 * 只剩约 330px，标题+描述两行反而更挤。去掉后文字拿到整行宽度，
 * 行内才有余量做「大内边距 + 宽行距」的舒展排版 —— 这才是要解决的问题。
 * ================================================================ */
.sk-picker[data-ss-skin]{
  padding:10px;border-radius:16px;gap:10px
}

/* 把边框与阴影从主题皮肤手里夺回来。
 *
 * 背景：这个浮层自带 role="dialog"（上游 bundle.js 里写死的），而
 * @smalltailqwq 的 maid-atelier 皮肤用
 *   body[data-dsh-maid-atelier] :is(dialog,[role=dialog],...) { border-color:#c5a46885;
 *                                                              box-shadow:var(--maid-shadow) }
 * 给「对话框」刷金边和 18px/54px 的大投影。那条规则特异度 (0,2,1) 高于
 * .sk-picker 的 (0,1,0)，于是这个 400px 的下拉浮层被当成设置对话框渲染：
 * 边缘是一道金色描边，底下拖一片深色投影 —— 就是「边框阴影错乱」的样子。
 *
 * 这里补一条 (0,3,0) 的规则压过它。选择器里写上 [role=dialog] 不是笔误，
 * 而是刻意的：既然对方靠 role 命中我们，我们就靠同一个 role 把外观收回来。
 * 万一上游哪天去掉这个 role，这条规则随之失效 —— 但皮肤那条规则也同时失效，
 * 浮层会回到上游自己声明的外观，是对称的退化，不会留下半截样式。
 *
 * 取值不做新设计，就恢复 DSH 弹层的通用做法（与 git-graph 的 popover 一致）：
 * 隐形描边 + lv3 阴影，靠阴影分层而不是靠一圈硬边。
 *
 * 末尾的 :is([role=dialog]) 是刻意重复的：它把特异度抬到 (0,4,0)。
 * maid 深浅两套皮肤的同名规则最高到 (0,3,2)（暗色那套多一个 body 属性），
 * 只写 (0,3,0) 的话切到暗色主题就会重新输给它 —— 那是同一个 bug 换个主题复现。 */
.sk-picker[data-ss-skin][role=dialog]:is([role=dialog]){
  border:1px solid var(--dsw-alias-border-inverted);
  box-shadow:var(--dsw-shadow-lv3)
}
/* 搜索框：与行内边距对齐，圆角略小于浮层 */
.sk-picker[data-ss-skin] .sk-picker-input{
  min-height:36px;padding:8px 13px;border-radius:10px
}
/* 行间距 6px —— 这是「局促」最主要的来源（原来只有 3px）。
 * 6px 让每行成为可分辨的一块，又不会把 8 行列表推出浮层。 */
.sk-picker[data-ss-skin] .sk-picker-list{gap:6px;padding:0}

/* 行：单列两行 —— 上标题、下描述，各自占满整行宽度。
 * 原来是 flex 平铺 + .sk-picker-name{max-width:45%}，标题和描述挤在同一行，
 * 描述吃不到一半宽度就被截断。改成两行后描述能显示约两倍的信息量。 */
.sk-picker[data-ss-skin] .sk-picker-row{
  display:block;
  padding:11px 13px;border-radius:11px;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary) 7%,transparent);
  border:0;text-align:left
}
/* 鼠标悬停 = 预备选中；键盘选中 = data-active（由它自己维护）。
 * 两者共用同一套 business 语义色、只有深浅差别，
 * 免得「鼠标划过」和「键盘停在」看起来像两种不同的东西。 */
.sk-picker[data-ss-skin] .sk-picker-row:hover{
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent)
}
.sk-picker[data-ss-skin] .sk-picker-row[data-active="true"]{
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)
}
/* 标题：加粗、主色、单行省略。
 * 技能名普遍很长，放任两行会把行高撑得不齐。 */
.sk-picker[data-ss-skin] .sk-picker-name{
  display:block;min-width:0;max-width:none;
  font-size:13.5px;font-weight:600;line-height:1.35;
  color:var(--dsw-alias-label-primary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis
}
/* 描述：次要色、单行省略、与标题留 3px 呼吸。
 * 不再限制宽度 —— 这是改两行排版的核心收益。 */
.sk-picker[data-ss-skin] .sk-picker-desc{
  display:block;min-width:0;margin-top:3px;
  font-size:12px;line-height:1.45;
  color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis
}
.sk-picker[data-ss-skin] .sk-picker-empty{padding:16px 12px}
`;

		function ensureStyle() {
			if (document.querySelector("style[data-dsh-curator]")) return;
			const el = document.createElement("style");
			el.setAttribute("data-dsh-curator", "");
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		/**
		 * 给「+ 技能」浮层贴皮肤。
		 *
		 * 只做一件事：给 .sk-picker 容器加上 data-ss-skin 属性。
		 * CSS 里那几条规则全部以这个属性为作用域，标记一打上，外观就接管了。
		 *
		 * 为什么不能只靠 CSS：这个浮层是别的插件的 DOM，而且 portal 到
		 * document.body，没有任何稳定的父级可以让我把皮肤挂上去；
		 * 加一个自己的标记属性是最轻、也最不容易和别人打架的办法。
		 *
		 * **只写属性、不增删节点**：那个列表由 React 渲染，插节点会被下一次
		 * diff 抹掉甚至引发告警。容器本身在浮层存在期间是稳定的
		 * （React 重渲染只换它的子节点），所以给容器打标记就够了；
		 * 因此也不需要逐行处理 —— 不存在「先出空壳、后填内容」漏打标记的问题。
		 */
		function installPickerSkin(ctx) {
			if (typeof MutationObserver !== "function") return () => {};

			/** 给 root 自身或它子树里的每个 .sk-picker 打标记。 */
			function decorate(root) {
				if (!root || root.nodeType !== 1) return;
				const boxes = [];
				if (root.classList && root.classList.contains("sk-picker")) boxes.push(root);
				if (root.querySelectorAll) {
					for (const el of root.querySelectorAll(".sk-picker")) boxes.push(el);
				}
				for (const box of boxes) {
					if (box.getAttribute("data-ss-skin") !== "") {
						box.setAttribute("data-ss-skin", "");
					}
				}
			}

			const mo = new MutationObserver((records) => {
				for (const rec of records) {
					for (const node of rec.addedNodes) decorate(node);
				}
			});
			mo.observe(document.body, { childList: true, subtree: true });
			// observer 起晚时可能已有浮层挂在 body 上，先扫一遍
			decorate(document.body);

			// 用 ctx.effect 挂卸载（cordis 的标准做法）；ctx 不可用时退回裸 observer，
			// 不影响功能，只是少一层自动清理。
			try {
				ctx.effect(() => () => mo.disconnect(), "dsh-curator: picker skin");
			} catch {
				/* 没有 effect 能力时就让它留着 */
			}
			return () => mo.disconnect();
		}

		/* ================================================================ *
		 * shared components
		 * ================================================================ */

		const Btn = (props) =>
			h(
				"button",
				{
					type: "button",
					className: "ss-btn",
					onClick: props.onClick,
					disabled: props.disabled,
					title: props.title,
					...(props.primary ? { "data-primary": "" } : {}),
					...(props.danger ? { "data-danger": "" } : {}),
					// 弹窗需要把焦点主动拉进来；Btn 原先不透传任何焦点相关属性
					...(props.autoFocus ? { autoFocus: true, "data-autofocus": "" } : {}),
				},
				props.children,
			);

		const Mini = (props) =>
			h(
				"button",
				{
					type: "button",
					className: "ss-mini",
					onClick: props.onClick,
					disabled: props.disabled,
					title: props.title,
					// 删除这类破坏性小按钮要能标红，否则和"详情"长得一模一样
					...(props.danger ? { "data-danger": "" } : {}),
				},
				props.children,
			);

		/**
		 * 「更多」下拉：把低频动作收进一个菜单，工具栏只留"这一页的主操作"。
		 *
		 * 为什么不用原生 <details>：点开后面板里的滚动/点击会把它顶走，
		 * 而且菜单要能"点外面自动关"，用受控 state + document 监听最省事。
		 *
		 * 窄屏直排（2026-10-22）：面板宽度档是 xs/narrow 时不收纳，
		 * 动作直接铺成小按钮。原因：窄屏下 ⋯ 菜单要么被滚动裁剪、盖住列表
		 * （absolute 版），要么悬在底部与页面割裂（fixed 动作面板版）——
		 * 这一处常年只有 3 个动作（AI 分析/重载/刷新），直排比任何浮层都整体。
		 * 动作超过 3 个时仍走 ⋯ 菜单（阈值，防以后动作增多把工具栏撑爆）。
		 * 档位读 .ss-root 的 data-ss-w：它由 useWidthBucket 维护，
		 * 档位变化会触发整树重渲染，这里读到的永远是当前值。
		 */
		const MoreMenu = (props) => {
			const [open, setOpen] = react.useState(false);
			react.useEffect(() => {
				if (!open) return undefined;
				// 注册延后一拍：否则打开菜单的这次点击会立刻冒泡到 document 把它关掉
				const id = window.setTimeout(() => document.addEventListener("click", onDoc), 0);
				function onDoc() { setOpen(false); }
				return () => {
					window.clearTimeout(id);
					document.removeEventListener("click", onDoc);
				};
			}, [open]);
			const items = (props.items ?? []).filter(Boolean);
			if (items.length === 0) return null;
			let narrow = false;
			try {
				const w = document.querySelector(".ss-root")?.getAttribute("data-ss-w");
				narrow = w === "narrow" || w === "xs";
			} catch { narrow = false; }
			if (narrow && items.length <= 3) {
				return h(
					"div",
					{ className: "ss-more-inline", role: "group" },
					items.map((item, i) =>
						h(
							"button",
							{
								key: i,
								type: "button",
								className: "ss-mini",
								disabled: item.disabled === true,
								title: item.title,
								onClick: item.onClick,
							},
							item.label,
						),
					),
				);
			}
			return h(
				"div",
				{ className: "ss-more" },
				h(
					"button",
					{
						type: "button",
						className: "ss-btn ss-btn-icon",
						"aria-haspopup": "menu",
						"aria-expanded": open,
						title: tr("moreActions"),
						onClick: (e) => { e.stopPropagation(); setOpen((v) => !v); },
					},
					"⋯",
				),
				open
					? h(
							"div",
							{ className: "ss-menu", role: "menu", onClick: (e) => e.stopPropagation() },
							items.map((item, i) =>
								h(
									"button",
									{
										key: i,
										type: "button",
										role: "menuitem",
										className: "ss-menu-item",
										disabled: item.disabled === true,
										title: item.title,
										onClick: () => { setOpen(false); item.onClick(); },
									},
									item.label,
								),
							),
						)
					: null,
			);
		};

		/**
		 * 胶囊开关（插件启停）。
		 *
		 * 和设置页的开关共用 .ss-switch —— 全插件只该有一种"开/关"长相。
		 *
		 * 受控：checked 永远来自真实状态，不在点击时乐观翻转。插件启停会先弹确认框，
		 * 用户点"取消"时开关不能先滑到另一边再自己弹回来。
		 */
		const Toggle = (props) =>
			h(
				"label",
				{ className: "ss-switch" + (props.disabled ? " readonly" : ""), title: props.title },
				h("input", {
					type: "checkbox",
					checked: props.checked === true,
					disabled: props.disabled,
					"aria-label": props.label,
					onChange: props.onChange,
				}),
				props.children,
			);

		/**
		 * 右侧滑出的详情抽屉。
		 *
		 * 全插件只有这一种"看详情"的长相。之前是每个页面各抄一份，技能库和"其他 Agent"
		 * 干脆是整页替换：点进去列表就没了、滚动位置也没了，关掉还得点一次「← 返回」。
		 * 抽成组件之后形态一致、动画一致（都吃 .ss-drawer 的 ssSlideIn），改一处不用改四处。
		 *
		 * 只做外壳、不管内容：head / body / foot 都由调用方算好。各页面的差异
		 * （有没有溯源块、有没有可见性开关、主操作是什么）留在调用方，免得这里长出一堆 if。
		 *
		 * @param {object} props
		 * @param {ReactNode} props.head       头部（图标 + 标题 + 副标题）；× 由本组件补
		 * @param {ReactNode} props.body       主体区块
		 * @param {ReactNode} [props.foot]     底部操作栏；不给就不渲染这一条
		 * @param {boolean} [props.loading]    true 时主体位置显示加载态
		 * @param {() => void} props.onClose
		 */
		const DetailDrawer = (props) => {
			// ESC 关闭。抽屉带遮罩、是模态的，键盘用户必须有路可退 ——
			// 之前两处抽屉只能点遮罩或那个 ×，纯键盘进来就出不去。
			// onClose 是内联箭头函数、每次渲染换引用，所以用 ref 兜住，
			// 免得 effect 跟着重挂、监听器反复解绑重绑。
			const closeRef = react.useRef(props.onClose);
			react.useEffect(() => {
				closeRef.current = props.onClose;
			});
			react.useEffect(() => {
				const onKey = (e) => {
					if (e.key !== "Escape") return;
					e.preventDefault();
					e.stopPropagation();
					closeRef.current();
				};
				// 捕获阶段监听：宿主或别的插件先 stopPropagation 也拦不住
				document.addEventListener("keydown", onKey, true);
				return () => document.removeEventListener("keydown", onKey, true);
			}, []);

			return h(
				"div",
				null,
				h("div", { className: "ss-drawer-mask", onClick: props.onClose }),
				h(
					"div",
					{ className: "ss-drawer", role: "dialog", "aria-modal": "true", "aria-label": tr("viewDetail") },
					h(
						"div",
						{ className: "ss-drawer-head" },
						props.head,
						h("button", { className: "ss-close", type: "button", onClick: props.onClose, "aria-label": "close" }, "×"),
					),
					h("div", { className: "ss-drawer-body" }, props.loading ? h("div", { className: "ss-center" }, tr("scanning")) : props.body),
					props.foot ? h("div", { className: "ss-drawer-foot" }, props.foot) : null,
				),
			);
		};

		/**
		 * AI 说明区块 —— 技能库 / 其他 Agent / 已装插件 三处详情共用一份长相。
		 *
		 * 抽出来的直接动因：三个页面各写各的，同一份 AI 摘要长出三种样子，技能库详情
		 * 干脆一行都没有 —— 列表卡片上明明有"✓ AI"和摘要，点进详情反而没了，看着像功能坏了。
		 *
		 * "还没分析"也归这里管。空着不写比写错更糟：用户会以为这技能不支持 AI 分析。
		 * 所以没数据时给一句说明 + 一个能直接点的按钮（调用方给 onAnalyze 才出现）。
		 *
		 * @param {object|undefined} props.ai      分析结果 { summary, usage }
		 * @param {boolean} [props.busy]           true 时分析按钮转成"分析中…"
		 * @param {string} [props.failErr]         上次失败的原因，优先于通用说明
		 * @param {string} [props.hint]            覆盖默认说明（比如"分析功能未启用"）
		 * @param {() => void} [props.onAnalyze]   给了才渲染分析按钮
		 */
		const AiBlock = (props) => {
			const ai = props.ai;
			if (!ai) {
				return h(
					"div",
					{ className: "ss-ai ss-ai-empty" },
					h(
						"div",
						{ className: "ss-ai-head" },
						h("span", { className: "ss-ai-badge" }, "AI"),
						h("span", { className: "ss-ai-title" }, tr("aiNoneTitle")),
					),
					// 失败过就把原因摆出来，别让人对着"还没分析过"反复点同一个按钮
					h("div", { className: "ss-ai-hint" }, props.failErr || props.hint || tr("aiNoneHint")),
					props.onAnalyze
						? h(
								"div",
								{ style: { marginTop: 9 } },
								Mini({
									children: props.busy === true ? tr("analyzing") : tr("analyze"),
									onClick: props.onAnalyze,
									disabled: props.busy === true,
								}),
							)
						: null,
				);
			}
			return h(
				"div",
				{ className: "ss-ai" },
				h(
					"div",
					{ className: "ss-ai-head" },
					h("span", { className: "ss-ai-badge" }, "AI"),
					h("span", { className: "ss-ai-title" }, tr("aiBlockTitle")),
				),
				// 摘要走纯文本而不是 Markdown：模型偶尔吐 ** 或 #，卡片上也是纯文本，
				// 两处长相得一致（再说摘要里本来也不该有结构）。
				h("div", { className: "ss-ai-summary" }, ai.summary || "–"),
				ai.usage
					? h(
							"div",
							{ className: "ss-ai-row" },
							h("span", { className: "ss-ai-key" }, tr("aiUsageLabel")),
							h("span", { className: "ss-ai-val" }, ai.usage),
						)
					: null,
			);
		};

		/**
		 * 文本输入框。`clearable` 时右边挂一个 × 用来一键清空。
		 *
		 * ⚠️ **加了 × 的输入框，根元素必须恒定是 `span.ss-inputwrap`** ——
		 * 只能是里面的 × 按钮随「有没有内容」出现/消失，**绝不能拿"有没有内容"去决定根元素**。
		 *
		 * 早先这里写的是「value 为空就直接 return 那个 `<input>`，非空才套一层 span」。
		 * 因为返回的根元素 type 在 `input` ↔ `span` 之间来回变，React 会把整棵子树**卸载重建**：
		 * 用户刚点进搜索框、敲下第一个字、value 由 "" 变非空的那一帧，手里那个 `<input>`
		 * 就被换成了新造的另一个，**焦点掉回 `body`** —— 表现成"搜索框只能打进去一个字"。
		 * 全插件 6 个搜索框（5 个页面）当时全是这个症状。
		 */
		const Input = (props) => {
			const el = h("input", {
				className: "ss-input",
				type: props.type ?? "text",
				value: props.value,
				placeholder: props.placeholder,
				onChange: (e) => props.onChange(e.target.value),
				onKeyDown: (e) => {
					if (e.key === "Enter" && props.onEnter) props.onEnter();
				},
			});
			// 不要清除按钮的，本来就只有一种长相，直接给 input 就完了
			if (props.clearable !== true) return el;
			// 只用来决定"渲不渲染 ×"，不参与决定根元素
			const hasValue = props.value !== undefined && props.value !== null && props.value !== "";
			return h(
				"span",
				// data-clear 给 CSS 用：没有 × 时右边不用留那 30px 空档
				{ className: "ss-inputwrap", "data-clear": hasValue ? "1" : "0" },
				el,
				hasValue
					? h(
							"button",
							{
								type: "button",
								className: "ss-input-clear",
								"aria-label": props.clearLabel,
								title: props.clearLabel,
								onClick: () => props.onChange(""),
							},
							"×",
						)
					: null,
			);
		};

		/**
		 * 头像首字母。
		 * 插件名普遍是 `@scope/pkg` 这种 npm 包名，直接 charAt(0) 只会得到满屏的 "@"
		 * （本机 14 个已装插件里有 11 个头像撞脸，抽屉标题旁甚至出现过 "@@linxin666/..."）。
		 * 所以先剥掉开头的 @、再取作用域名（@zzz/ 里的 zzz）的首字母；
		 * 纯符号名再退到整串里第一个字母数字/汉字；全都没有才给 "?"。
		 */
		function avatarLetter(name) {
			const raw = String(name ?? "").trim();
			const scope = raw.replace(/^@+/, "").split("/")[0] ?? "";
			const pick = /[A-Za-z0-9\u4e00-\u9fff]/.exec(scope) ?? /[A-Za-z0-9\u4e00-\u9fff]/.exec(raw);
			return pick ? pick[0].toUpperCase() : "?";
		}

		/**
		 * 中文显示名：ai.title 优先（后端 {summary,usage,title}，title 可能缺失或空字符串），
		 * 缺时退回原技术名。item/skill/plugin 三处共用；缺字段不崩。
		 */
		function displayName(item, ai) {
			const t = typeof ai?.title === "string" ? ai.title.trim() : "";
			if (t !== "") return t;
			const fallback = String(item?.name ?? item?.slug ?? "").trim();
			return fallback;
		}

		/** ai 是否带可用中文名（pending/详情按钮共用判据）。 */
		function hasDisplayTitle(ai) {
			return typeof ai?.title === "string" && ai.title.trim() !== "";
		}

		/**
		 * 列表搜索：同时匹配中文名与原技术名（+ 描述/AI 摘要兜底）。
		 * q 已是小写；item/ai 缺字段不崩。
		 */
		function matchesQuery(item, ai, q) {
			if (q === "") return true;
			const hay = (
				String(item?.name ?? item?.slug ?? "") + " " +
				displayName(item, ai) + " " +
				String(item?.description ?? "") + " " +
				String(ai?.summary ?? "")
			).toLowerCase();
			return hay.includes(q);
		}

		/**
		 * 技能列表排序（来源内部那一屏）。
		 * "默认"直接返回原数组：后端扫描时已经按名称排好了
		 * （index.js 的 `skills.sort((a,b) => a.name.localeCompare(b.name))`），
		 * 再来一次纯属白跑。
		 */
		const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
		/**
		 * 溯源块：这个技能从哪来、来源还在不在、还有哪些来源有同名技能。
		 *
		 * 数据来自服务端的导入台账（/harness 与 /scan 注入的 origin 字段）。
		 * 台账是唯一能回答"从哪来"的东西 —— 技能导入后会被拍平成
		 * `~/.dsh/skills/<name>`，文件系统上已经看不出出处了。
		 */
		function originBlock(skill) {
			const o = skill?.origin;
			const also = Array.isArray(skill?.alsoIn) ? skill.alsoIn : [];
			const rawHome = String(o?.url ?? skill?.sourceUrl ?? "").trim();
			const home = typeof safeHref === "function" ? safeHref(rawHome) : rawHome;
			if (!o && also.length === 0 && home === "") return null;
			const rows = [];
			if (o) {
				const what =
					o.kind === "market"
						? tr("originMarket") + (o.marketSource ? " (" + o.marketSource + ")" : "")
						: o.fromLabel || "–";
				const when = o.at ? String(o.at).slice(0, 10) : "";
				rows.push(
					h(
						"div",
						{ className: "ss-origin-row", key: "origin" },
						h("span", { className: "ss-tag", "data-verified": "" }, tr("originLabel")),
						h("span", { className: "ss-origin-label" }, what),
						when !== "" ? h("span", { className: "ss-origin-when" }, tr("originImportedAt") + " " + when) : null,
						// 只有"从本机来源导入"的才谈得上重新导入；市场装的是从网上下的
						o.kind === "import"
							? h(
									"span",
									{ className: "ss-origin-avail", "data-gone": o.available ? undefined : "" },
									o.available ? tr("originAvailable") : tr("originGone"),
								)
							: null,
					),
				);
			}
			if (home !== "") {
				rows.push(
					h(
						"div",
						{ className: "ss-origin-row", key: "home" },
						h(
							"a",
							{ className: "ss-link", href: home, target: "_blank", rel: "noreferrer noopener" },
							tr("pmOpenPage"),
						),
					),
				);
			}
			if (also.length > 0) {
				rows.push(
					h(
						"div",
						{ className: "ss-origin-row", key: "also" },
						h("span", { className: "ss-tag", "data-apikey": "" }, tr("originAlsoIn")),
						...also.slice(0, 8).map((a) => h("span", { key: a.dir, className: "ss-origin-label", title: a.path }, a.label)),
						also.length > 8 ? h("span", { className: "ss-origin-when" }, "+" + (also.length - 8)) : null,
					),
				);
			}
			return h("div", { className: "ss-origin" }, rows);
		}

		function sortSkills(list, mode) {
			if (mode === "unimported") {
				// 未导入的排前面：这个列表最常见的用途就是"还有哪些没搬进 DSH"
				return [...list].sort(
					(a, b) => Number(a.imported === true) - Number(b.imported === true) || NAME_ORDER.compare(a.name, b.name),
				);
			}
			return list;
		}

		/** 来源首字母的彩色图标。 */
		function SourceIcon({ name, url }) {
			if (url) return h("img", { className: "ss-icon", src: url, alt: "", onError: (e) => { e.target.style.display = "none" } });
			return h("div", { className: "ss-icon", "data-letter": "" }, avatarLetter(name));
		}

		/** 复制到剪贴板。navigator.clipboard 在非安全上下文里可能没有，退回 execCommand。 */
		async function copyText(text) {
			try {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				/* 走兜底 */
			}
			try {
				const el = document.createElement("textarea");
				el.value = text;
				el.setAttribute("readonly", "");
				el.style.position = "fixed";
				el.style.opacity = "0";
				document.body.appendChild(el);
				el.select();
				const ok = document.execCommand("copy");
				document.body.removeChild(el);
				return ok;
			} catch {
				return false;
			}
		}

		/**
		 * 链接 / 图片的来源白名单。
		 *
		 * 详情页渲染的是**第三方技能包里的 README**，属于不可信内容。
		 * `[点我](javascript:alert(1))`、或 HTML 形式 `<a href="javascript:...">`，
		 * 引号里的东西会被原样送进 href —— 用户在面板里点一下就在同源执行了脚本。
		 * 图片同理：`data:` 之外的自定义协议没有意义，而 `javascript:` 挂在
		 * src 上只是失败，但统一走白名单能少一类"以后某天被浏览器改回来"的风险。
		 *
		 * 判断前先按浏览器的规则剥掉嵌入的控制字符与空白：
		 * `java\tscript:` 这种写法浏览器会当成 `javascript:`，不先清洗就绕过去了。
		 */
		function schemeOf(raw) {
			return /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(raw ?? "").trim().replace(/[\u0000-\u0020\u007f]/g, ""));
		}

		/** 允许 http / https / mailto（mailto 保留：README 常见作者邮箱，点开只调起邮件客户端、不执行脚本）。其余（含 javascript:/data:/自定义协议）清空；无协议相对路径按原样返回。 */
		function safeHref(raw) {
			const value = String(raw ?? "").trim();
			const scheme = schemeOf(value);
			if (scheme === null) return value;
			const name = scheme[1].toLowerCase();
			return name === "http" || name === "https" || name === "mailto" ? value : "";
		}

		/** 图片额外放行 data:（内联徽章），其余自定义协议一律丢掉。 */
		function safeImageSrc(raw) {
			const value = String(raw ?? "").trim();
			const scheme = schemeOf(value);
			if (scheme === null) return value;
			const name = scheme[1].toLowerCase();
			return name === "http" || name === "https" || name === "data" ? value : "";
		}

		/**
		 * SKILL.md / README 里的原始 HTML 预处理。
		 * 之前详情抽屉把 README 当纯文本渲染，用户看到的是一整屏
		 * `<p align="center">` / `<img src="https://img.shields.io/...">`。
		 * 这里在进解析器之前做一遍外科手术：
		 *   <img>      → 换成 markdown 图片语法（后面 renderInline 认）
		 *   <a href>   → 换成 markdown 链接
		 *   块级标签   → 换成换行（保留段落感）
		 *   其余标签   → 直接剥掉，只留文字
		 * 已经用 ``` 围起来的代码块必须原样保留，否则讲 HTML 的技能会被改坏。
		 */
		function normalizeHtmlLine(line) {
			if (line.indexOf("<") === -1 && line.indexOf("&") === -1) return [line];
			// 行内代码里出现的 `<div>` 是"内容"，不是标签 —— 先摘出来存好，收尾再放回去。
			// 不然 `用 \`<div>\` 包一层` 会被当成块级标签拆成两行、字都没了。
			const codes = [];
			let s = line.replace(/`[^`]*`/g, (m) => {
				codes.push(m);
				return "\u0000" + (codes.length - 1) + "\u0000";
			});
			s = s
				// 图片必须先转：<a href><img></a> 这种要先让 img 变成 markdown 图片，
				// 下面处理 <a> 时才知道"链接里其实是一张图"。
				.replace(/<img\b[^>]*>/gi, (tag) => {
					const src = (/\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag) ?? [])[1] ?? "";
					if (!src) return "";
					if (!/^(?:https?:|data:|\/|\.)/i.test(src)) return "";
					const alt = (/\balt\s*=\s*["']([^"']*)["']/i.exec(tag) ?? [])[1] ?? "";
					return "![" + alt.replace(/[\[\]]/g, "") + "](" + src + ")";
				})
				.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, txt) => {
					const raw = String(txt).trim();
					const inner = raw.replace(/<[^>]*>/g, "").trim();
					if (inner === "") return raw; // 里面只剩图片：留着图，别连着链接一起丢
					// 本解析器不嵌套行内语法，图片已经能点了就不再套一层链接
					if (raw.includes("![")) return inner;
					return href ? "[" + inner + "](" + href + ")" : inner;
				})
				// 加粗是 README 里最常见的行内 HTML，用 markdown 表达才不丢样式
				.replace(/<\/?(?:b|strong)\b[^>]*>/gi, "**")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<\/?(?:p|div|center|section|article|header|footer|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|blockquote|figure|figcaption|details|summary|hr)\b[^>]*>/gi, "\n")
				.replace(/<[^>]*>/g, "")
				// **** 这种空加粗回退成空串，避免渲染出多余星号
				.replace(/\*{4,}/g, "");
			// 实体解码要独立于"这一行有没有标签"，否则纯文本行里的 &amp; 会原样露出来
			s = s
				.replace(/&nbsp;/g, " ")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/&amp;/g, "&");
			s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
			return s.split("\n");
		}

		function normalizeHtml(text) {
			// SKILL.md 开头的 YAML frontmatter 是元数据（name / description 上面已经单独展示过），
			// 当正文渲染只会变成一坨 "--- name: xxx description: yyy" 的噪音
			const body = String(text ?? "").replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
			const lines = body.split(/\r?\n/);
			const out = [];
			let fence = false;
			for (const line of lines) {
				if (/^\s*```/.test(line)) {
					fence = !fence;
					out.push(line);
					continue;
				}
				if (fence) {
					out.push(line);
					continue;
				}
				for (const piece of normalizeHtmlLine(line)) out.push(piece);
			}
			// 剥标签会留下成片的空行，压回最多一个空行
			return out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
		}

		/** 行内元素：**粗体** / `代码` / [文字](链接) / ![图片](地址)。 */
		function renderInline(text, keyPrefix) {
			const nodes = [];
			const re = /(!\[[^\]]*\]\((?:https?:|\/|data:|\.)[^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:|\/)[^)\s]+\))/g;
			let last = 0;
			let index = 0;
			let m;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) nodes.push(text.slice(last, m.index));
				const token = m[0];
				if (token.startsWith("![")) {
					const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
					const src = safeImageSrc(img[2]);
					if (src === "") {
						// 协议不合法：只留 alt 文字，别渲染出一个永远加载不出来的空图
						nodes.push(img[1]);
					} else {
						// 徽章（shields.io / *.svg）按小图标排，截图才按块级图片撑开
						const badge = /shields\.io|badgen|\/badge|\.svg(?:\?|$)/i.test(src);
						nodes.push(
							h("img", {
								key: keyPrefix + "g" + index,
								className: "ss-md-img",
								src,
								alt: img[1],
								loading: "lazy",
								"data-badge": badge ? "" : undefined,
								onError: (e) => { e.target.style.display = "none"; },
							}),
						);
					}
				} else if (token.startsWith("**")) {
					nodes.push(h("b", { key: keyPrefix + "b" + index }, token.slice(2, -2)));
				} else if (token.startsWith("`")) {
					nodes.push(h("code", { key: keyPrefix + "c" + index, className: "ss-code" }, token.slice(1, -1)));
				} else {
					const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
					const href = safeHref(link[2]);
					// 协议不合法就不是链接，退回纯文本 —— 渲染成 <a> 的话
					// 点一下就会在同源里执行脚本
					nodes.push(
						href === ""
							? h("span", { key: keyPrefix + "a" + index }, link[1])
							: h("a", { key: keyPrefix + "a" + index, className: "ss-link", href, target: "_blank", rel: "noreferrer noopener" }, link[1]),
					);
				}
				last = m.index + token.length;
				index++;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}

		/**
		 * 极简 Markdown 渲染。只覆盖 SKILL.md / README 里真正会出现的语法
		 * （标题 / 列表 / 代码块 / 引用 / 行内粗体与代码 / 图片），
		 * 原始 HTML 先由 normalizeHtml 拆成等价的行，再走同一套解析。
		 * 不引第三方库——客户端模块是自包含的，拿不到 npm。
		 */
		function Markdown(props) {
			const lines = normalizeHtml(props.text).split(/\r?\n/);
			const blocks = [];
			let i = 0;
			let seq = 0;
			while (i < lines.length) {
				const line = lines[i];
				if (/^\s*```/.test(line)) {
					const lang = line.replace(/^\s*```/, "").trim();
					const body = [];
					i++;
					while (i < lines.length && !/^\s*```/.test(lines[i])) {
						body.push(lines[i]);
						i++;
					}
					i++;
					blocks.push(h("pre", { key: "p" + seq++, className: "ss-pre", "data-lang": lang || undefined }, body.join("\n")));
					continue;
				}
				const heading = /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading) {
					const level = Math.min(6, heading[1].length);
					blocks.push(h("div", { key: "h" + seq++, className: "ss-md-h", "data-level": level }, renderInline(heading[2], "h" + seq)));
					i++;
					continue;
				}
				if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
					// 有序 / 无序要分开：README 里的"1. 2. 3." 步骤很多，
					// 一律当 <ul> 会把序号丢掉、换成圆点，读起来就错位了
					const ordered = /^\s*\d+[.)]\s+\S/.test(line);
					const items = [];
					const itemRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
					const scanRe = ordered ? /^\s*\d+[.)]\s+\S/ : /^\s*[-*+]\s+\S/;
					while (i < lines.length && scanRe.test(lines[i])) {
						items.push(lines[i].replace(itemRe, ""));
						i++;
					}
					blocks.push(h(ordered ? "ol" : "ul", { key: "u" + seq++, className: ordered ? "ss-md-ol" : "ss-md-ul" }, items.map((it, n) => h("li", { key: n }, renderInline(it, "u" + seq + "_" + n)))));
					continue;
				}
				if (/^\s*>\s?/.test(line)) {
					const body = [];
					while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
						body.push(lines[i].replace(/^\s*>\s?/, ""));
						i++;
					}
					blocks.push(h("div", { key: "q" + seq++, className: "ss-md-quote" }, renderInline(body.join(" "), "q" + seq)));
					continue;
				}
				if (line.trim() === "") {
					i++;
					continue;
				}
				const para = [];
				// 段落吃到这里为止。注意有序列表（1. 2. 3.）也要算"到这里为止"，
				// 否则紧跟在正文下面的一串编号步骤会被整段吞掉、序号变成普通文字。
				while (i < lines.length && lines[i].trim() !== "" && !/^\s*(?:```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])) {
					para.push(lines[i]);
					i++;
				}
				// 兜底：上面都没吃掉又不属于段落的情况，直接原样输出并前进，避免死循环
				if (para.length === 0) {
					blocks.push(h("p", { key: "t" + seq++, className: "ss-md-p" }, line));
					i++;
					continue;
				}
				blocks.push(h("p", { key: "t" + seq++, className: "ss-md-p" }, renderInline(para.join("\n"), "t" + seq)));
			}
			return h("div", { className: "ss-md" }, blocks);
		}

		/**
		 * 弹窗要落在「面板」范围内，而不是整个视口。
		 * DSH 左侧还有一条侧栏，按视口居中会明显偏左（1440 宽下实测
		 * 视口中心 720 / 面板中心 830，差了 110px，看起来像没对齐）。
		 */
		function panelBox() {
			try {
				const el = document.querySelector(".ss-root");
				const r = el?.getBoundingClientRect?.();
				if (!r || r.width === 0) return undefined;
				return { left: r.left, top: r.top, width: r.width, height: r.height };
			} catch {
				return undefined;
			}
		}

		/**
		 * 确认弹窗。
		 * 之前是个"假弹窗"：没有 role、焦点进不来也出不去、Esc 关不掉、
		 * 而且卸载这种破坏性操作也用的是蓝色「确定」。
		 * 现在补齐 role="dialog"/aria-modal、打开即聚焦、Esc 关闭、
		 * 关闭后焦点还原、Tab 在弹窗内循环；破坏性操作用 danger 样式 +
		 * 明确动词（"卸载"而不是"确定"），并且默认焦点落在「取消」上。
		 *
		 * @param {string} message
		 * @param {{ tone?: "danger", confirmText?: string }} [options]
		 */
		function useConfirm() {
			const [ask, setAsk] = react.useState(undefined);
			const panelRef = react.useRef(null);
			const restoreRef = react.useRef(null);

			const confirm = react.useCallback(
				(message, options) => new Promise((resolve) => setAsk({ message, resolve, tone: options?.tone, confirmText: options?.confirmText })),
				[],
			);

			react.useEffect(() => {
				if (ask === undefined) return undefined;
				// 打开前记住焦点，关闭后还回去；否则焦点掉到 body，键盘用户直接迷路
				restoreRef.current = document.activeElement;
				const t = window.setTimeout(() => {
					const el = panelRef.current?.querySelector("[data-autofocus]");
					if (el && typeof el.focus === "function") el.focus();
				}, 0);
				const onKey = (e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						close(false);
					}
				};
				// 捕获阶段监听：宿主或别的插件先 stopPropagation 也拦不住
				document.addEventListener("keydown", onKey, true);
				return () => {
					window.clearTimeout(t);
					document.removeEventListener("keydown", onKey, true);
					const back = restoreRef.current;
					restoreRef.current = null;
					if (back && document.contains(back) && typeof back.focus === "function") back.focus();
				};
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [ask]);

			const close = (value) => {
				if (ask) ask.resolve(value);
				setAsk(undefined);
			};

			let node = null;
			if (ask !== undefined) {
				const danger = ask.tone === "danger";
				const box = panelBox();
				node = h(
					"div",
					{
						className: "ss-modal-mask",
						style: box
							? { left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px" }
							: undefined,
						onClick: () => close(false),
					},
					h(
						"div",
						{
							ref: panelRef,
							className: "ss-modal" + (danger ? " danger" : ""),
							role: danger ? "alertdialog" : "dialog",
							"aria-modal": "true",
							"aria-labelledby": "ss-modal-msg",
							onClick: (e) => e.stopPropagation(),
							onKeyDown: (e) => {
								if (e.key !== "Tab") return;
								const items = panelRef.current?.querySelectorAll("button:not([disabled])") ?? [];
								if (items.length === 0) return;
								const first = items[0];
								const last = items[items.length - 1];
								if (e.shiftKey && document.activeElement === first) {
									e.preventDefault();
									last.focus();
								} else if (!e.shiftKey && document.activeElement === last) {
									e.preventDefault();
									first.focus();
								}
							},
						},
						h("div", { className: "ss-modal-msg", id: "ss-modal-msg" }, ask.message),
						h(
							"div",
							{ className: "ss-modal-btns" },
							// 破坏性操作默认焦点给「取消」，避免多按一下回车就把东西卸了
							Btn({ autoFocus: danger, onClick: () => close(false), children: tr("cancel") }),
							Btn({
								primary: !danger,
								danger,
								autoFocus: !danger,
								onClick: () => close(true),
								children: ask.confirmText ?? tr("ok"),
							}),
						),
					),
				);
			}
			return [confirm, node];
		}

		/* ================================================================ *
		 * tab 1: Harness 技能
		 * ================================================================ */

		/* ================================================================ *
		 * 列表 / 卡片 双视图：各 tab 共用的状态与切换控件
		 * ================================================================ */

		/** 视图模式（list / card），按 tab 记忆在 localStorage 里 */
		function useViewMode(tabKey, fallback) {
			const [mode, setMode] = react.useState(() => {
				try { return localStorage.getItem("ss-view-" + tabKey) || fallback; } catch { return fallback; }
			});
			const set = react.useCallback((m) => {
				setMode(m);
				try { localStorage.setItem("ss-view-" + tabKey, m); } catch { }
			}, []);
			return [mode, set];
		}

		/**
		 * 面板自身宽度的响应式分档。
		 *
		 * 为什么不用纯 CSS media query：media query 看的是**视口**宽度，
		 * 而插件面板的宽度可以远小于视口（DSH 主区被压窄、侧栏展开/收起，
		 * 甚至窗口很宽但面板只占一半）。实测把面板压到 640 而视口仍是 1440 时，
		 * `@media (max-width:640px)` 一条都不生效，设置页照样出横向滚动条。
		 * 所以量 .ss-root 自己，把档位写到 data-ss-w 上，CSS 按属性选择器响应。
		 */
		function useWidthBucket() {
			const [bucket, setBucket] = react.useState("wide");
			react.useEffect(() => {
				const el = document.querySelector(".ss-root");
				if (!el) return undefined;
				const measure = () => {
					const w = el.clientWidth;
					// xwide 是给"最大化窗口 / 超宽屏"准备的：官方插件页 960 就封顶，
					// 但桌面端最大化后主区有 2300+，只封 880 会把右边整片空出来。
					setBucket(w < 560 ? "xs" : w < 760 ? "narrow" : w < 980 ? "mid" : w < 1500 ? "wide" : "xwide");
				};
				measure();
				if (typeof ResizeObserver === "undefined") {
					window.addEventListener("resize", measure);
					return () => window.removeEventListener("resize", measure);
				}
				const ro = new ResizeObserver(measure);
				ro.observe(el);
				return () => ro.disconnect();
			}, []);
			return bucket;
		}

		/**
		 * 列表 / 卡片 视图切换。
		 * 以前按钮内容是 ☰ 和 ▦ —— 那是从别处借来的"字符图标"，
		 * 字体一变就换长相（antislop R-04：图标要真正与内容相关，
		 * 且不该是借来的通用字形）。这里改成内联 SVG：
		 * 两种视图的**形状本身就是语义**（三横 = 行，方块阵 = 卡片），
		 * 比字形更准确，也不依赖字体。
		 * 尺寸随宿主的内容字号一起缩放（--dsh-content-font-delta 是 DSH 自己发的）。
		 */
		function ViewSwitch({ mode, onChange }) {
			const icon = (paths) =>
				h(
					"svg",
					{
						width: 16,
						height: 16,
						viewBox: "0 0 16 16",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.6,
						strokeLinecap: "round",
						"aria-hidden": "true",
					},
					paths.map((d, i) => h("path", { key: i, d })),
				);
			return h(
				"div",
				{ className: "ss-seg", role: "group" },
				h(
					"button",
					{
						type: "button",
						className: "ss-seg-btn" + (mode === "list" ? " on" : ""),
						onClick: () => onChange("list"),
						title: tr("viewList"),
						"aria-label": tr("viewList"),
						"aria-pressed": mode === "list",
					},
					// 三横：每行一条，中间那条短一截，表示"行"的粗细不均（名称 + 描述）
					icon(["M3 4.5h10", "M3 8h7", "M3 11.5h10"]),
				),
				h(
					"button",
					{
						type: "button",
						className: "ss-seg-btn" + (mode === "card" ? " on" : ""),
						onClick: () => onChange("card"),
						title: tr("viewCard"),
						"aria-label": tr("viewCard"),
						"aria-pressed": mode === "card",
					},
					// 四宫格：卡片的形状
					icon(["M3 3h4v4H3z", "M9 3h4v4H9z", "M3 9h4v4H3z", "M9 9h4v4H9z"]),
				),
			);
		}

		function HarnessTab(props) {
			const config = props.config;
			const [view, setView] = useViewMode("harness", "list");
			const [state, setState] = react.useState({ loading: true, groups: [], error: undefined });
			const [filter, setFilter] = react.useState("");
			const [detail, setDetail] = react.useState(undefined);
			const [toast, setToast] = useToast();
			/** 正在落盘的技能（`键:目录` → true），用来防重复点击。 */
			const [rowBusy, setRowBusy] = react.useState({});
			const [confirm, confirmNode] = useConfirm();

			/**
			 * 就地改某个技能的可见性字段。
			 * 键用 dir：同一屏里 dir 唯一，而 id 在 /harness 里是按名字现拼的，
			 * 同名技能（用户库 + 内置）会撞。
			 */
			const patchVis = (groups, dir, key, enabled) =>
				(groups ?? []).map((g) => ({
					...g,
					skills: (g.skills ?? []).map((s) => (s.dir === dir ? { ...s, [key]: enabled } : s)),
				}));

			/** 总开关：一次改两个键（禁用 = 两边都关）。 */
			const patchBoth = (groups, dir, disabled) =>
				(groups ?? []).map((g) => ({
					...g,
					skills: (g.skills ?? []).map((s) =>
						s.dir === dir ? { ...s, modelInvocable: !disabled, userInvocable: !disabled } : s,
					),
				}));

			/**
			 * 改技能可见性（写回 SKILL.md 的 frontmatter）。
			 *
			 * 先乐观更新再落盘：开关必须立刻响应，等一个来回才动会像坏了。
			 * 失败要回滚**并且**弹出原因 —— 服务端会因为"只读来源"等原因拒绝，
			 * 静默回滚会让人以为是自己没点中。
			 *
			 * 总开关（总关两个键）走服务端一次落盘，前端**不发两次请求**：
			 * 两次之间 SKILL.md 会短暂停在"只关了一边"的半截状态，而 DSH 正
			 * 用 chokidar 盯着这些目录，可能刚好在那个瞬间重扫。
			 */
			const setVis = async (skill, key, enabled) => {
				const flag = key + ":" + skill.dir;
				if (rowBusy[flag]) return;
				setRowBusy((b) => ({ ...b, [flag]: true }));
				setState((s) => ({ ...s, groups: patchVis(s.groups, skill.dir, key, enabled) }));
				try {
					const r = await sendJson(API.skillVisibility, "POST", { dir: skill.dir, key, enabled });
					if (!r.ok) throw new Error(r.error ?? "failed");
					setToast({ kind: "ok", text: tr("visibilitySaved") });
				} catch (e) {
					setState((s) => ({ ...s, groups: patchVis(s.groups, skill.dir, key, !enabled) }));
					setToast({ kind: "err", text: tr("visibilityFail") + "：" + String(e.message ?? e) });
				} finally {
					setRowBusy((b) => {
						const next = { ...b };
						delete next[flag];
						return next;
					});
				}
			};

			/** 总开关：禁用 = 同时关掉两个面；启用 = 同时清掉两个键。 */
			const setDisabled = async (skill, disabled) => {
				const flag = "disabled:" + skill.dir;
				if (rowBusy[flag]) return;
				setRowBusy((b) => ({ ...b, [flag]: true }));
				setState((s) => ({ ...s, groups: patchBoth(s.groups, skill.dir, disabled) }));
				try {
					const r = await sendJson(API.skillVisibility, "POST", { dir: skill.dir, disabled });
					if (!r.ok) throw new Error(r.error ?? "failed");
					setToast({ kind: "ok", text: tr("visibilitySaved") });
				} catch (e) {
					setState((s) => ({ ...s, groups: patchBoth(s.groups, skill.dir, !disabled) }));
					setToast({ kind: "err", text: tr("visibilityFail") + "：" + String(e.message ?? e) });
				} finally {
					setRowBusy((b) => {
						const next = { ...b };
						delete next[flag];
						return next;
					});
				}
			};

			/**
			 * 技能当前的禁用程度。
			 *
			 * 总开关是"两边都关"的二态开关，但 frontmatter 里两个键是独立的，
			 * 所以存在只关了一边的中间态（比如只用详情页的细粒度开关，
			 * 或被别的工具改过）。这种状态既不能显示成"启用中"（会误导），
			 * 也不能显示成"已禁用"（点一下会出乎意料地关掉另一边）。
			 */
			const disableState = (skill) => {
				const noModel = skill.modelInvocable === false;
				const noUser = skill.userInvocable === false;
				if (noModel && noUser) return "full";
				if (noModel || noUser) return "partial";
				return "none";
			};

			/** 删除 = 移入回收站（服务端保证只删用户库内的）。确认由调用方先弹。 */
			const doRemove = async (skill) => {
				try {
					const r = await sendJson(API.removeSkill, "POST", { dir: skill.dir, name: skill.name });
					if (!r.ok) throw new Error(r.error ?? "failed");
					setToast({ kind: "ok", text: tr("removedToTrash") });
					load();
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				}
			};

			// bundled 技能没有 dir / 全文，id 用 provider+name 拼出来保证唯一且稳定
			const harnessId = (s) => "harness:" + String(s.provider ?? "bundled") + ":" + String(s.name ?? "");
			const allSkills = (state.groups ?? []).flatMap((g) =>
				(g.skills ?? []).map((s) => ({ ...s, id: harnessId(s), fullText: "" })),
			);
			const {
				analyzeOn, aiMap, adoptServer, failedMap, busy,
				pendingAnalyze, analyzeAllDone, analyzeNone,
				doAnalyze, doAnalyzeOne, stopAnalyze,
			} = useSkillAnalyze(config, allSkills, (kind, text) => setToast({ kind, text }), confirm);

			const load = react.useCallback(() => {
				setState((s) => ({ ...s, loading: true, error: undefined }));
				getJson(API.harness)
					.then((data) => {
						// 把后端注入的 aiAnalysis 合并到 aiMap。
						// groups 结构兼容：新版 skill-explorer 是「对象数组」（元素直接带 skills），
						// 旧版是「数组的数组」——之前按旧结构剥两层，for-of 对象直接炸。
						const m = {};
						const groupLists = Array.isArray(data.groups) ? data.groups : Object.values(data.groups ?? {});
						for (const list of groupLists) {
							const items = Array.isArray(list) ? list : [list];
							for (const g of items) {
								for (const s of g?.skills ?? []) {
									if (s.aiAnalysis) m[harnessId(s)] = s.aiAnalysis;
								}
							}
						}
						adoptServer(m);
						setState({ loading: false, groups: data.groups ?? [], error: data.error });
					})
					.catch((e) => setState({ loading: false, groups: [], error: String(e.message ?? e) }));
			}, [adoptServer]);

			react.useEffect(() => {
				load();
			}, [load]);

			// 之前这里只塞了 loading:true 且从不发请求，点「详情」会永久停在「…」。
			// harness 技能的 dir 由本插件自扫给出；拿不到就退回描述文本。
			const openDetail = (skill) => {
				if (!skill.dir) {
					setDetail({ skill, content: skill.description ?? "" });
					return;
				}
				setDetail({ skill, loading: true });
				getJson(API.skill + "?dir=" + encodeURIComponent(skill.dir))
					.then((data) => setDetail({ skill, content: data.content ?? "" }))
					.catch((e) => setDetail({ skill, error: String(e.message ?? e) }));
			};

			/**
			 * 按 dir 从当前 state 里反查这个技能"活的那一份" + 它属于哪个分组。
			 *
			 * 两个理由：
			 * 1. detail.skill 是打开详情那一刻的快照。在详情页拨开关 → state 变了
			 *    但快照没变 → 勾选框弹回原样，看着像没生效。可控字段必须走实时值
			 *    （正文仍用快照，它是异步取回来的）。
			 * 2. 详情页要判断"能不能改"，而这取决于技能在不在用户库里。反查比
			 *    挨个给 openDetail 加 groupKey 参数稳妥 —— 这个函数在四个 tab 里
			 *    各有一份，漏改一处就会静默地让开关变只读。
			 */
			const findEntry = (dir) => {
				if (dir === undefined || dir === "") return undefined;
				for (const g of state.groups ?? []) {
					for (const s of g.skills ?? []) if (s.dir === dir) return { skill: s, groupKey: g.key };
				}
				return undefined;
			};

			/**
			 * 技能详情 = 右侧滑出的抽屉。
			 *
			 * 这里原来是"整页替换 + ← 返回"：点进详情，列表整个消失、滚动位置也没了，
			 * 关掉还得再点一次返回。抽屉是浮层，底下的列表留着才对 —— 所以是
			 * 算成一个节点、挂在列表之后，而不是提前 return。
			 *
			 * 内容顺序也是这一轮定的：状态胶囊 → AI 说明 → 溯源 → （折叠的）可见性 → 正文。
			 * AI 说明排在正文之前：它是点进来最想先看的东西，之前却压根没有 ——
			 * 列表卡片上都有摘要，点进详情反而没了，看着像坏了。
			 * 可见性开关反过来下沉：低频治理项，不该压在正文之上。
			 */
			const detailNode =
				detail === undefined
					? null
					: (() => {
							const entry = findEntry(detail.skill?.dir);
							const ds = entry?.skill ?? detail.skill ?? {};
							const dIsUserLib = entry?.groupKey === "dsh-user";
							const dstate = disableState(ds);
							const dId = harnessId(ds);
							const dAi = aiMap[dId];
							const dAiBusy = busy[dId + "__ai"] === true;
							/*
							 * 细粒度开关：DSH 的两个治理键本来就是两个独立的轴，
							 * 这里把它们露出来，用来做总开关做不了的事 ——
							 * 比如"留给模型、但不挂到我的 / 列表里"。
							 */
							const visSw = (key, on, label, hint) =>
								h(
									"label",
									{
										className: "ss-switch" + (dIsUserLib ? "" : " readonly"),
										title: dIsUserLib ? hint : tr("visibilityReadonlyHint"),
									},
									h("input", {
										type: "checkbox",
										checked: on,
										disabled: !dIsUserLib || rowBusy[key + ":" + ds.dir] === true,
										// 两个键分别写死：动态拼键名会让"死键检查"扫不到它们
										"aria-label": key === "modelInvocable" ? tr("modelInvocable") : tr("userInvocable"),
										onChange: dIsUserLib ? (e) => setVis(ds, key, e.target.checked) : undefined,
									}),
									label,
								);
							// 状态胶囊：只在"有话说"的时候出现。启用中是最常见的情况，
							// 再挂一个绿色"启用中"就只是噪音了。
							const chips = [];
							if (dstate === "full") chips.push(h("span", { key: "off", className: "ss-state", title: tr("disableHint") }, tr("disabledTag")));
							if (dstate === "partial") chips.push(h("span", { key: "part", className: "ss-state", title: tr("advancedVisibilityHint") }, tr("partialDisabledTag")));
							// 读不到正文（内置技能不给读、或请求失败）时退回描述 ——
							// 抽屉里只剩一片空白比什么都糟。
							const dText = String(detail.content ?? "").trim() !== "" ? detail.content : (ds.description ?? "");
							return h(DetailDrawer, {
								onClose: () => setDetail(undefined),
								loading: detail.loading === true,
								head: [
									h("div", { key: "icon", className: "ss-avatar" }, avatarLetter(ds.name)),
									h(
										"div",
										{ key: "title", style: { minWidth: 0, flex: 1 } },
										h("div", { className: "ss-drawer-title", title: ds.name ?? "" }, ds.name ?? ""),
										hasDisplayTitle(dAi) && displayName(ds, dAi) !== String(ds.name ?? "")
											? h("div", { className: "ss-drawer-subtitle" }, displayName(ds, dAi))
											: null,
										ds.dir ? h("div", { className: "ss-drawer-handle" }, ds.dir) : null,
									),
								],
								body: [
									chips.length > 0 ? h("div", { key: "chips", className: "ss-chips ss-drawer-tags" }, chips) : null,
									h(AiBlock, {
										key: "ai",
										ai: dAi,
										busy: dAiBusy,
										failErr: failedMap[dId],
										// 没开分析功能就不给按钮（点了只会报错），改说清楚去哪儿开
										hint: analyzeOn ? undefined : tr("analyzeDisabled"),
										onAnalyze: hasDisplayTitle(dAi) || !analyzeOn ? undefined : () => doAnalyzeOne({ ...ds, id: dId, fullText: "" }),
									}),
									originBlock(ds),
									ds.dir
										? h(
												"details",
												{ key: "adv", className: "ss-adv" },
												h(
													"summary",
													{ className: "ss-adv-head" },
													h("span", { className: "ss-adv-title" }, tr("advancedVisibility")),
													dstate === "full"
														? h("span", { className: "ss-tag ss-off" }, tr("disabledTag"))
														: dstate === "partial"
															? h("span", { className: "ss-tag ss-off" }, tr("partialDisabledTag"))
															: null,
												),
												h(
													"div",
													{ className: "ss-adv-row" },
													visSw("modelInvocable", ds.modelInvocable !== false, tr("visibilityModelShort"), tr("visibilityModelHint")),
													visSw("userInvocable", ds.userInvocable !== false, tr("visibilityUserShort"), tr("visibilityUserHint")),
												),
												h("div", { className: "ss-adv-hint" }, tr("advancedVisibilityHint")),
											)
										: null,
									detail.error
										? h("div", { key: "err", className: "ss-err" }, detail.error)
										: h(Markdown, { key: "md", text: dText || "–" }),
								],
							});
						})();

			if (state.loading) return h("div", { className: "ss-center" }, tr("scanning"));
			if (state.error !== undefined) return h("div", { className: "ss-body" }, h("div", { className: "ss-err" }, state.error));

			const q = filter.trim().toLowerCase();
			// 过滤后一条都不剩时必须给兜底，否则用户看到的是一整片纯白。
			// 本机 ~/.dsh/skills 是空的、默认二级标签又落在 harness，
			// 等于每次打开这个 tab 都是白屏（插件页有"没有匹配的插件"，这里却没有）。
			const totalShown = state.groups.reduce(
				(n, g) => n + (g.skills ?? []).filter((s) => matchesQuery(s, aiMap[harnessId(s)], q)).length,
				0,
			);

			// 卡片模式的一张卡（列表模式的行在下面 group 渲染里）
			const harnessCardFor = (skill, groupKey) => {
				const row = { ...skill, id: harnessId(skill) };
				const ai = aiMap[row.id];
				const failErr = failedMap[row.id];
				const aiBusy = busy[row.id + "__ai"] === true;
				const isUserLib = groupKey === "dsh-user";
				const cstate = disableState(skill);
				return h(
					"div",
					{ className: "ss-card", key: row.id, "data-analyzed": ai ? "" : undefined, style: failErr ? { borderColor: "color-mix(in srgb,var(--ss-danger) 40%,transparent)" } : undefined },
					h(
						"div",
						{ className: "ss-card-head" },
						h("div", { className: "ss-avatar" }, avatarLetter(skill.name)),
						h(
							"div",
							{ style: { minWidth: 0, flex: 1 } },
							h(
								"div",
								{ className: "ss-card-title" },
								h("span", { className: "ss-name", "data-link": "", title: skill.name, "aria-label": skill.name, onClick: () => openDetail(skill) }, displayName(skill, ai)),
								cstate === "full"
									? h("span", { className: "ss-state", title: tr("disableHint") }, tr("disabledTag"))
									: cstate === "partial"
										? h("span", { className: "ss-state", title: tr("advancedVisibilityHint") }, tr("partialDisabledTag"))
										: null,
							),
						),
					),
					h("div", { className: "ss-card-desc", "data-zh": ai ? "" : undefined }, ai?.summary || skill.description || "–"),
					failErr
						? h("details", { className: "ss-fail" }, h("summary", null, "⚠ " + failErr.slice(0, 80)), h("div", { className: "ss-fail-body" }, failErr))
						: null,
					h(
						"div",
						{ className: "ss-foot" },
						h(
							"div",
							{ className: "ss-rowbtns" },
							/* 卡片里不给裸开关：没有文字标签的小方框没人知道是干什么的。
							   这里用带字的按钮表达同一个二态开关。 */
							isUserLib
								? Mini({
										children: cstate === "none" ? tr("disable") : tr("enable"),
										title: cstate === "partial" ? tr("partialDisableHint") : cstate === "full" ? tr("disableHint") : tr("enableHint"),
										onClick: () => setDisabled(skill, cstate === "none"),
									})
								: null,
							isUserLib
								? Mini({
										children: tr("remove"),
										danger: true,
										title: tr("removeHint"),
										onClick: async () => {
											const yes = await confirm(tr("removeConfirm"), { tone: "danger", confirmText: tr("remove") });
											if (yes) doRemove(skill);
										},
									})
								: null,
						),
					),
				);
			};

			return h(
				"div",
				{ className: "ss-body" },
				confirmNode,
				h(
					"div",
					{ className: "ss-toolbar" },
					Input({ value: filter, onChange: setFilter, placeholder: tr("filter"), clearable: true, clearLabel: tr("clearInput") }),
					ViewSwitch({ mode: view, onChange: setView }),
					/* 右侧动作组包一层 .ss-toolbar-end：CSS 里早就为这个类写了
					 * margin-left:auto 的分组规则（还有 data-ss-w 下的配套），
					 * 但 JSX 从来没生成过它 —— 那 6 条规则一直是死的。
					 * 不包的后果（430px 容器实测）：.ss-toolbar 是 flex-wrap，
					 * 5 个子项放不下时逐项换行，「AI 分析」留在第一行末尾、
					 * 「刷新」单独掉到第二行，一条工具栏被劈成两半。
					 * 包成一组后，整组作为单个 flex 子项参与换行，要么一起
					 * 留在第一行、要么整体掉到第二行，不会再被拆开。 */
					h(
						"div",
						{ className: "ss-toolbar-end" },
						// 只在"有活可干 / 正在干"时出现：没有待分析项时挂一个灰掉的
						// 「已全部分析」，和工具栏里那些永远点不动的遗留按钮是同一种噪音。
						busy.__t === true || (analyzeOn === true && pendingAnalyze.length > 0)
							? Btn({
									children: busy.__t
										? tr("analyzing") + " " + (busy.__done ?? 0) + "/" + (busy.__total ?? 0)
										: tr("analyze") + " (" + pendingAnalyze.length + ")",
									onClick: doAnalyze,
									disabled: busy.__t === true || pendingAnalyze.length === 0,
									primary: busy.__t !== true,
									title: busy.__t === true ? tr("analyzeHint") : tr("analyzeHint"),
								})
							: null,
						busy.__t === true
							? Btn({ children: tr("analyzeStop"), onClick: stopAnalyze, danger: true, title: tr("analyzeStopHint") })
							: null,
						Btn({ children: state.loading ? tr("scanning") : tr("rescan"), onClick: load, disabled: state.loading || busy.__t === true, title: busy.__t === true ? tr("rescanBusyHint") : undefined }),
					),
				),
				busy.__t === true
					? h(
							"div",
							{ className: "ss-progress" },
							h("i", { style: { width: Math.round(((busy.__done ?? 0) / Math.max(1, busy.__total ?? 1)) * 100) + "%" } }),
						)
					: null,
				totalShown === 0
					? h(
							"div",
							{ className: "ss-center" },
							h("div", { className: "ss-empty-title" }, q === "" ? tr("noSkills") : tr("noMatch")),
							q === "" ? null : h("div", { className: "ss-empty-q" }, filter.trim()),
							q === "" ? null : h("div", { style: { marginTop: 12 } }, Btn({ children: tr("clearFilter"), onClick: () => setFilter("") })),
						)
					: state.groups.map((group) => {
					const skills = sortSkills(
						(group.skills ?? []).filter((s) => matchesQuery(s, aiMap[harnessId(s)], q)),
						"default",
					);
					if (skills.length === 0) return null;
					return h(
						"div",
						{ key: group.key },
						h(
							"div",
							{ className: "ss-group-title" },
							group.title ?? group.key,
							h("span", { className: "ss-group-hint" }, (group.hint ?? "") + " · " + skills.length),
						),
						view === "card"
							? h("div", { className: "ss-grid", key: group.key + "-cards" }, skills.map((s) => harnessCardFor(s, group.key)))
							: h(
								"div",
								{ className: "ss-list" },
								skills.map((skill) => {
								// 只有用户库里的技能可写：内置技能在 app.asar 里（只读），
								// 别的 agent 的库归别人管。
								const isUserLib = group.key === "dsh-user";
								const dstate = disableState(skill);
								const row = { ...skill, id: harnessId(skill) };
								const ai = aiMap[row.id];
								const failErr = failedMap[row.id];
								const aiBusy = busy[row.id + "__ai"] === true;
								/*
								 * 总开关：关掉 = 同时写 disable-model-invocation: true
								 * 和 user-invocable: false，两个面一起关 —— 这才是
								 * "禁用"的完整含义，只关一边都还能被另一条路调到。
								 *
								 * 这是 DSH 原生的 frontmatter 治理键，不是本插件自造的
								 * 状态：关掉后 DSH 自己就不再列给模型、也不再挂到 / 命令，
								 * 不需要重启，也不依赖任何别的插件。
								 *
								 * 细粒度（只关一边）留在详情页的"高级"里 —— 一行摆三个
								 * 开关既挤又容易自相矛盾（总开关显示"启用中"、细粒度却是关的）。
								 */
								const masterSwitch = h(
									"label",
									{
										className: "ss-switch" + (isUserLib ? "" : " readonly"),
										title: isUserLib
											? dstate === "partial"
												? tr("partialDisableHint")
												: dstate === "full"
													? tr("disableHint")
													: tr("enableHint")
											: tr("visibilityReadonlyHint"),
									},
									h("input", {
										type: "checkbox",
										checked: dstate === "none",
										disabled: !isUserLib || rowBusy["disabled:" + skill.dir] === true,
										"aria-label": tr("disable"),
										onChange: isUserLib ? (e) => setDisabled(skill, !e.target.checked) : undefined,
									}),
									// 不再给每个开关挂「启用」两个字：14 行就是 14 次重复，
									// 而「关掉」这一态行内已经有「已停用」文字说明。
								);
								return h(
									"div",
									{
										className: "ss-item",
										key: group.key + "/" + skill.name,
										style: failErr ? { borderColor: "color-mix(in srgb,var(--ss-danger) 40%,transparent)" } : undefined,
									},
									h("div", { className: "ss-icon", "data-letter": "" }, avatarLetter(skill.name)),
									h(
										"div",
										{ className: "ss-main" },
										h(
											"div",
											{ className: "ss-name-row" },
											h("span", { className: "ss-name", "data-link": "", title: skill.name, "aria-label": skill.name, onClick: () => openDetail(skill) }, displayName(skill, ai)),
											dstate === "full"
												? h("span", { className: "ss-state", title: tr("disableHint") }, tr("disabledTag"))
												: dstate === "partial"
													? h("span", { className: "ss-state", title: tr("advancedVisibilityHint") }, tr("partialDisabledTag"))
													: null,
										),
										h("div", { className: "ss-desc", "data-zh": ai ? "" : undefined }, ai?.summary || skill.description || "–"),
										failErr
											? h("details", { className: "ss-fail" }, h("summary", null, "⚠ " + failErr.slice(0, 80)), h("div", { className: "ss-fail-body" }, failErr))
											: null,
									),
									h(
										"div",
										{ className: "ss-side" },
										masterSwitch,
										isUserLib
											? Mini({
													children: tr("remove"),
													danger: true,
													title: tr("removeHint"),
													onClick: async () => {
														const yes = await confirm(tr("removeConfirm"), { tone: "danger", confirmText: tr("remove") });
														if (yes) doRemove(skill);
													},
												})
											: null,
									),
								);
							}),
						),
					);
				}),
				// 详情抽屉挂在列表之后：它只需要"看得见列表"，不需要把列表换掉
				detailNode,
			);
		}

		/* ================================================================ *
		 * 回收站：从用户库删掉的技能先落这里，可恢复 / 彻底删
		 *
		 * 只做列表不做卡片：回收站是"处理待办"的地方，不是浏览挑选的地方，
		 * 多一个视图切换（还得记住偏好）不划算。
		 * ================================================================ */
		function TrashTab() {
			const [state, setState] = react.useState({ loading: true, items: [], dir: "", error: undefined });
			const [toast, setToast] = useToast();
			const [busy, setBusy] = react.useState(false);
			const [confirm, confirmNode] = useConfirm();

			const load = react.useCallback(() => {
				setState((s) => ({ ...s, loading: true, error: undefined }));
				getJson(API.trash)
					.then((d) => setState({ loading: false, items: d.items ?? [], dir: d.dir ?? "", error: undefined }))
					.catch((e) => setState({ loading: false, items: [], dir: "", error: String(e.message ?? e) }));
			}, []);
			react.useEffect(() => {
				load();
			}, [load]);

			/** 三个动作（恢复/彻底删/清空）共用：都是 POST 一下 + 刷新 + 报结果。 */
			const call = async (path, body, okText) => {
				if (busy) return;
				setBusy(true);
				try {
					const r = await sendJson(path, "POST", body);
					if (!r.ok) throw new Error(r.error ?? "failed");
					setToast({ kind: "ok", text: okText });
					load();
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy(false);
				}
			};

			if (state.loading) return h("div", { className: "ss-center" }, tr("scanning"));
			if (state.error !== undefined) return h("div", { className: "ss-body" }, h("div", { className: "ss-err" }, state.error));

			const rowFor = (it) =>
				h(
					"div",
					{ className: "ss-item", key: it.id, "data-broken": it.intact ? undefined : "" },
					h("div", { className: "ss-icon", "data-letter": "" }, avatarLetter(it.name)),
					h(
						"div",
						{ className: "ss-main" },
						h(
							"div",
							{ className: "ss-name-row" },
							h("span", { className: "ss-name" }, it.name),
							// 残缺项（目录被手动删过）只能清理记录，恢复按钮不给
							it.intact ? null : h("span", { className: "ss-tag", "data-off": "" }, tr("trashBroken")),
						),
						h("div", { className: "ss-desc" }, tr("trashOriginalAt") + " · " + (it.originalDirShort || "–")),
						h("div", { className: "ss-desc ss-trash-when" }, tr("trashAt") + " " + String(it.deletedAt).slice(0, 19).replace("T", " ")),
					),
					h(
						"div",
						{ className: "ss-side" },
						it.intact
							? Mini({
									children: tr("trashRestore"),
									disabled: busy,
									onClick: () => call(API.trashRestore, { id: it.id }, tr("trashRestored")),
								})
							: null,
						Mini({
							children: tr("trashPurge"),
							danger: true,
							disabled: busy,
							onClick: async () => {
								const yes = await confirm(tr("trashPurgeConfirm"), { tone: "danger", confirmText: tr("trashPurge") });
								if (yes) call(API.trashPurge, { id: it.id }, tr("trashPurged"));
							},
						}),
					),
				);

			return h(
				"div",
				{ className: "ss-body" },
				confirmNode,
				h(
					"div",
					{ className: "ss-toolbar" },
					h("span", { className: "ss-group-hint" }, tr("trashHint")),
					state.items.length > 0
						? Btn({
								children: tr("trashEmptyAll") + " (" + state.items.length + " " + tr("trashCountUnit") + ")",
								danger: true,
								disabled: busy,
								onClick: async () => {
									const yes = await confirm(tr("trashEmptyConfirm"), { tone: "danger", confirmText: tr("trashEmptyAll") });
									if (yes) call(API.trashEmpty, {}, tr("trashEmptied"));
								},
							})
						: null,
					Btn({ children: tr("rescan"), onClick: load, disabled: busy }),
				),
				state.dir !== "" ? h("div", { className: "ss-meta" }, h("div", { className: "ss-meta-sub" }, state.dir)) : null,
				state.items.length === 0
					? h(
							"div",
							{ className: "ss-center" },
							h("div", { className: "ss-empty-title" }, tr("trashEmptyTitle")),
							h("div", { className: "ss-empty-q" }, tr("trashEmptyDesc")),
						)
					: h("div", { className: "ss-list" }, state.items.map(rowFor)),
			);
		}

		/* ================================================================ *
		 * AI 分析：可复用 hook（Harness / 其他 Agent / 插件 三个 tab 共用）
		 * ================================================================ */

		/**
		 * 技能/插件批量分析的全部状态与动作。
		 * allSkills 里的每一项只需要 { id, name, description, fullText }；
		 * notify(kind, text) 用来弹提示（各 tab 的 toast 实现不一样，从外面传进来）。
		 */
		function useSkillAnalyze(config, allSkills, notify, confirm) {
			const analyzeOn = config?.analyze?.enabled === true;
			const [aiMap, setAiMap] = react.useState({});
			const [failedMap, setFailedMap] = react.useState({});

			/**
			 * 首次点「AI 分析」时确认一次，之后不再拦。
			 *
			 * 分析会把 SKILL.md 全文发给配置的那条通道，而技能文档里夹带密钥是常态 ——
			 * 有人把 API key 直接写进"配置"一节。发出去就收不回来了。
			 *
			 * 后端的 redactSecrets 只认形态规整的密钥（厂商固定前缀、`key=value` 那种），
			 * 改写成散文的、自定义前缀的、贴成图片说明的，它一律认不出。
			 * 所以第一次必须让人自己看见这句话 —— 光靠后端兜底不够。
			 *
			 * 只拦一次：每次点都弹的话，用户三秒后就闭眼确认，提醒反而失效；
			 * 之后靠设置页那段常驻的 analyzePrivacyBody 兜底。
			 */
			const ensureAnalyzeConsent = async () => {
				const CONSENT_KEY = "ss-analyze-consent";
				try {
					if (localStorage.getItem(CONSENT_KEY) === "1") return true;
				} catch { /* 无痕模式读不到 → 照样弹 */ }
				const a = config?.analyze ?? {};
				const target = a.mode === "endpoint"
					? (String(a.baseUrl ?? "").trim() || tr("setModeEndpoint"))
					: tr("setModeHost");
				const yes = await confirm(
					tr("analyzeFirstLead") + "\n\n" + tr("analyzeFirstWhere") + target + "\n\n" + tr("analyzeFirstTail"),
					{ confirmText: tr("analyzeFirstOk") },
				);
				if (yes) {
					try { localStorage.setItem(CONSENT_KEY, "1"); } catch { /* 无痕模式 */ }
				}
				return yes;
			};
			const [busy, setBusy] = react.useState({});
			// 批量分析跑着的时候置 true，让后续分组停下来（已经跑完的照常保留）
			const cancelAnalyzeRef = react.useRef(false);

			// 后端在 scan/harness/plugins 里注入的缓存命中，用这个合并进来
			const adoptServer = react.useCallback((m) => {
				if (m && Object.keys(m).length > 0) setAiMap((prev) => ({ ...prev, ...m }));
			}, []);

			// 有正文/描述但 ai 缺失或 ai.title 为空的都算待分析：旧缓存无 title
			// 会被后端视为未命中，前端必须把它重新送回去补齐。
			const pendingAnalyze = allSkills.filter((s) => {
				const ai = aiMap[s.id];
				if (ai === undefined || ai === null) return Boolean(s.fullText || s.description);
				if (!hasDisplayTitle(ai)) return Boolean(s.fullText || s.description);
				return false;
			});
			// 灰掉的时候要能说清是"没东西可分析"还是"都分析完了"，不然就是个死按钮
			const analyzeAllDone = analyzeOn && allSkills.length > 0 && pendingAnalyze.length === 0;
			const analyzeNone = allSkills.length === 0;

			// 调度放在前端：一次请求带 batchSize 条、同时飞 concurrency 路。
			// 之前是把所有待分析塞进一个请求、等服务端跑完才返回 —— 请求期间 React 不更新，
			// 进度条全程 0%、最后一秒跳 100%，等于摆设。按请求粒度推进，每完成一条就走一格。
			// （batchSize 服务端上限 40，每条正文上限 8KB → 单请求最多约 640KB，2MB 请求体上限够用）
			const doAnalyze = async () => {
				const targets = pendingAnalyze;
				if (targets.length === 0) return;
				if (!(await ensureAnalyzeConsent())) return;
				const perReq = Math.max(1, Math.min(40, Number(config?.analyze?.batchSize) || 1));
				const lanes = Math.max(1, Math.min(10, Number(config?.analyze?.concurrency) || 1));
				const queue = targets.slice();
				const total = targets.length;
				cancelAnalyzeRef.current = false;
				setBusy((b) => ({ ...b, __t: true, __done: 0, __total: total }));
				setFailedMap({});

				let done = 0;
				let fresh = 0;
				let hit = 0;
				let failedCount = 0;
				let truncated = false;
				let disabledHint;
				// 连续 3 个请求都全失败就熔断：端点挂了还傻跑只会把等待时间拉长十几倍
				let consecutiveFails = 0;

				const runLane = async () => {
					while (true) {
						if (cancelAnalyzeRef.current || consecutiveFails >= 3) return;
						const chunk = queue.splice(0, perReq);
						if (chunk.length === 0) return;
						const keys = chunk.map((s) => s.id);
						try {
							const items = chunk.map((s) => ({ key: s.id, name: s.name, description: s.description, fullText: s.fullText ?? "" }));
							const data = await sendJson(API.analyze, "POST", { items });
							consecutiveFails = 0;
							if (data.disabled) {
								disabledHint = data.code === "analyze-disabled" ? tr("analyzeDisabled") : (data.hint ?? tr("analyzeDisabled"));
								return;
							}
							setAiMap((prev) => ({ ...prev, ...(data.analyses ?? {}) }));
							// analyzed 是这一轮真调了模型的；analyses 里还含缓存命中的
							fresh += Number(data.analyzed ?? 0);
							hit += Number(data.cached ?? 0);
							if (data.truncated === true) truncated = true;
							const failedList = data.failed ?? [];
							if (failedList.length > 0) {
								failedCount += failedList.length;
								setFailedMap((prev) => ({ ...prev, ...Object.fromEntries(failedList.map((f) => [f.key, f.error])) }));
							}
						} catch (e) {
							consecutiveFails += 1;
							failedCount += keys.length;
							setFailedMap((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, String(e.message ?? e)])) }));
						} finally {
							done += chunk.length;
							setBusy((b) => ({ ...b, __done: Math.min(total, done) }));
						}
					}
				};

				const laneCount = Math.min(lanes, Math.max(1, Math.ceil(queue.length / perReq)));
				try {
					await Promise.all(Array.from({ length: laneCount }, runLane));
					if (disabledHint) {
						notify("err", disabledHint);
					} else if (consecutiveFails >= 3) {
						notify("err", tr("analyzeFail") + " ×" + failedCount + "，" + tr("analyzeCircuitBreak"));
					} else if (truncated) {
						notify("err", tr("analyzeTruncated"));
					} else if (fresh > 0 || failedCount === 0) {
						notify("ok", tr("analyzed") + " ×" + fresh + (hit > 0 ? "，" + tr("analyzedCached") + " ×" + hit : "") + (failedCount > 0 ? "，" + tr("failures") + " ×" + failedCount : ""));
					} else {
						notify("err", tr("failures") + " ×" + failedCount);
					}
				} catch (e) {
					notify("err", tr("analyzeFail") + ": " + String(e.message ?? e));
				} finally {
					setBusy((b) => ({ ...b, __t: false, __done: 0, __total: 0 }));
				}
			};

			const stopAnalyze = () => {
				cancelAnalyzeRef.current = true;
			};

			// 单独分析一个
			const doAnalyzeOne = async (skill) => {
				if (!(await ensureAnalyzeConsent())) return;
				const bkey = skill.id + "__ai";
				setBusy((b) => ({ ...b, [bkey]: true }));
				sendJson(API.analyze, "POST", { items: [{ key: skill.id, name: skill.name, description: skill.description, fullText: skill.fullText ?? "" }] })
					.then((data) => {
						if (data.disabled) { notify("err", data.code === "analyze-disabled" ? tr("analyzeDisabled") : (data.hint ?? tr("analyzeDisabled"))); return; }
						const a = data.analyses?.[skill.id];
						if (a) setAiMap((prev) => ({ ...prev, [skill.id]: a }));
						else {
							const d = (data.failed ?? []).find((f) => f.key === skill.id)?.error;
							notify("err", d || tr("analyzeFail"));
						}
					})
					.catch((e) => notify("err", String(e.message ?? e)))
					.finally(() => setBusy((b) => ({ ...b, [bkey]: false })));
			};

			return {
				analyzeOn, aiMap, setAiMap, adoptServer,
				failedMap, setFailedMap, busy, setBusy,
				pendingAnalyze, analyzeAllDone, analyzeNone,
				doAnalyze, doAnalyzeOne, stopAnalyze,
			};
		}

		/* ================================================================ *
		 * tab 2: 其他 Agent 的技能
		 * ================================================================ */

		function AgentsTab(props) {
			const config = props.config;
			const [view, setView] = useViewMode("agents", "card");
			const [scan, setScan] = react.useState({ loading: true, groups: [], total: 0, error: undefined });
			const [filter, setFilter] = react.useState("");
			const [detail, setDetail] = react.useState(undefined);
			const [toast, setToast] = useToast();
			const [confirm, confirmNode] = useConfirm();
			const [activeSource, setActiveSource] = react.useState(undefined);
			// 排序 / 筛选：只在"来源内部"那一屏生效（就是 176 条的那个列表）
			const [sort, setSort] = react.useState("default");
			const [onlyNew, setOnlyNew] = react.useState(false);
			/**
			 * 批量导入。undefined = 不在批量模式。
			 * - picked：勾中的 skill.id
			 * - policy：撞名策略。默认 skip（最保守，不动用户库里已有的东西）
			 * - results：跑完才有，用来出「成功/跳过/失败」小结
			 */
			const [batch, setBatch] = react.useState(undefined);
			/** 停止标志。用一个 ref 让循环能读到最新值，不用等 state 回流。 */
			const stopRef = react.useRef(false);

			const sources = (scan.groups?.external ?? []).concat(scan.groups?.shared ?? []);
			const allSkills = sources.flatMap((s) => (s.skills ?? []).map((k) => ({ ...k, sourceLabel: s.label, sourcePath: s.path })));
			const {
				analyzeOn, aiMap, failedMap, busy, setBusy,
				pendingAnalyze, analyzeAllDone, analyzeNone,
				doAnalyze, doAnalyzeOne, stopAnalyze, adoptServer,
			} = useSkillAnalyze(config, allSkills, (kind, text) => setToast({ kind, text }), confirm);

			const load = react.useCallback(() => {
				setScan((s) => ({ ...s, loading: true, error: undefined }));
				getJson(API.scan)
					.then((data) => {
						// 把后端注入的 aiAnalysis 合并到 aiMap。
						// 注意用 hook 的 adoptServer —— 之前这里直接调 setAiMap，但那个变量
						// 已被抽进 hook 里、解构里没有，一跑就 ReferenceError，
						// catch 把整个 scan 置成 error，"其他 Agent" tab 就空了。
						const m = {};
						for (const list of Object.values(data.groups ?? {})) {
							for (const g of list ?? []) {
								for (const s of g.skills ?? []) {
									if (s.aiAnalysis) m[s.id] = s.aiAnalysis;
								}
							}
						}
						adoptServer(m);
						setScan({ loading: false, groups: data.groups ?? {}, total: data.total ?? 0, harnessDir: data.harnessDir, error: undefined });
					})
					.catch((e) => setScan({ loading: false, groups: [], total: 0, error: String(e.message ?? e) }));
			}, [adoptServer]);

			react.useEffect(() => {
				load();
			}, [load]);

			const q = filter.trim().toLowerCase();
			const visible = q === "" ? allSkills : allSkills.filter((s) => matchesQuery(s, aiMap[s.id], q));
			// 来源选择页的搜索框之前是死的：toolbar 接了 setFilter，但下面 sources.map
			// 完全不读 filter，打字没有任何反应。这里让它同时匹配来源名、路径、
			// 以及该来源下的技能名，这样"搜技能名 → 定位到哪个来源"也能用。
			const visibleSources =
				q === ""
					? sources
					: sources.filter((s) =>
							(String(s.label ?? "") + " " + String(s.path ?? "") + " " + (s.skills ?? []).map((k) => k.name + " " + displayName(k, aiMap[k.id])).join(" "))
								.toLowerCase()
								.includes(q),
						);

			/**
			 * 「未导入」用的是后端算好的 imported：按**落盘目录名**比对
			 * （和 importSkill 同一个 safeFolderName）。旧判据是"技能自己的路径在不在
			 * 用户库下"，对来源技能恒为 false，所以这个筛选以前根本无从谈起。
			 *
			 * 另外要先按 activeSource 收敛：`visible` 是全量（含所有来源），
			 * 而这一屏只渲染当前来源那一组 —— 拿全量去数，在 Hermes(158) 里会显示成 174，
			 * 「全选未导入」还会把别的来源的 id 一起勾进来（计数和实际导入条数对不上）。
			 */
			const scoped =
				activeSource === undefined || activeSource === "__all__"
					? visible
					: visible.filter((s) => s.sourceLabel + "|" + s.sourcePath === activeSource);
			const newSkills = scoped.filter((s) => s.imported !== true);
			const shown = onlyNew ? newSkills : scoped;

			/** 勾选按当前列表顺序取，进度条才是从上往下走的。 */
			const pickedSkills = () => {
				const picked = batch?.picked ?? new Set();
				return shown.filter((s) => picked.has(s.id));
			};
			const togglePick = (id) => {
				setBatch((b) => {
					if (b === undefined) return b;
					const picked = new Set(b.picked);
					if (picked.has(id)) picked.delete(id);
					else picked.add(id);
					return { ...b, picked };
				});
			};

			const doImport = async (skill, overwrite) => {
				setBusy((b) => ({ ...b, [skill.id]: true }));
				try {
					const result = await sendJson(API.importSkill, "POST", { dir: skill.dir, name: skill.name, overwrite });
					if (result.ok) setToast({ kind: "ok", text: tr("installed") + ": " + result.dest });
					else if (result.error === "exists" && !overwrite) {
						const yes = await confirm(tr("reimport") + "?\n" + result.dest, { tone: "danger", confirmText: tr("reimport") });
						if (yes) {
							setBusy((b) => ({ ...b, [skill.id]: false }));
							return await doImport(skill, true);
						}
					} else setToast({ kind: "err", text: String(result.error) });
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy((b) => ({ ...b, [skill.id]: false }));
				}
			};

			/**
			 * 批量导入。
			 * 逐条打的是同一个 /import 路由 —— 单条导入的落盘规则、越界校验、
			 * 存在性判断都已经过审，批量没必要另开一套服务端逻辑，
			 * 这里只做循环 + 汇总。串行而不是并发：同一个目录里并发 cp
			 * 一旦撞名会互相踩，而且串行的进度条也更诚实。
			 *
			 * 失败不回滚：copyDir 是"要么整份复制要么报错"，而回滚意味着去删
			 * 用户库里已经成功的那几份，风险远大于收益。所以只如实报告，并把
			 * 这条承诺写在界面上。
			 */
			const runBatch = async () => {
				if (batch === undefined) return;
				const items = pickedSkills();
				if (items.length === 0) {
					setToast({ kind: "err", text: tr("noPicked") });
					return;
				}
				const overwrite = batch.policy === "overwrite";
				stopRef.current = false;
				setBatch((b) => ({ ...b, running: true, done: 0, total: items.length, results: undefined }));
				const acc = { ok: 0, skipped: 0, fail: 0, fails: [] };
				for (const skill of items) {
					if (stopRef.current) break;
					try {
						const r = await sendJson(API.importSkill, "POST", { dir: skill.dir, name: skill.name, overwrite });
						if (r.ok) acc.ok += 1;
						else if (r.error === "exists") acc.skipped += 1;
						else {
							acc.fail += 1;
							acc.fails.push(skill.name + ": " + String(r.error));
						}
					} catch (e) {
						acc.fail += 1;
						acc.fails.push(skill.name + ": " + String(e.message ?? e));
					}
					setBatch((b) => (b === undefined ? b : { ...b, done: (b.done ?? 0) + 1 }));
				}
				setBatch((b) => (b === undefined ? b : { ...b, running: false, results: acc }));
				// 全成功就不弹 toast 了 —— 批量条里那条持久的"成功 N · 跳过 N"小结
				// 说的是同一件事，再弹一次只是重复播报。有失败才需要把人叫住。
				if (acc.fail > 0) {
					setToast({ kind: "err", text: tr("batchSummary") + "：" + tr("batchFailLabel") + " " + acc.fail });
				}
				// 导入改变了用户库内容 → 重新扫一遍，让「已在 DSH」与「只看未导入」跟上
				load();
			};

			/** 批量模式下的勾选框；不在批量模式就不渲染，列表保持干净。 */
			const pickBox = (skill) =>
				batch === undefined
					? null
					: h("input", {
							type: "checkbox",
							className: "ss-check",
							checked: batch.picked.has(skill.id),
							disabled: batch.running === true,
							"aria-label": skill.name,
							title: skill.name,
							onChange: () => togglePick(skill.id),
						});

			const openDetail = (skill) => {
				setDetail({ skill, loading: true });
				getJson(API.skill + "?dir=" + encodeURIComponent(skill.dir))
					.then((data) => setDetail({ skill, content: data.content ?? "" }))
					.catch((e) => setDetail({ skill, error: String(e.message ?? e) }));
			};

			/**
			 * 其他 Agent 的详情 —— 和技能库、插件市场共用同一个抽屉外壳。
			 *
			 * 原来这里也是"整页替换 + ← 返回"，而且 AI 那块是就地写的 inline 样式，
			 * 和技能库、插件抽屉的同一份摘要长三样。现在归 AiBlock 统一渲染。
			 *
			 * 这一屏没有可写字段（别人的技能库），所以没有可见性折叠块；
			 * 主操作是"导入 DSH"，放底部 —— 和插件市场的"安装"同一个位置。
			 */
			const detailNode =
				detail === undefined
					? null
					: (() => {
							const dsk = detail.skill ?? {};
							const dId = dsk.id;
							const dAi = aiMap[dId];
							const dAiBusy = busy[dId + "__ai"] === true;
							const dImportBusy = busy[dId] === true;
							const dText = String(detail.content ?? "").trim() !== "" ? detail.content : (dsk.description ?? "");
							const chips = [];
							if (dsk.imported) chips.push(h("span", { key: "in", className: "ss-state" }, tr("imported")));
							return h(DetailDrawer, {
								onClose: () => setDetail(undefined),
								loading: detail.loading === true,
								head: [
									h("div", { key: "icon", className: "ss-avatar" }, avatarLetter(dsk.name)),
									h(
										"div",
										{ key: "title", style: { minWidth: 0, flex: 1 } },
										h("div", { className: "ss-drawer-title", title: dsk.name ?? "" }, dsk.name ?? ""),
										hasDisplayTitle(dAi) && displayName(dsk, dAi) !== String(dsk.name ?? "")
											? h("div", { className: "ss-drawer-subtitle" }, displayName(dsk, dAi))
											: null,
										dsk.dir ? h("div", { className: "ss-drawer-handle" }, dsk.dir) : null,
									),
								],
								body: [
									chips.length > 0 ? h("div", { key: "chips", className: "ss-chips ss-drawer-tags" }, chips) : null,
									h(AiBlock, {
										key: "ai",
										ai: dAi,
										busy: dAiBusy,
										failErr: failedMap[dId],
										hint: analyzeOn ? undefined : tr("analyzeDisabled"),
										onAnalyze: hasDisplayTitle(dAi) || !analyzeOn ? undefined : () => doAnalyzeOne(dsk),
									}),
									// 来源：别人的技能库，点进详情最该知道"这是谁家的、在哪"
									h(
										"div",
										{ key: "src", className: "ss-origin" },
										h(
											"div",
											{ className: "ss-origin-row" },
											h("span", { className: "ss-tag", "data-apikey": "" }, dsk.sourceLabel ?? "–"),
											h("span", { className: "ss-origin-label", title: dsk.sourcePath }, dsk.sourcePath ?? ""),
										),
										(() => {
											const raw = String(dsk.sourceUrl ?? "").trim();
											const href = typeof safeHref === "function" ? safeHref(raw) : raw;
											return href !== ""
												? h(
														"div",
														{ className: "ss-origin-row", key: "home" },
														h("a", { className: "ss-link", href, target: "_blank", rel: "noreferrer noopener" }, tr("pmOpenPage")),
													)
												: null;
										})(),
									),
									detail.error
										? h("div", { key: "err", className: "ss-err" }, detail.error)
										: h(Markdown, { key: "md", text: dText || "–" }),
								],
								foot: [
									Btn({
										key: "import",
										primary: true,
										children: dImportBusy ? tr("importing") : dsk.imported ? tr("reimport") : tr("import"),
										title: dsk.imported ? tr("importedHint") : undefined,
										onClick: () => doImport(dsk, false),
										disabled: dImportBusy,
									}),
								],
							});
						})();

			// 按来源分组显示（分组内再按当前选的排序规则排）
			const bySource = new Map();
			for (const skill of shown) {
				const key = skill.sourceLabel + "|" + skill.sourcePath;
				if (!bySource.has(key)) bySource.set(key, { label: skill.sourceLabel, path: skill.sourcePath, skills: [] });
				bySource.get(key).skills.push(skill);
			}
			const sourceGroups = [...bySource.entries()].map(([key, g]) => ({ key, ...g, skills: sortSkills(g.skills, sort) }));

			// 列表模式的行（AgentsTab 的技能）
			const agentRow = (skill) => {
				const ai = aiMap[skill.id];
				const failErr = failedMap[skill.id];
				const aiBusy = busy[skill.id + "__ai"] === true;
				const itemBusy = busy[skill.id] === true;
				return h(
					"div",
					{
						className: "ss-item",
						key: skill.id,
						"data-picked": batch?.picked.has(skill.id) ? "" : undefined,
						style: failErr ? { borderColor: "color-mix(in srgb,var(--ss-danger) 40%,transparent)" } : undefined,
					},
					pickBox(skill),
					h("div", { className: "ss-icon", "data-letter": "" }, avatarLetter(skill.name)),
					h(
						"div",
						{ className: "ss-main" },
						h(
							"div",
							{ className: "ss-name-row" },
							h("span", { className: "ss-name", "data-link": "", title: skill.name, "aria-label": skill.name, onClick: () => openDetail(skill) }, displayName(skill, ai)),
							// 已经在某个来源内部了，就不用每条都重复来源名（158 条技能 = 158 次噪音）；
							// 只有「浏览全部」时才需要它来区分归属
							activeSource === "__all__" ? h("span", { className: "ss-state" }, skill.sourceLabel ?? "") : null,
							skill.imported ? h("span", { className: "ss-state", title: tr("importedHint") }, tr("imported")) : null,
							failErr
								? h("span", { className: "ss-state", title: failErr }, "✗ " + tr("failures"))
								: null,
						),
						h("div", { className: "ss-desc", "data-zh": ai ? "" : undefined }, ai?.summary || skill.description || "–"),
						failErr
							? h("details", { className: "ss-fail" }, h("summary", null, "⚠ " + failErr.slice(0, 80)), h("div", { className: "ss-fail-body" }, failErr))
							: null,
					),
					h(
						"div",
						{ className: "ss-side" },
						Mini({
							children: itemBusy ? tr("importing") : skill.imported ? tr("reimport") : tr("import"),
							// 这里恒定传 false，让"撞名"由服务端返回 exists 后再弹确认。
							// 不能传 skill.imported —— 现在它意味着"同名已存在"，直接传 true
							// 会让服务端跳过存在性检查、闷头覆盖掉用户库里的技能。
							onClick: () => doImport(skill, false),
							disabled: itemBusy,
							title: skill.imported ? tr("importedHint") : undefined,
						}),
					),
				);
			};

			// === 状态2：查看某个来源的技能列表（__all__=全部） ===
			if (activeSource !== undefined) {
				const groups = activeSource === "__all__" ? sourceGroups : [sourceGroups.find((x) => x.key === activeSource)].filter(Boolean);
				const label = activeSource === "__all__" ? tr("allSources") : (sourceGroups.find((x) => x.key === activeSource)?.label ?? activeSource);

				/**
				 * 批量导入条。
				 * 撞名策略摆在这里、点「导入选中」之前就看得见，比跑完再补一个
				 * "要不要覆盖"的模态清楚得多；默认 skip（不动用户库里已有的东西）。
				 */
				const batchBar =
					batch === undefined
						? null
						: h(
								"div",
								{ className: "ss-batchbar" },
								h("span", { className: "ss-batch-count" }, tr("selectedCount") + " " + batch.picked.size + " " + tr("itemsUnit")),
								Mini({ children: tr("selectAll"), onClick: () => setBatch((b) => ({ ...b, picked: new Set(shown.map((s) => s.id)) })), disabled: batch.running === true }),
								Mini({ children: tr("selectUnimported"), onClick: () => setBatch((b) => ({ ...b, picked: new Set(newSkills.map((s) => s.id)) })), disabled: batch.running === true }),
								Mini({ children: tr("selectNone"), onClick: () => setBatch((b) => ({ ...b, picked: new Set() })), disabled: batch.running === true }),
								h(
									"span",
									{ className: "ss-batch-policy" },
									h("span", { className: "ss-batch-label" }, tr("policyLabel")),
									h(
										"div",
										{ className: "ss-seg", role: "group" },
										[
											["skip", tr("policySkip"), tr("policySkipHint")],
											["overwrite", tr("policyOverwrite"), tr("policyOverwriteHint")],
										].map(([id, text, hint]) =>
											h(
												"button",
												{
													key: id,
													type: "button",
													className: "ss-seg-btn" + (batch.policy === id ? " on" : ""),
													"aria-pressed": batch.policy === id,
													title: hint,
													disabled: batch.running === true,
													onClick: () => setBatch((b) => ({ ...b, policy: id })),
												},
												text,
											),
										),
									),
								),
								Btn({
									children: batch.running === true ? tr("importing") + " " + batch.done + "/" + batch.total : tr("runBatch"),
									onClick: runBatch,
									disabled: batch.running === true || batch.picked.size === 0,
									primary: batch.running !== true && batch.picked.size > 0,
								}),
								batch.running === true ? Btn({ children: tr("batchStop"), danger: true, onClick: () => { stopRef.current = true; } }) : null,
							);

				const batchProgress =
					batch?.running === true
						? h("div", { className: "ss-progress" }, h("i", { style: { width: Math.round(((batch.done ?? 0) / Math.max(1, batch.total ?? 1)) * 100) + "%" } }))
						: null;

				const batchResult =
					batch?.results === undefined
						? null
						: h(
								"div",
								{ className: "ss-batch-result" },
								h("b", null, tr("batchSummary") + "："),
								h("span", { className: "ss-ok" }, "✓ " + tr("batchOkLabel") + " " + batch.results.ok),
								h("span", null, "· " + tr("batchSkipLabel") + " " + batch.results.skipped),
								h("span", { className: batch.results.fail > 0 ? "ss-err" : undefined }, "· " + tr("batchFailLabel") + " " + batch.results.fail),
								h("span", { className: "ss-batch-note" }, tr("batchRollbackNote")),
								batch.results.fails.length > 0
									? h(
											"details",
											{ className: "ss-fail" },
											h("summary", null, tr("batchFailDetail") + " (" + batch.results.fails.length + ")"),
											h("div", { className: "ss-fail-body" }, batch.results.fails.join("\n")),
											h("button", { type: "button", className: "ss-mini", onClick: () => copyText(batch.results.fails.join("\n")) }, tr("copy")),
										)
									: null,
							);

				return h(
					"div",
					{ className: "ss-body" },
					h(
						"div",
						{ className: "ss-toolbar" },
						Btn({ children: "← " + tr("back"), onClick: () => setActiveSource(undefined) }),
						h("div", { style: { flex: 1 } }, h("b", null, label)),
						ViewSwitch({ mode: view, onChange: setView }),
						Btn({ children: scan.loading ? tr("scanning") : tr("rescan"), onClick: load, disabled: scan.loading || batch?.running === true }),
					),
					// 来源内部子工具栏：搜索 / 排序 / 只看未导入 / 批量导入。
					// 这一屏此前连搜索框都没有（筛选框只挂在来源选择页），158 条只能靠眼睛翻。
					h(
						"div",
						{ className: "ss-listbar" },
						Input({ value: filter, onChange: setFilter, placeholder: tr("filter"), clearable: true, clearLabel: tr("clearInput") }),
						h(
							"div",
							{ className: "ss-seg", role: "group", "aria-label": tr("sortLabel") },
							[
								["default", tr("sortDefault")],
								["unimported", tr("sortUnimported")],
							].map(([id, text]) =>
								h(
									"button",
									{
										key: id,
										type: "button",
										className: "ss-seg-btn" + (sort === id ? " on" : ""),
										"aria-pressed": sort === id,
										title: tr("sortLabel") + ": " + text,
										onClick: () => setSort(id),
									},
									text,
								),
							),
						),
						h(
							"button",
							{
								type: "button",
								className: "ss-chip",
								"data-active": onlyNew ? "" : undefined,
								"aria-pressed": onlyNew,
								title: tr("onlyUnimported"),
								onClick: () => setOnlyNew((v) => !v),
							},
							tr("onlyUnimported") + " (" + newSkills.length + ")",
						),
						Btn({
							children: batch === undefined ? tr("batchMode") : tr("batchExit"),
							onClick: () => setBatch(batch === undefined ? { picked: new Set(), policy: "skip", running: false, done: 0, total: 0 } : undefined),
							disabled: batch?.running === true,
							title: tr("batchMode"),
						}),
					),
					batchProgress,
					batchBar,
					batchResult,
					groups.length === 0
						? h(
								"div",
								{ className: "ss-center" },
								h("div", { className: "ss-empty-title" }, q !== "" ? tr("noMatch") : onlyNew ? tr("allImported") : tr("noSkills")),
								q !== "" ? h("div", { className: "ss-empty-q" }, filter.trim()) : null,
								q !== "" || onlyNew
									? h(
											"div",
											{ style: { marginTop: 12 } },
											Btn({
												children: tr("clearFilter"),
												onClick: () => {
													// 只清掉真正让列表变空的那个条件
													if (q !== "") setFilter("");
													else setOnlyNew(false);
												},
											}),
										)
									: null,
							)
						: groups.map((g) => h(
								"div",
								{ key: g.key, style: { marginBottom: 16 } },
								activeSource === "__all__" ? h("div", { className: "ss-group-title" }, g.label, h("span", { className: "ss-path" }, g.path)) : null,
								view === "list"
									? h("div", { className: "ss-list" }, g.skills.map(agentRow))
									: h(
										"div",
										{ className: "ss-grid" },
										g.skills.map((skill) => {
											const ai = aiMap[skill.id];
										const failErr = failedMap[skill.id];
										const text = ai?.summary ?? skill.description;
										const itemBusy = busy[skill.id] === true;
										const aiBusy = busy[skill.id + "__ai"] === true;
										return h(
											"div",
											{ className: "ss-card", key: skill.id, "data-analyzed": ai ? "" : undefined, style: failErr ? { borderColor: "color-mix(in srgb,var(--ss-danger) 40%,transparent)" } : undefined },
											h(
												"div",
												{ className: "ss-card-head" },
												pickBox(skill),
												h("div", { className: "ss-avatar" }, avatarLetter(skill.name)),
												h("div", { style: { minWidth: 0, flex: 1 } },
													h("div", { className: "ss-card-title" },
														h("span", { className: "ss-name", "data-link": "", title: skill.name, "aria-label": skill.name, onClick: () => openDetail(skill) }, displayName(skill, ai)),
													),
												),
											skill.imported
												? h("span", { className: "ss-state", title: tr("importedHint") }, tr("imported"))
												: null,
											),
											h("div", { className: "ss-card-desc", "data-zh": ai ? "" : undefined }, text || "–"),
											failErr
												? h(
														"details",
														{ className: "ss-fail" },
														h("summary", null, "⚠ " + failErr.slice(0, 80)),
														h("div", { className: "ss-fail-body" }, failErr),
														h("button", { type: "button", className: "ss-mini", onClick: () => copyText(failErr) }, tr("copy")),
													)
												: null,
											h(
												"div",
												{ className: "ss-foot" },
												h(
													"div",
													{ className: "ss-rowbtns" },
													Mini({
														children: itemBusy ? tr("importing") : skill.imported ? tr("reimport") : tr("import"),
														// 同上：恒定 false，撞名交给服务端返回 exists 再弹确认
														onClick: () => doImport(skill, false),
														disabled: itemBusy,
														title: skill.imported ? tr("importedHint") : undefined,
													}),
												),
											),
										);
									}),
								),
							)),
					confirmNode,
					// 详情抽屉挂在列表之后：浮层盖在上面，底下的列表和滚动位置都留着。
					// openDetail 只在这个状态里有入口（来源选择页列的是来源、不是技能）。
					detailNode,
				);
			}

			// === 状态1：来源选择页（图5样式） ===
			return h(
				"div",
				{ className: "ss-body" },
				h(
					"div",
					{ className: "ss-toolbar" },
					Input({ value: filter, onChange: setFilter, placeholder: tr("filter"), clearable: true, clearLabel: tr("clearInput") }),
					// 动作组：浏览全部（主）+ AI 分析 + 停止 + 刷新。
					// 以前「浏览全部技能」单独占一行、AI 分析也是主按钮，一屏里两个蓝色
					// 大按钮各占一行，左对齐长度不一 —— 真机截图看着就是"不齐"。
					// 现在收成一组：宽屏靠右、窄屏自然换行，一屏只有一个主操作。
					h(
						"div",
						{ className: "ss-toolbar-end" },
						Btn({
							children: tr("browseAll") + (allSkills.length ? " (" + allSkills.length + ")" : ""),
							onClick: () => setActiveSource("__all__"),
							disabled: allSkills.length === 0,
							primary: true,
						}),
						Btn({
							children: busy.__t
								? tr("analyzing") + " " + (busy.__done ?? 0) + "/" + (busy.__total ?? 0)
								: analyzeAllDone
									? tr("analyzeAllDone")
									: tr("analyze") + (pendingAnalyze.length ? " (" + pendingAnalyze.length + ")" : ""),
							onClick: doAnalyze,
							disabled: busy.__t === true || pendingAnalyze.length === 0,
							title: busy.__t === true
								? tr("analyzeHint")
								: analyzeOn !== true
									? tr("analyzeDisabled")
									: analyzeNone
										? tr("analyzeNoSkills")
										: analyzeAllDone
											? tr("analyzeAllDoneHint")
											: tr("analyzeHint"),
						}),
						busy.__t === true
							? Btn({ children: tr("analyzeStop"), onClick: stopAnalyze, danger: true, title: tr("analyzeStopHint") })
							: null,
						Btn({ children: scan.loading ? tr("scanning") : tr("rescan"), onClick: load, disabled: scan.loading || busy.__t === true, title: busy.__t === true ? tr("rescanBusyHint") : undefined }),
					),
				),
				busy.__t === true
					? h(
							"div",
							{ className: "ss-progress" },
							h("i", { style: { width: Math.round(((busy.__done ?? 0) / Math.max(1, busy.__total ?? 1)) * 100) + "%" } }),
						)
					: null,
				scan.loading && allSkills.length === 0
					? h("div", { className: "ss-center" }, tr("scanning"))
					: h(
							"div",
							null,
							// 来源卡片网格（「浏览全部技能」已并进上面那行动作组，
							// 不再自己占一行 —— 两个主按钮各占一行是上一版"不齐"的来源）
							visibleSources.length === 0
								? h(
										"div",
										{ className: "ss-center" },
										h("div", { className: "ss-empty-title" }, tr("noMatch")),
										h("div", { className: "ss-empty-q" }, filter.trim()),
										h("div", { style: { marginTop: 12 } }, Btn({ children: tr("clearFilter"), onClick: () => setFilter("") })),
									)
								: h(
								"div",
								{ className: "ss-src-grid" },
								visibleSources.map((s) => {
									const cnt = (s.skills ?? []).length;
									const missing = s.missing === true;
									return h(
										"div",
										{
											className: "ss-src-card",
											"data-missing": missing ? "" : undefined,
											// 这是进入某个来源技能列表的唯一入口，之前是纯 div：
											// Tab 到不了、回车也进不去，键盘用户被彻底挡住
											role: missing ? undefined : "button",
											tabIndex: missing ? undefined : 0,
											"aria-label": String(s.label ?? "") + " · " + cnt + " " + tr("skillsUnit"),
											onClick: () => { if (!missing) setActiveSource(s.label + "|" + s.path); },
											onKeyDown: (e) => {
												if (missing) return;
												if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
													e.preventDefault();
													setActiveSource(s.label + "|" + s.path);
												}
											},
										},
										h(
											"div",
											{ className: "ss-src-card-head" },
											h("div", { className: "ss-avatar" }, avatarLetter(s.label)),
											h(
												"div",
												{ style: { minWidth: 0, flex: 1 } },
												h("div", { className: "ss-name" }, s.label),
												h("div", { className: "ss-path" }, s.path),
											),
											// 数量做成右侧胶囊：以前是卡片底部一行 26px 的粗体大字，
											// 一屏四张卡就是四个大数字，压过标题、也不齐。
											h(
												"div",
												{ className: "ss-src-card-count" },
												missing ? tr("dirMissing") : cnt + " " + tr("skillsUnit"),
											),
										),
									);
								}),
							),
						),
				confirmNode,
			);
		}

		/* ================================================================ *
		 * tab 3: 插件（本机已装的 dsh 插件：浏览 / 启停 / 更新 / AI 说明）
		 * ================================================================ */

		function PluginsTab(props) {
			const config = props.config;
			const [view, setView] = useViewMode("plugins", "card");
			const [state, setState] = react.useState({ loading: true, groups: [], total: 0, error: undefined });
			const [filter, setFilter] = react.useState("");
			// 「只看可更新」：更新一多，用户想先处理这些，不必在长列表里找
			const [onlyUpdatable, setOnlyUpdatable] = react.useState(false);
			// 二级页面（替代行内展开/抽屉）：点插件 → 整块切到详情页，带返回。
			// 和原生插件页同一心智（列表 → 子页 → 返回列表），一屏只讲一个插件。
			const [openId, setOpenId] = react.useState(undefined);
			const openDetail = (item) => setOpenId(item.id);
			const closeDetail = () => setOpenId(undefined);
			// ESC 返回列表（键盘路可退）
			react.useEffect(() => {
				if (openId === undefined) return undefined;
				const onKey = (e) => { if (e.key === "Escape") setOpenId(undefined); };
				document.addEventListener("keydown", onKey, true);
				return () => document.removeEventListener("keydown", onKey, true);
			}, [openId]);
			const [toast, setToast] = useToast();
			const [confirm, confirmNode] = useConfirm();
			// 更新检测：宿主给「已装 vs npm 最新版（查不到时退回市场目录）」
			const [status, setStatus] = react.useState(undefined);

			const allSkills = (state.groups ?? []).flatMap((g) => g.skills ?? []);
			const {
				analyzeOn, aiMap, adoptServer, failedMap, busy, setBusy,
				pendingAnalyze, analyzeAllDone, analyzeNone,
				doAnalyze, doAnalyzeOne, stopAnalyze,
			} = useSkillAnalyze(config, allSkills, (kind, text) => setToast({ kind, text }), confirm);

			const loadStatus = react.useCallback(() => {
				getJson(API.marketStatus)
					.then((d) => setStatus(d))
					.catch(() => {});
			}, []);

			const updateOf = (name) => {
				const it = (status?.items ?? []).find((i) => i.name === name);
				return it?.hasUpdate ? it : undefined;
			};
			const updatable = (status?.items ?? []).filter((i) => i.hasUpdate);

			const doUpdate = async (name, spec, silent, version) => {
				const key = name + "__upd";
				if (!silent) {
					const yes = await confirm(tr("pmUpdateConfirm") + "\n" + name);
					if (!yes) return false;
				}
				setBusy((b) => ({ ...b, [key]: true }));
				try {
					// 必须把目标版本一起送过去：profile 里存的是 `^0.26.0` 这类范围，
					// 不带版本的 `pnpm add 包名` 会被 lockfile 判定「已满足」而什么都不装，
					// 却照样返回成功 —— 用户看到「已安装」但版本没变。
					const r = await sendJson(API.pluginInstall, "POST", { spec: spec || name, name, version: version || "" });
					if (r.ok) {
						setToast({ kind: "ok", text: r.hint ?? tr("pmUpdate") });
						// 两个都要刷：status 管「还有没有更新」，plugins 管「版本号显示多少」。
						// 只刷 status 的话，装完了列表里还写着旧版本号 —— 用户看不出成没成功。
						// 装/升级可能让 bundle 重新加载，运行相位缓存一并失效。
						invalidatePhases();
						loadStatus(true);
						if (!silent) load();
						return true;
					}
					setToast({ kind: "err", text: String(r.error ?? r.hint ?? tr("pmUpdateFailed")) });
					return false;
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
					return false;
				} finally {
					setBusy((b) => ({ ...b, [key]: false }));
				}
			};

			// 全部更新：逐个装，跑的时候按钮禁用
			const doUpdateAll = async () => {
				if (updatable.length === 0) return;
				setBusy((b) => ({ ...b, __upd: true, __updDone: 0, __updTotal: updatable.length }));
				try {
					let done = 0;
					for (const it of updatable) {
						await doUpdate(it.name, it.spec, true, it.latest);
						done += 1;
						setBusy((b) => ({ ...b, __updDone: done }));
					}
					// 整批跑完统一刷一次列表（中途每装一个就刷会打断进度显示）
					loadStatus(true);
					load();
				} finally {
					setBusy((b) => ({ ...b, __upd: false }));
				}
			};

			/**
			 * 热重载：不重启 DSH 让磁盘上的插件代码生效。
			 *
			 * 为什么需要它：DSH 会把插件源码的改动排在 HMR 队列里，但**不是存盘即生效** ——
			 * 要等一次 profile 重组（实测：只改文件 15s 内不生效；调一次 /reload 后 1.5s 生效）。
			 * 以前用户只能重启，其实重启只是恰好也触发了一次重组。
			 * 装/卸/升级仍然需要重启（模块解析图变了，ResolutionRouter 会直接拒绝替换）。
			 */
			const doReload = async () => {
				setBusy((b) => ({ ...b, __reload: true }));
				try {
					const r = await sendJson(API.reload, "POST", {});
					if (r.restartRequired === true) {
						setToast({ kind: "err", text: r.hint ?? tr("hotReloadRestart") });
					} else {
						const n = Array.isArray(r.warnings) ? r.warnings.length : 0;
						setToast({
							kind: n > 0 ? "err" : "ok",
							text: n > 0 ? r.warnings.join("\n") : (r.hint ?? tr("hotReloadDone")),
						});
					}
					// 重载会重建槽位与运行时相位，两个缓存都要失效
					invalidatePhases();
					load();
					loadStatus();
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy((b) => ({ ...b, __reload: false }));
				}
			};

			const load = react.useCallback(() => {
				setState((s) => ({ ...s, loading: true, error: undefined }));
				loadStatus();
				getJson(API.plugins)
					.then((data) => {
						const m = {};
						for (const g of data.groups ?? []) {
							for (const s of g.skills ?? []) if (s.aiAnalysis) m[s.id] = s.aiAnalysis;
						}
						adoptServer(m);
						setState({ loading: false, groups: data.groups ?? [], total: data.total ?? 0, error: undefined });
					})
					.catch((e) => setState({ loading: false, groups: [], total: 0, error: String(e.message ?? e) }));
			}, [adoptServer, loadStatus]);

			react.useEffect(() => {
				load();
			}, [load]);

			// 启停：先确认，再打 toggle 接口（服务端双层写 bundles + 补丁层）
			const doToggle = async (item) => {
				const enabled = item.enabled !== true;
				const yes = await confirm((enabled ? tr("pluginEnableConfirm") : tr("pluginDisableConfirm")) + "\n" + item.name);
				if (!yes) return;
				setBusy((b) => ({ ...b, [item.id]: true }));
				try {
					const r = await sendJson(API.pluginToggle, "POST", { name: item.name, enabled });
					if (r.ok) {
						// 用服务端回来**实测**的状态判定，而不是我们请求的值：
						// 落盘成功不等于生效（可能被更高优先级配置压着）。
						// 请求与实测不一致时给 warn 而不是 ok —— 否则用户会以为成功了。
						if (r.overridden === true) {
							setToast({ kind: "err", text: r.hint ?? tr("pluginOverridden") });
						} else {
							setToast({ kind: "ok", text: r.hint ?? tr("pluginManageDone") });
						}
						// 启停热应用后运行相位会变，先让状态缓存失效再重拉列表
						invalidatePhases();
						load();
					} else setToast({ kind: "err", text: String(r.error) });
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy((b) => ({ ...b, [item.id]: false }));
				}
			};

			// 卸载：pnpm rm 可能要跑十几秒，按钮期间显示"卸载中…"
			const doUninstall = async (item) => {
				const yes = await confirm(tr("pluginUninstallConfirm") + "\n" + item.name + "\n\n" + tr("pluginUninstallWarn"), { tone: "danger", confirmText: tr("pluginUninstall") });
				if (!yes) return;
				setBusy((b) => ({ ...b, [item.id + "__rm"]: true }));
				try {
					const r = await sendJson(API.pluginUninstall, "POST", { name: item.name });
					if (r.ok) {
						setToast({ kind: "ok", text: r.hint ?? tr("pluginManageDone") });
						invalidatePhases();
						load();
					} else setToast({ kind: "err", text: String(r.error) });
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy((b) => ({ ...b, [item.id + "__rm"]: false }));
				}
			};
			const q = filter.trim().toLowerCase();
			const visible = allSkills.filter((s) => {
				if (q !== "" && !matchesQuery(s, aiMap[s.id], q)) return false;
				if (onlyUpdatable && updateOf(s.name) === undefined) return false;
				return true;
			});

			/**
			 * 二级页面：一个插件的完整详情（替代抽屉/行内展开）。
			 *
			 * 与原生插件页同一心智：列表 → 子页 → 返回。一屏只讲一个插件，
			 * 没有遮罩、没有挤压、不需要滚动两层。布局按「先认识它、再操作它、
			 * 最后才是细节」排：
			 *   返回 → 头部（图标/名称/版本/状态/描述 + 全部操作）→ AI 说明 → 配置 → README
			 */
			const PluginDetailPage = (props) => {
				const item = props.item;
				const ai = aiMap[item.id];
				const enabled = item.enabled !== false;
				const rmBusy = busy[item.id + "__rm"] === true;
				const aiBusy = busy[item.id + "__ai"] === true;
				const upd = updateOf(item.name);
				// 只有「配置」这一节需要判断有没有内容（它按包名 keyed，能静态判断）。
				// badge / actions 是 list 槽位：贡献者对不认识的 subject 返回 null，
				// 宿主侧判断不了，所以照官方做法直接渲染，空内容自然不占位。
				const hasConfig = useSlotPresence("plugins.bundle.config", item.name);
				// 信息表：官方插件详情也是这套「左标签 / 右值」的事实表。
				// 之前详情页只有两段文字，右侧一大片空白 —— 该有的元数据一个都没露出来。
				const homeHref = safeHref(item.homepage);
				const facts = [
					[tr("pmSpecLabel"), item.sourceSpec || "–"],
					[tr("detailDir"), item.dir || "–"],
				];
				if (homeHref !== "") {
					facts.push([
						tr("pmOpenPage"),
						h("a", { className: "ss-link", href: homeHref, target: "_blank", rel: "noreferrer noopener" }, item.homepage),
					]);
				}
				return h(
					"div",
					{ className: "ss-detail" },
					// 返回：原生页同款面包屑，放在最上方
					h(
						"button",
						{ type: "button", className: "ss-back", onClick: closeDetail },
						h("span", { className: "ss-back-arrow", "aria-hidden": "true" }, "‹"),
						tr("backToList"),
					),
					// 头部三列：头像 / 身份 / 操作。
					// 操作条不再单独占一行 —— 最大化窗口时那一行会横跨 2000px，
					// 开关和卸载分别贴在两端，中间一千多像素全是空的。
					h(
						"header",
						{ className: "ss-detail-head" },
						h("div", { className: "ss-avatar ss-detail-avatar" }, avatarLetter(item.name)),
						h(
							"div",
							{ className: "ss-detail-id" },
							h(
								"div",
								{ className: "ss-detail-title-row" },
								h("h2", { className: "ss-detail-title", title: item.name }, item.name),
								hasDisplayTitle(ai) && displayName(item, ai) !== String(item.name ?? "")
									? h("span", { className: "ss-detail-subtitle" }, displayName(item, ai))
									: null,
								item.version ? h("span", { className: "ss-detail-version" }, "v" + item.version) : null,
								h(PluginRunningBadge, { name: item.name, runtimeError: item.runtimeError, enabled }),
								// 作者注册的状态徽章（如 IM 的"已连接"）：官方放在标题旁
								h(SlotRenderer, { name: "plugins.detail.badge", injectProps: { subject: { name: item.name } } }),
								upd ? h("span", { className: "ss-chip2 upd" }, tr("pmHasUpdate") + " → v" + upd.latest) : null,
							),
							h(
								"div",
								{ className: "ss-detail-meta" },
								item.self === true ? h("span", { className: "ss-state" }, tr("selfPanel")) : null,
								!enabled ? h("span", { className: "ss-state" }, tr("pluginDisabled")) : null,
							),
							h("p", { className: "ss-detail-desc" }, item.description || "–"),
							item.self === true ? h("p", { className: "ss-note" }, tr("selfDisableHint")) : null,
						),
						// 操作条固定在头部右侧；窄屏由 CSS 掉到身份区下方
						h(
							"div",
							{ className: "ss-detail-actions" },
							// 作者注册的操作按钮（如「打开 IM 机器人」）：官方放在页面自身操作之前
							h(SlotRenderer, { name: "plugins.detail.actions", injectProps: { subject: { name: item.name } } }),
							Toggle({
								checked: enabled,
								disabled: rmBusy || item.self === true,
								label: enabled ? tr("pluginDisable") : tr("pluginEnable"),
								title: item.self === true ? tr("selfDisableHint") : enabled ? tr("pluginDisableConfirm") : tr("pluginEnableConfirm"),
								onChange: () => doToggle(item),
								children: h("span", { className: "ss-switch-text" }, enabled ? tr("pluginDisable") : tr("pluginEnable")),
							}),
							upd
								? Btn({
										children: busy[item.name + "__upd"] === true ? tr("pmUpdating") : tr("pmUpdate"),
									title: tr("pmHasUpdate") + " v" + upd.latest,
										onClick: () => doUpdate(item.name, upd.spec, false, upd.latest),
										disabled: rmBusy || busy[item.name + "__upd"] === true,
										primary: true,
									})
								: null,
							!hasDisplayTitle(ai) ? Btn({ children: aiBusy ? tr("analyzing") : tr("analyze"), onClick: () => doAnalyzeOne(item), disabled: aiBusy }) : null,
							// 卸载和主操作隔开：它是不可逆的，不该挨着开关。
							// 本面板自己不提供卸载入口：宿主会硬拦（卸掉就没有这个页面了）。
							item.self === true
								? null
								: h(
										"span",
										{ className: "ss-detail-danger" },
										Btn({ children: rmBusy ? tr("pluginUninstalling") : tr("pluginUninstall"), onClick: () => doUninstall(item), disabled: rmBusy, danger: true }),
									),
						),
					),
					// 内容区：主栏（AI 说明 / 配置 / 文档）+ 侧栏（信息事实表）。
					// 单列时侧栏自然落到正文之后；xwide（>=1500px）时并成两列，
					// 让最大化窗口右半边有真正的内容，而不是空白。
					h(
						"div",
						{ className: "ss-detail-body" },
						h(
							"div",
							{ className: "ss-detail-main" },
							// 配置已启用但宿主没加载：这是最容易被误判成"开关坏了"的状态，
							// 放在正文最前面，并把原因和可执行命令一起给出。
							item.runtimeError
								? h(
										"div",
										{ className: "ss-warnbox" },
										h("b", null, tr("pluginNotLoaded") + " · " + (item.runtimeError.code || "runtime")),
										h("div", { style: { marginTop: 6 } }, item.runtimeError.text),
										item.runtimeError.fixCommand
											? h("div", { className: "ss-warn-fix" }, h("code", null, item.runtimeError.fixCommand))
											: null,
									)
								: null,
							h(AiBlock, {
								ai,
								busy: aiBusy,
								failErr: failedMap[item.id],
								hint: analyzeOn ? undefined : tr("analyzeDisabled"),
								onAnalyze: hasDisplayTitle(ai) || !analyzeOn ? undefined : () => doAnalyzeOne(item),
							}),
							hasConfig
								? h(
										"section",
										{ className: "ss-detail-section" },
										h(
											"h3",
											{ className: "ss-detail-section-title" },
											tr("secConfig"),
											h("span", { className: "ss-detail-section-hint" }, tr("detailNativeHint")),
										),
										h(PluginNativeConfigSection, { name: item.name }),
									)
								: null,
						),
						h(
							"aside",
							{ className: "ss-detail-aside" },
							h(
								"section",
								{ className: "ss-detail-section" },
								h("h3", { className: "ss-detail-section-title" }, tr("detailInfo")),
								h(
									"dl",
									{ className: "ss-facts" },
									facts.map(([k, v]) =>
										h("div", { className: "ss-fact", key: k }, h("dt", null, k), h("dd", null, v)),
									),
							// 说明文档：单列时排在「信息」之后；宽屏两列时落在右栏底部（折叠态只占一行）
							item.fullText || item.description
								? h(
										"details",
										{ className: "ss-more ss-detail-readme" },
										h("summary", null, tr("secMore")),
										h(Markdown, { text: item.fullText || item.description || "–" }),
									)
								: null,
								),
							),
						),
					),
				);
			};

			// 列表模式的行
			// 列表模式的行：一条记录一行，右侧只放「更新 / 启停 / 详情」。
			// 卸载收进详情页 —— 它在列表里每次都挨着开关，误点的代价太大。
			const pluginRow = (item) => {
				const ai = aiMap[item.id];
				const failErr = failedMap[item.id];
				const rmBusy = busy[item.id + "__rm"] === true;
				const enabled = item.enabled !== false;
				const isSelf = item.self === true;
				const upd = updateOf(item.name);
				return h(
					"div",
					{ className: "ss-item", key: item.id, "data-disabled": enabled ? undefined : "" },
					h("div", { className: "ss-icon", "data-letter": "", onClick: () => openDetail(item) }, avatarLetter(item.name)),
					h(
						"div",
						{ className: "ss-main" },
						h(
							"div",
							{ className: "ss-name-row" },
							h("span", { className: "ss-name", "data-link": "", title: item.name, "aria-label": item.name, onClick: () => openDetail(item) }, displayName(item, ai)),
							item.version ? h("span", { className: "ss-path" }, "v" + item.version) : null,
							h(PluginRunningBadge, { name: item.name, runtimeError: item.runtimeError, enabled }),
							// 只有「真的要处理」的状态才给彩色底：可更新 / 被配置覆盖
							// （未加载由徽标本身表达，不再重复一个同文案 chip）
							upd
								? h(
										"span",
										{
											className: "ss-chip2 upd",
											title: tr("pmHasUpdate") + " v" + upd.latest + (upd.latestFrom === "catalog" ? "\n" + tr("pmFromCatalog") : ""),
										},
										tr("pmHasUpdate") + " → v" + upd.latest,
									)
								: null,
							item.inBundles === true && item.disabledByPatch === true
								? h("span", { className: "ss-chip2 upd", title: tr("pluginOverrideChip") + "：cordis.patch.yml 里 disabled: true" }, tr("pluginOverrideChip"))
								: null,
							!enabled ? h("span", { className: "ss-state" }, tr("pluginDisabled")) : null,
							isSelf ? h("span", { className: "ss-state" }, tr("selfPanel")) : null,
						),
						h("div", { className: "ss-desc", "data-zh": ai ? "" : undefined }, ai?.summary || item.description || "–"),
						isSelf ? h("div", { className: "ss-note" }, tr("selfDisableHint")) : null,
						failErr
							? h("details", { className: "ss-fail" }, h("summary", null, "⚠ " + failErr.slice(0, 80)), h("div", { className: "ss-fail-body" }, failErr))
							: null,
					),
					h(
						"div",
						{ className: "ss-side" },
						upd
							? Mini({
									children: busy[item.name + "__upd"] === true ? tr("pmUpdating") : tr("pmUpdate"),
									title: tr("pmHasUpdate") + " v" + upd.latest,
									onClick: () => doUpdate(item.name, upd.spec, false, upd.latest),
									disabled: rmBusy || busy[item.name + "__upd"] === true,
								})
							: null,
						Toggle({
							checked: enabled,
							// 本面板不能停用自己：宿主会硬拦（停掉后没有入口再开回来）。
							// 与其给一个点了必然报错的开关，不如直接置灰并把原因写在标题里。
							disabled: rmBusy || isSelf,
							label: enabled ? tr("pluginDisable") : tr("pluginEnable"),
							title: isSelf ? tr("selfDisableHint") : enabled ? tr("pluginDisableConfirm") : tr("pluginEnableConfirm"),
							onChange: () => doToggle(item),
						}),
					),
				);
			};

			// 二级页面优先：选中插件时整块切到详情页，列表完全让位（一屏只讲一个插件）
			const opened = openId === undefined ? undefined : (visible.find((i) => i.id === openId) ?? allSkills.find((i) => i.id === openId));
			if (opened !== undefined) {
				return h(
					"div",
					{ className: "ss-body" },
					confirmNode,
					// Toast 不在这里渲染：由顶层 Panel 统一渲染（渲染点必须唯一，否则两条重叠）
					h(PluginDetailPage, { key: "detail", item: opened }),
				);
			}

			return h(
				"div",
				{ className: "ss-body" },
				h(
					"div",
					{ className: "ss-toolbar" },
					Input({ value: filter, onChange: setFilter, placeholder: tr("filterPlugins"), clearable: true, clearLabel: tr("clearInput") }),
					// 右半区只放"这一页能做什么"：更新 > 筛选 > 视图 > 更多。
					h(
						"div",
						{ className: "ss-toolbar-end" },
						ViewSwitch({ mode: view, onChange: setView }),
						// 低频动作收进「更多」：分析、重载、刷新。工具栏只留一个主操作。
						h(MoreMenu, {
							items: [
								busy.__t === true
									? { label: tr("analyzeStop"), onClick: stopAnalyze, title: tr("analyzeStopHint") }
									: {
											label: tr("analyze") + (pendingAnalyze.length ? " (" + pendingAnalyze.length + ")" : ""),
											onClick: doAnalyze,
											disabled: analyzeOn !== true || pendingAnalyze.length === 0,
											title: analyzeOn !== true
												? tr("analyzeDisabled")
												: pendingAnalyze.length === 0
													? tr("analyzeAllDoneHint")
													: tr("analyzeHint"),
										},
								{
									label: busy.__reload === true ? tr("hotReloadBusy") : tr("hotReload"),
									onClick: doReload,
									disabled: busy.__reload === true || busy.__upd === true,
									title: tr("hotReloadHint"),
								},
								{
									label: state.loading ? tr("scanning") : tr("rescan"),
									onClick: load,
									disabled: state.loading || busy.__t === true,
									title: busy.__t === true ? tr("rescanBusyHint") : undefined,
								},
							],
						}),
						busy.__upd === true
							? Btn({ children: tr("pmUpdating") + " " + (busy.__updDone ?? 0) + "/" + (busy.__updTotal ?? 0), disabled: true, primary: true })
							: updatable.length > 0
								? Btn({ children: tr("pmUpdateAll") + " (" + updatable.length + ")", onClick: doUpdateAll, primary: true })
								: null,
					),
				),
				busy.__t === true
					? h("div", { className: "ss-progress" }, h("i", { style: { width: Math.round(((busy.__done ?? 0) / Math.max(1, busy.__total ?? 1)) * 100) + "%" } }))
					: null,
				confirmNode,
				// 「只看可更新」是筛选，不是动作：挂在列表标题行右侧，跟内容挨着。
				h("div", { className: "ss-group-title" },
					tr("tabPlugins"),
					h("span", { className: "ss-group-hint" }, String(allSkills.length) + (updatable.length > 0 ? " · " + updatable.length + " " + tr("pmUpdates") : "")),
					updatable.length > 0
						? h("button", {
								type: "button",
								className: "ss-textbtn ss-push-right",
								"data-active": onlyUpdatable ? "" : undefined,
								"aria-pressed": onlyUpdatable === true,
								onClick: () => setOnlyUpdatable((v) => !v),
							}, tr("pmOnlyUpdatable") + " (" + updatable.length + ")")
						: null,
				),
				state.loading && allSkills.length === 0
					? h("div", { className: "ss-center" }, tr("scanning"))
					: state.error !== undefined
						? h("div", { className: "ss-err" }, state.error)
						: visible.length === 0
							? h("div", { className: "ss-center" }, tr("noPlugins"))
						: view === "list"
							? h("div", { className: "ss-list" }, visible.map(pluginRow))
							: h(
									"div",
									{ className: "ss-grid" },
									visible.map((item) => {
										const ai = aiMap[item.id];
										const failErr = failedMap[item.id];
										const rmBusy = busy[item.id + "__rm"] === true;
										const enabled = item.enabled !== false;
										const upd = updateOf(item.name);
										return h(
											"article",
											{ className: "ss-card", key: item.id, "data-disabled": enabled ? undefined : "" },
											h(
												"div",
												{ className: "ss-card-head" },
												h("div", { className: "ss-avatar" }, avatarLetter(item.name)),
												h(
													"div",
													{ className: "ss-card-id" },
													h("div", { className: "ss-card-title" },
														h("span", { className: "ss-name", "data-link": "", title: item.name, "aria-label": item.name, onClick: () => openDetail(item) }, displayName(item, ai)),
														item.version ? h("span", { className: "ss-path" }, "v" + item.version) : null,
														item.self === true ? h("span", { className: "ss-state" }, tr("selfPanel")) : null,
													),
												),
												h(PluginRunningBadge, { name: item.name, runtimeError: item.runtimeError, enabled }),
											),
											h("div", { className: "ss-card-desc", "data-zh": ai ? "" : undefined }, ai?.summary || item.description || "–"),
											item.runtimeError
												? h("div", { className: "ss-warnbox", title: item.runtimeError.text }, h("b", null, tr("pluginNotLoaded")), " " + item.runtimeError.text)
												: null,
											failErr
												? h("details", { className: "ss-fail" }, h("summary", null, "⚠ " + failErr.slice(0, 80)), h("div", { className: "ss-fail-body" }, failErr))
												: null,
											h(
												"div",
												{ className: "ss-chips" },
												upd
													? h(
															"span",
															{
																className: "ss-chip2 upd",
																title: tr("pmHasUpdate") + " v" + upd.latest + (upd.latestFrom === "catalog" ? "\n" + tr("pmFromCatalog") : ""),
															},
															tr("pmHasUpdate") + " → v" + upd.latest,
														)
													: null,
												item.inBundles === true && item.disabledByPatch === true
													? h("span", { className: "ss-chip2 upd", title: tr("pluginOverrideChip") + "：cordis.patch.yml 里 disabled: true" }, tr("pluginOverrideChip"))
													: null,
											),
											h(
												"div",
												{ className: "ss-foot" },
												// 版本已经在标题行里，这里不再重复一遍安装标识
												// （卡片脚只放操作，左右对齐才稳）。
												h(
													"div",
													{ className: "ss-rowbtns" },
													upd
														? Mini({
																children: busy[item.name + "__upd"] === true ? tr("pmUpdating") : tr("pmUpdate"),
									title: tr("pmHasUpdate") + " v" + upd.latest,
																onClick: () => doUpdate(item.name, upd.spec, false, upd.latest),
																disabled: rmBusy || busy[item.name + "__upd"] === true,
															})
														: null,
													Toggle({
														checked: enabled,
														disabled: rmBusy || item.self === true,
														label: enabled ? tr("pluginDisable") : tr("pluginEnable"),
														title: item.self === true ? tr("selfDisableHint") : enabled ? tr("pluginDisableConfirm") : tr("pluginEnableConfirm"),
														onChange: () => doToggle(item),
													}),
												),
											),
										);
									}),
								),
			);
		}

		/* ================================================================ *
		 * tab 4: 技能市场（卡片网格 + 筛选 chips）
		 * ================================================================ */

		const MARKET_TABS = [
			{ id: "", label: () => tr("tabAll"), sort: "" },
			{ id: "hot", label: () => tr("tabHot"), sort: "installs" },
			{ id: "downloads", label: () => tr("tabDownloads"), sort: "downloads" },
			{ id: "updated", label: () => tr("tabUpdated"), sort: "updated_at" },
		];

		/**
		 * 市场条目的唯一键。写入「安装中」和读取「安装中」必须用同一个 key，
		 * 否则按钮永远不进入 loading 态、也不 disable，用户会重复点击。
		 * 注意不要用 item.marketSource：那是展示用的 publisher 来源
		 * （community/clawhub/enterprise），和安装请求用的 item.source 不是一个值。
		 */
		const marketKey = (item) => String(item?.source ?? "skillhub") + ":" + String(item?.slug ?? "");

		function MarketTab(props) {
			const config = props.config;
			const [view, setView] = useViewMode("market", "card");
			const [sort, setSort] = react.useState("");
			const [source, setSource] = react.useState(""); // ''=所有来源(后端已聚合)
			const [apiKeyFilter, setApiKeyFilter] = react.useState(""); // ''/need/no
			const [q, setQ] = react.useState("");
			const [category, setCategory] = react.useState("");
			const [page, setPage] = react.useState(1);
			const [categories, setCategories] = react.useState([]);
			const [state, setState] = react.useState({ loading: true, items: [], total: 0, error: undefined });
			const [installing, setInstalling] = react.useState({});
			const [toast, setToast] = useToast();
			const [detail, setDetail] = react.useState(undefined);

			react.useEffect(() => {
				getJson(API.marketCategories + "?source=" + source)
					.then((data) => setCategories(data.categories ?? []))
					.catch(() => setCategories([]));
			}, [source]);

			const run = react.useCallback(
				(targetPage) => {
					const p = targetPage ?? 1;
					setState((s) => ({ ...s, loading: true, error: undefined }));
					const effectiveSort = MARKET_TABS.find((x) => x.id === sort)?.sort ?? "";
					const params = new URLSearchParams({ source, page: String(p) });
					if (q) params.set("q", q);
					if (category) params.set("category", category);
					if (effectiveSort) params.set("sort", effectiveSort);
					getJson(API.marketSearch + "?" + params)
						.then((data) => {
							setState({ loading: false, items: data.items ?? [], total: data.total ?? 0, error: undefined });
							setPage(p);
						})
						.catch((e) => setState({ loading: false, items: [], total: 0, error: String(e.message ?? e) }));
				},
				[source, q, category, sort],
			);

			react.useEffect(() => {
				run(1);
			}, [source, sort, category]);

			// 另外三处搜索框都是"输入即搜"，只有市场要点「搜索」，交互不统一。
			// 但市场走的是服务端查询（SkillHub / ClawHub API），每敲一个字母发一次请求太费，
			// 所以做 400ms 防抖；右边的「搜索」按钮保留，用来立刻重查当前关键词。
			const runRef = react.useRef(run);
			runRef.current = run;
			const qTouched = react.useRef(false);
			react.useEffect(() => {
				if (!qTouched.current) {
					qTouched.current = true; // 首次挂载由上面那个 effect 负责
					return undefined;
				}
				const t = window.setTimeout(() => runRef.current(1), 400);
				return () => window.clearTimeout(t);
			}, [q]);

			const doInstall = async (item) => {
				const key = marketKey(item);
				setInstalling((s) => ({ ...s, [key]: true }));
				setToast(undefined);
				try {
					const result = await sendJson(API.marketInstall, "POST", { source: item.source, slug: item.slug, name: item.name });
					setToast(result.ok ? { kind: "ok", text: tr("installed") + ": " + result.dest } : { kind: "err", text: tr("installFail") + ": " + String(result.error) });
				} catch (e) {
					setToast({ kind: "err", text: tr("installFail") + ": " + String(e.message ?? e) });
				} finally {
					setInstalling((s) => ({ ...s, [key]: false }));
				}
			};

			const openDetail = (item) => {
				setDetail({ item, loading: true, fullText: item.description, error: undefined });
				getJson("api/dsh-curator/market/detail?slug=" + encodeURIComponent(item.slug))
					.then((data) => setDetail({
						item,
						loading: false,
						fullText: data.description ?? item.description,
						owner: data.owner,
						version: data.version,
						changelog: data.changelog,
						stats: data.stats,
						subCategories: data.subCategories,
						security: data.security,
						requiresApiKey: data.requiresApiKey,
					}))
					.catch((e) => setDetail({ item, loading: false, fullText: item.description, error: String(e.message ?? e) }));
			};

			const pageSize = config?.market?.pageSize ?? 24;
			const maxPage = state.total > 0 ? Math.max(1, Math.ceil(state.total / pageSize)) : 1;

			return h(
				"div",
				{ className: "ss-body" },
				// 排序 chips
				h(
					"div",
					{ className: "ss-chips" },
					MARKET_TABS.map((item) =>
						h(
							"button",
							{ key: item.id, type: "button", className: "ss-chip", "data-active": sort === item.id ? "" : undefined, onClick: () => setSort(item.id) },
							item.label(),
						),
					),
				),
				// 搜索行：搜索框 + 分类 + 来源 + API Key
				h(
					"div",
					{ className: "ss-toolbar" },
					Input({ value: q, onChange: setQ, placeholder: tr("searchPlaceholder"), onEnter: () => run(1), clearable: true, clearLabel: tr("clearInput") }),
					Btn({ children: state.loading ? "…" : tr("search"), onClick: () => run(1), primary: true, disabled: state.loading }),
					h(
						"select",
						{
							className: "ss-input",
							value: category,
							onChange: (e) => {
								setCategory(e.target.value);
							},
						},
						h("option", { value: "" }, tr("allCategories")),
						categories.map((c) => h("option", { key: c.key, value: c.key }, c.name)),
					),
					h(
						"select",
						{
							className: "ss-input",
							value: source,
							onChange: (e) => {
								setSource(e.target.value);
							},
						},
						h("option", { value: "" }, tr("allSources")),
						h("option", { value: "community" }, "SkillHub"),
						h("option", { value: "clawhub" }, "ClawHub"),
					),
					h(
						"select",
						{
							className: "ss-input",
							value: apiKeyFilter,
							onChange: (e) => {
								setApiKeyFilter(e.target.value);
							},
						},
						h("option", { value: "" }, tr("apiKeyAll")),
						h("option", { value: "need" }, tr("apiKeyNeed") + " · " + tr("filterCurrentPage")),
						h("option", { value: "no" }, tr("apiKeyNo") + " · " + tr("filterCurrentPage")),
					),
					ViewSwitch({ mode: view, onChange: setView }),
				),
				state.error !== undefined
					? h("div", { className: "ss-err" }, state.error)
					: state.loading
						? h("div", { className: "ss-center" }, "…")
						: (() => {
							// API Key 本地过滤（后端不支持该筛选参数）
							const filtered = apiKeyFilter === ""
								? state.items
								: apiKeyFilter === "need"
									? state.items.filter((it) => it.requiresApiKey)
									: state.items.filter((it) => !it.requiresApiKey);
							if (filtered.length === 0) return h("div", { className: "ss-center" }, tr("marketEmpty"));
							// 列表模式的一行
							const marketRow = (item) => {
								const key = marketKey(item);
								const itemBusy = installing[key] === true;
								const srcLabel = item.marketSource === "clawhub" ? "ClawHub" : item.marketSource === "enterprise" ? tr("enterprise") : "SkillHub";
								return h(
									"div",
									{ className: "ss-item", key },
									h("div", { className: "ss-icon", "data-letter": "" }, avatarLetter(item.name || item.slug)),
									h(
										"div",
										{ className: "ss-main" },
										h(
											"div",
											{ className: "ss-name-row" },
											h("span", { className: "ss-name", "data-link": "", title: item.name || item.slug, "aria-label": item.name || item.slug, onClick: () => openDetail(item) }, displayName(item, undefined)),
											item.verified ? h("span", { className: "ss-tag", "data-verified": "" }, tr("verified")) : null,
											item.requiresApiKey ? h("span", { className: "ss-tag", "data-apikey": "" }, tr("needApiKey")) : null,
											(item.tags ?? []).slice(0, 2).map((tag) => h("span", { key: tag, className: "ss-tag" }, tag)),
										),
										h("div", { className: "ss-desc" }, item.description || "–"),
										h("div", { className: "ss-metaline" },
											h("span", null, "★ " + (item.stars ?? 0)),
											h("span", null, "↓ " + (item.downloads ?? 0).toLocaleString()),
											h("span", null, srcLabel),
										),
									),
									h(
										"div",
										{ className: "ss-side" },
										Mini({ children: tr("viewDetail"), onClick: () => openDetail(item) }),
										itemBusy ? h("span", { className: "ss-stat" }, tr("installing")) : Btn({ children: tr("install"), onClick: () => doInstall(item), primary: true }),
									),
								);
							};
							return h(
								"div",
								null,
								view === "list"
									? h("div", { className: "ss-list" }, filtered.map(marketRow))
									: h(
										"div",
										{ className: "ss-grid" },
										filtered.map((item) => {
										const key = marketKey(item);
										const itemBusy = installing[key] === true;
										const srcLabel = item.marketSource === "clawhub" ? "ClawHub" : item.marketSource === "enterprise" ? tr("enterprise") : "SkillHub";
										return h(
											"div",
											{ className: "ss-card", key },
											SourceIcon({ name: item.name || item.slug, url: item.iconUrl }),
											h(
												"div",
												{ className: "ss-main" },
												h(
													"div",
													{ className: "ss-name-row" },
													h(
														"span",
														{
															className: "ss-name",
															"data-link": "",
															title: item.name || item.slug,
															"aria-label": item.name || item.slug,
															onClick: () => openDetail(item),
														},
														displayName(item, undefined),
													),
													item.verified ? h("span", { className: "ss-tag", "data-verified": "" }, tr("verified")) : null,
													item.requiresApiKey ? h("span", { className: "ss-tag", "data-apikey": "" }, tr("needApiKey")) : null,
													(item.tags ?? []).slice(0, 2).map((tag) => h("span", { className: "ss-tag", key: tag }, tag)),
												),
												h("div", { className: "ss-desc" }, item.description || "–"),
											),
											h(
												"div",
												{ className: "ss-side" },
												h("span", { className: "ss-stat" }, "★ " + (item.stars ?? 0)),
												h("span", { className: "ss-stat" }, "↓ " + (item.downloads ?? 0).toLocaleString()),
												h("span", { className: "ss-src" }, srcLabel),
												Mini({ children: tr("viewDetail"), onClick: () => openDetail(item) }),
												itemBusy
													? h("span", { className: "ss-stat" }, tr("installing"))
													: Btn({ children: tr("install"), onClick: () => doInstall(item), primary: true }),
											),
										);
									}),
										),
								state.total > pageSize
									? h(
											"div",
											{ className: "ss-pager" },
											Btn({ children: tr("prevPage"), onClick: () => run(page - 1), disabled: state.loading || page <= 1 }),
											h("span", { className: "ss-stat" }, tr("pageWord") + " " + page + " / " + maxPage),
											Btn({ children: tr("nextPage"), onClick: () => run(page + 1), disabled: state.loading || page >= maxPage }),
										)
									: null,
								);
							})(),
				// 详情抽屉
				detail !== undefined
					? h(DetailDrawer, {
							onClose: () => setDetail(undefined),
							loading: detail.loading === true,
							head: [
								SourceIcon({ name: detail.item.name || detail.item.slug, url: detail.item.iconUrl }),
								h(
									"div",
									{ key: "title", style: { minWidth: 0, flex: 1 } },
									h("div", { className: "ss-drawer-title" }, detail.item.name || detail.item.slug),
									h("div", { className: "ss-drawer-handle" }, detail.item.homepage || detail.item.slug),
								),
							],
							body: [
								h(
									"div",
									{ key: "stats", className: "ss-stat-row" },
									h("div", { className: "ss-stat-cell" }, h("b", null, (detail.item.downloads ?? 0).toLocaleString()), h("span", null, tr("downloadsLabel"))),
									h("div", { className: "ss-stat-cell" }, h("b", null, detail.item.stars ?? 0), h("span", null, tr("starsLabel"))),
									h("div", { className: "ss-stat-cell" }, h("b", null, detail.stats?.versions ?? "–"), h("span", null, tr("versionsLabel"))),
									h("div", { className: "ss-stat-cell" }, h("b", null, detail.stats?.comments ?? 0), h("span", null, tr("commentsLabel"))),
								),
								(detail.security ?? []).length
									? h(
											"div",
											{ key: "sec", className: "ss-sec-row" },
											detail.security.map((s) => h("span", { key: s.name, className: "ss-sec-ok", title: s.reportUrl || s.statusText }, s.name + " · " + s.statusText)),
										)
									: null,
								h(
									"div",
									{ key: "chips", className: "ss-chips", style: { marginBottom: 14 } },
									(detail.subCategories ?? []).map((c) => h("span", { key: c, className: "ss-tag" }, c)),
									detail.requiresApiKey ? h("span", { key: "apikey", className: "ss-tag", "data-apikey": "" }, tr("needApiKey")) : null,
									detail.item.verified ? h("span", { key: "verified", className: "ss-tag", "data-verified": "" }, tr("verified")) : null,
								),
								h(Markdown, { key: "text", text: detail.fullText || detail.item.description || "–" }),
								detail.changelog
									? h("div", { key: "changelog", className: "ss-ok", style: { marginTop: 14 } }, "v" + (detail.version || "") + " " + tr("updatedLabel") + "：" + detail.changelog)
									: null,
								detail.owner
									? h("div", { key: "owner", className: "ss-drawer-handle", style: { marginTop: 10 } }, tr("authorLabel") + "：" + (detail.owner.displayName || detail.owner.handle))
									: null,
							],
							foot: [
								Btn({
									key: "install",
									primary: true,
									children: installing[marketKey(detail.item)] ? tr("installing") : tr("install"),
									onClick: () => doInstall(detail.item),
									disabled: installing[marketKey(detail.item)],
								}),
								h("span", { key: "src", className: "ss-src" }, detail.item.marketSource === "clawhub" ? "ClawHub" : "SkillHub"),
								(() => {
									const href = safeHref(detail.item.homepage);
									return href !== ""
										? h("a", { key: "home", className: "ss-link", href, target: "_blank", rel: "noreferrer noopener" }, tr("pmOpenPage"))
										: null;
								})(),
							],
						})
					: null,
			);
		}

		/* ================================================================ *
		 * tab 4: 设置
		 * ================================================================ */

		function SettingsTab(props) {
			const config = props.config;
			const [draft, setDraft] = react.useState(undefined);
			const [busy, setBusy] = react.useState(false);
			const [toast, setToast] = useToast();
			const [cacheInfo, setCacheInfo] = react.useState(undefined);
			const [testResult, setTestResult] = react.useState(undefined);
			const [paths, setPaths] = react.useState(undefined);
			const [hostModel, setHostModel] = react.useState(undefined);
			const [maintSpec, setMaintSpec] = react.useState("");
			const [catalogInfo, setCatalogInfo] = react.useState(undefined);
			// 试扫结果：改了深度/上限后能立刻看到实际命中多少条
			const [dryRun, setDryRun] = react.useState({});
			// 自动保存状态：clean 已保存 / dirty 有改动 / saving / saved / error / blocked
			const [saveState, setSaveState] = react.useState("clean");
			// 服务端最后回传的那份（JSON 串）。相等 = 没有新改动 → 不用再存。
			const lastSavedRef = react.useRef("");
			// 存失败的那份。相等 = 已经为这份失败过一次 → 不自动重试，
			// 否则服务端挂了会在这儿按 700ms 的节奏死循环打请求。
			const failedRef = react.useRef("");
			// save 定义在早退之后（普通函数，不是 hook），用 ref 把它递给上面的 effect
			const saveRef = react.useRef(undefined);
			const [confirm, confirmNode] = useConfirm();

			react.useEffect(() => {
				if (config === undefined) return;
				const next = JSON.parse(JSON.stringify(config));
				next.analyze.apiKeyMasked = config.analyze?.apiKey ?? "";
				next.analyze.apiKey = "";
				lastSavedRef.current = JSON.stringify(next);
				failedRef.current = "";
				setDraft(next);
			}, [config]);

			react.useEffect(() => {
				getJson(API.analyzeCache).then(setCacheInfo).catch(() => setCacheInfo(undefined));
				getJson(API.config)
					.then((data) => {
						setPaths(data.paths);
						setHostModel(data.hostModel ?? null);
					})
					.catch(() => {});
			}, [config]);

			// 维护区：目录缓存状态
			react.useEffect(() => {
				getJson(API.marketCatalog)
					.then((d) => setCatalogInfo({ count: d.catalog?.count ?? 0, cachedAt: d.cachedAt, stale: d.stale === true }))
					.catch(() => setCatalogInfo(undefined));
			}, []);

			// 自动保存：draft 静下来 700ms 再落盘。
			// 故意不做「改一下就存」——baseUrl、包名这类输入敲一个字符写一次盘，
			// 等于把一串中间态都写进配置文件。
			react.useEffect(() => {
				if (draft === undefined || busy) return;
				const snapshot = JSON.stringify(draft);
				if (snapshot === lastSavedRef.current) return;
				if (snapshot === failedRef.current) return;
				// 服务端会把 path 为空的来源直接丢掉（normalizeConfig 里 filter 掉了）。
				// 这时候存下去，等于把用户刚点「+ 添加来源」出来的那行吞掉、
				// 还当场从界面上消失。所以先不存，等路径填了再说。
				if ((draft.sources ?? []).some((s) => String(s?.path ?? "").trim() === "")) {
					setSaveState("blocked");
					return;
				}
				setSaveState("dirty");
				const timer = setTimeout(() => {
					void (async () => {
						setSaveState("saving");
						const ok = await saveRef.current?.({ silent: true });
						if (ok) {
							setSaveState("saved");
						} else {
							failedRef.current = snapshot;
							setSaveState("error");
						}
					})();
				}, 700);
				return () => clearTimeout(timer);
			}, [draft, busy]);

			if (draft === undefined) return h("div", { className: "ss-center" }, "…");

			const patch = (fn) => {
				const next = JSON.parse(JSON.stringify(draft));
				fn(next);
				setDraft(next);
			};

			const adopt = (cfg) => {
				const next = JSON.parse(JSON.stringify(cfg));
				next.analyze.apiKeyMasked = cfg.analyze?.apiKey ?? "";
				next.analyze.apiKey = "";
				// 存成功 = 这份是干净的，清掉「失败过」的记录，自动保存重新armed
				failedRef.current = "";
				setSaveState("clean");
				setDraft(next);
				if (props.onSaved) props.onSaved(cfg);
			};

			const save = async (options) => {
				const silent = options?.silent === true;
				setBusy(true);
				if (!silent) setToast(undefined);
				try {
					const payload = { sources: draft.sources, analyze: { ...draft.analyze }, market: draft.market, scan: draft.scan };
					delete payload.analyze.apiKeyMasked;
					const data = await sendJson(API.config, "PUT", payload);
					adopt(data.config);
					if (!silent) setToast({ kind: "ok", text: tr("saved") });
					return true;
				} catch (e) {
					setToast({ kind: "err", text: tr("saveFail") + ": " + String(e.message ?? e) });
					return false;
				} finally {
					setBusy(false);
				}
			};
			// 交给上面的自动保存 effect 用（那个 effect 在早退之前，拿不到这里的 save）
			saveRef.current = save;

			// 维护区：按包名安装（逃生舱，普通用户用不到）
			const doInstallSpec = async () => {
				const spec = maintSpec.trim();
				if (spec === "") return;
				const yes = await confirm(tr("pmInstallConfirm") + "\n" + spec);
				if (!yes) return;
				setBusy(true);
				try {
					const r = await sendJson(API.pluginInstall, "POST", { spec });
					if (r.ok) {
						setToast({ kind: "ok", text: r.hint ?? tr("pmInstallDone") });
						setMaintSpec("");
					} else setToast({ kind: "err", text: String(r.error) });
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy(false);
				}
			};

			// 扫描区：试扫一次。必须先落盘再扫——服务端读的是磁盘配置，
			// 不先保存的话改了深度/上限点试扫，扫的还是旧参数，反馈是假的。
			const doDryRun = async () => {
				setDryRun({ loading: true });
				const ok = await save({ silent: true });
				if (!ok) {
					setDryRun({ error: tr("saveFail") });
					return;
				}
				try {
					const data = await sendJson(API.scan, "POST", {});
					const rows = Object.values(data.groups ?? {})
						.flat()
						.map((g) => ({ key: g.key ?? g.path, label: g.label, path: g.path, count: g.count ?? (g.skills ?? []).length, missing: g.missing === true }));
					setDryRun({ total: data.total ?? 0, rows });
				} catch (e) {
					setDryRun({ error: String(e.message ?? e) });
				}
			};

			const testAnalyze = async () => {
				setTestResult({ loading: true });
				// 测试打的是服务端落盘的配置，所以先把当前改动存下去——
				// 否则改了地址/模型没点保存就测试，测的是旧值，结论会误导。
				const ok = await save({ silent: true });
				if (!ok) {
					setTestResult({ ok: false, text: tr("saveFail") });
					return;
				}
				try {
					// noCache：探针只是验证连通性，不该在正式缓存里占一条
					const data = await sendJson(API.analyze, "POST", {
						noCache: true,
						items: [{ key: "probe", name: "probe", description: "Probe: does AI analyze work?", fullText: "# Probe\nTest skill description for analyze endpoint." }],
					});
					if (data.disabled) setTestResult({ ok: false, text: data.code === "analyze-disabled" ? tr("analyzeDisabled") : (data.hint ?? tr("analyzeDisabled")) });
					else if ((data.analyses ?? {}).probe) setTestResult({ ok: true, text: tr("testOk") + ": " + (data.analyses.probe.summary ?? JSON.stringify(data.analyses.probe)) + "   [" + data.path + "]" });
					else setTestResult({ ok: false, text: tr("testFail") + ": " + ((data.failed ?? []).map((f) => f.error).join("; ") || "no output") });
				} catch (e) {
					setTestResult({ ok: false, text: tr("testFail") + ": " + String(e.message ?? e) });
				}
			};

			const resetAll = async () => {
				const yes = await confirm(tr("resetConfirm"), { tone: "danger", confirmText: tr("reset") });
				if (!yes) return;
				setBusy(true);
				try {
					const data = await sendJson(API.reset, "POST");
					adopt(data.config);
					setToast({ kind: "ok", text: tr("saved") });
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy(false);
				}
			};

			const clearCache = async () => {
				const yes = await confirm(tr("clearCacheConfirm"), { tone: "danger", confirmText: tr("clearCache") });
				if (!yes) return;
				try {
					const data = await sendJson(API.analyzeCache, "DELETE");
					setCacheInfo(data);
					setToast({ kind: "ok", text: tr("clearCache") });
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				}
			};

			const SAVE_TEXT = {
				clean: tr("stClean"),
				dirty: tr("stDirty"),
				saving: tr("saving"),
				saved: tr("stSaved"),
				error: tr("stError"),
				blocked: tr("stBlocked"),
			};

			return h(
				"div",
				{ className: "ss-body" },
				h(
					"div",
					{ className: "ss-section" },
					h("h3", null, tr("setSources")),
					h("p", null, tr("setSourcesHint")),
					draft.sources.map((source, index) =>
						h(
							"div",
							{ className: "ss-srcrow", key: index },
							h(
								"label",
								{ className: "ss-switch" },
								h("input", { type: "checkbox", checked: source.enabled !== false, onChange: (e) => patch((d) => { d.sources[index].enabled = e.target.checked; }) }),
								tr("enabled"),
							),
							Input({ value: source.label, onChange: (v) => patch((d) => { d.sources[index].label = v; }), placeholder: tr("sourceLabel") }),
							Input({ value: source.path, onChange: (v) => patch((d) => { d.sources[index].path = v; }), placeholder: tr("sourcePath") }),
							h(
								"select",
								{ className: "ss-input", value: source.type, onChange: (e) => patch((d) => { d.sources[index].type = e.target.value; }) },
								h("option", { value: "harness" }, tr("typeHarness")),
								h("option", { value: "shared" }, tr("typeShared")),
								h("option", { value: "external" }, tr("typeExternal")),
							),
							source.builtin ? h("span", { className: "ss-badge" }, tr("builtinCannotRemove")) : Mini({ children: tr("removeSource"), onClick: () => patch((d) => { d.sources.splice(index, 1); }) }),
						),
					),
					h(
						"div",
						{ style: { marginTop: 8 } },
						Mini({
							children: "+ " + tr("addSource"),
							onClick: () =>
								patch((d) => {
									d.sources.push({ key: "custom-" + Date.now(), label: tr("newSource"), path: "", enabled: true, type: "external", builtin: false, readonly: false });
								}),
						}),
					),
				),
				h(
					"div",
					{ className: "ss-section" },
					h("h3", null, tr("setAnalyze")),
					h("p", null, tr("setAnalyzeHint")),
					// 隐私提示常驻，不只在首次点击时弹 —— 用户后来改了技能、或者把插件
					// 分享给别人用时，得有个地方能随时看到这件事。
					h("div", { className: "ss-privacy" }, h("b", null, tr("analyzePrivacyTitle")), h("span", null, tr("analyzePrivacyBody"))),
					h(
						"div",
						{ className: "ss-field" },
						h(
							"label",
							{ className: "ss-switch" },
							h("input", { type: "checkbox", checked: draft.analyze.enabled === true, onChange: (e) => patch((d) => { d.analyze.enabled = e.target.checked; }) }),
							tr("analyzeEnable"),
						),
					),
					h(
						"div",
						{ className: "ss-field" },
						h("label", null, tr("setAnalyzeMode")),
						h(
							"div",
							{ className: "ss-mode" },
							[
								{ id: "host", title: tr("setModeHost"), sub: tr("setModeHostShort"), hint: tr("setModeHostHint") },
								{ id: "endpoint", title: tr("setModeEndpoint"), sub: tr("setModeEndpointShort"), hint: tr("setModeEndpointHint") },
							].map((m) =>
								h(
									"button",
									{
										key: m.id,
										type: "button",
										className: "ss-mode-card" + ((draft.analyze.mode ?? "host") === m.id ? " on" : ""),
										onClick: () => patch((d) => { d.analyze.mode = m.id; }),
									},
									h("b", null, m.title),
									h("span", { className: "ss-mode-sub" }, m.sub),
									h("span", { className: "ss-mode-hint" }, m.hint),
								),
							),
						),
					),
					(draft.analyze.mode ?? "host") === "host"
						? h(
								"div",
								{ className: "ss-field" },
								h(
									"span",
									{ className: "ss-badge" },
									tr("model") + ": " + (hostModel ? hostModel.provider + " / " + hostModel.model : tr("hostModelUnknown")),
								),
							)
						: [
								h("div", { className: "ss-field", key: "u" }, h("label", null, tr("baseUrl")), Input({ value: draft.analyze.baseUrl, onChange: (v) => patch((d) => { d.analyze.baseUrl = v; }), placeholder: tr("baseUrlPlaceholder") })),
								h(
									"div",
									{ className: "ss-field", key: "k" },
									h("label", null, tr("apiKey")),
									h("input", {
										className: "ss-input",
										type: "password",
										value: draft.analyze.apiKey,
										placeholder: draft.analyze.apiKeyMasked ? draft.analyze.apiKeyMasked + "  (" + tr("apiKeyKeep") + ")" : tr("apiKeyKeep"),
										onChange: (e) => patch((d) => { d.analyze.apiKey = e.target.value; }),
									}),
								),
								h("div", { className: "ss-field", key: "m" }, h("label", null, tr("model")), Input({ value: draft.analyze.model, onChange: (v) => patch((d) => { d.analyze.model = v; }), placeholder: tr("modelPlaceholder") })),
								h(
									"div",
									{ className: "ss-field", key: "f" },
									h(
										"label",
										{ className: "ss-switch" },
										h("input", { type: "checkbox", checked: draft.analyze.useHostFallback !== false, onChange: (e) => patch((d) => { d.analyze.useHostFallback = e.target.checked; }) }),
										tr("useHostFallback"),
									),
								),
							],
					h(
						"div",
						{ className: "ss-field ss-grid3" },
						h("div", null,
							h("label", { style: { display: "block", marginBottom: 4, fontSize: 12 } }, tr("batchSize")),
							Input({ value: String(draft.analyze.batchSize ?? 1), onChange: (v) => {
								const n = Number(v);
								patch((d) => { d.analyze.batchSize = v === "" ? "" : (isNaN(n) ? 1 : n); });
							} }),
							h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 3 } }, tr("batchSizeHint")),
						),
						h("div", null,
							h("label", { style: { display: "block", marginBottom: 4, fontSize: 12 } }, tr("concurrency")),
							Input({ value: String(draft.analyze.concurrency ?? 2), onChange: (v) => {
								const n = Number(v);
								patch((d) => { d.analyze.concurrency = v === "" ? "" : (isNaN(n) ? 2 : n); });
							} }),
							h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 3 } }, tr("concurrencyHint")),
						),
						h("div", null,
							h("label", { style: { display: "block", marginBottom: 4, fontSize: 12 } }, tr("maxTokens")),
							Input({ value: draft.analyze.maxTokens ? String(draft.analyze.maxTokens) : "", onChange: (v) => {
								const n = Number(v);
								patch((d) => { d.analyze.maxTokens = v === "" ? 0 : (isNaN(n) ? 0 : n); });
							} }),
							h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 3 } }, tr("maxTokensHint")),
						),
					),
					h(
						"div",
						{ className: "ss-field" },
						Btn({ children: testResult?.loading ? tr("testing") : tr("testAnalyze"), onClick: testAnalyze, disabled: testResult?.loading === true, title: tr("testUsesSaved") }),
						cacheInfo ? h("span", { className: "ss-badge" }, tr("cacheInfo") + ": " + cacheInfo.size + " " + tr("cacheCount")) : null,
						cacheInfo ? Mini({ children: tr("clearCache"), onClick: clearCache }) : null,
					),
					testResult !== undefined && !testResult.loading ? h("div", { className: testResult.ok ? "ss-ok" : "ss-err" }, testResult.text) : null,
				),
				h(
					"div",
					{ className: "ss-section" },
					h("h3", null, tr("setScan")),
					h(
						"div",
						{ className: "ss-grid2" },
						h(
							"div",
							null,
							h("label", { className: "ss-flabel" }, tr("scanDepth")),
							Input({ value: String(draft.scan.depth), onChange: (v) => patch((d) => { d.scan.depth = Number(v) || 3; }) }),
							h("div", { className: "ss-fhint" }, tr("scanDepthHint")),
						),
						h(
							"div",
							null,
							h("label", { className: "ss-flabel" }, tr("maxPerSource")),
							Input({ value: String(draft.scan.maxPerSource), onChange: (v) => patch((d) => { d.scan.maxPerSource = Number(v) || 500; }) }),
							h("div", { className: "ss-fhint" }, tr("scanMaxHint")),
						),
					),
					h(
						"div",
						{ className: "ss-field" },
						// 深度/上限改了不试扫一次是看不出区别的，这里直接给结果反馈
						Mini({ children: dryRun.loading ? tr("scanning") : tr("scanTry"), onClick: doDryRun, disabled: dryRun.loading === true }),
						dryRun.total !== undefined ? h("span", { className: "ss-badge" }, tr("scanFound") + ": " + dryRun.total) : null,
					),
					(dryRun.rows ?? []).map((r) =>
						h(
							"div",
							{ className: "ss-metarow", key: r.key ?? r.label },
							h("span", { className: "ss-metaname" }, r.label),
							h("span", { className: "ss-clamp1" }, r.path + (r.missing ? "  ·  " + tr("dirMissing") : "")),
							h("span", { className: "ss-badge" }, String(r.count)),
						),
					),
					dryRun.error !== undefined ? h("div", { className: "ss-err" }, dryRun.error) : null,
				),
				h(
					"div",
					{ className: "ss-section" },
					h("h3", null, tr("setMaintain")),
					h("p", null, tr("setMaintainHint")),
					h(
						"div",
						{ className: "ss-field" },
						h(
							"label",
							{ style: { display: "block", marginBottom: 4, fontSize: 12 } },
							tr("maintInstallTitle"),
						),
						h(
							"div",
							{ style: { display: "flex", gap: 8 } },
							Input({ value: maintSpec, onChange: setMaintSpec, placeholder: tr("maintInstallPlaceholder") }),
							Mini({ children: tr("maintInstallGo"), onClick: doInstallSpec, disabled: busy || maintSpec.trim() === "" }),
						),
						h("div", { className: "ss-fhint" }, tr("maintInstallHint")),
					),
					h(
						"div",
						{ className: "ss-field" },
						h("label", { style: { display: "block", marginBottom: 4, fontSize: 12 } }, tr("pmCatalogCache")),
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
							catalogInfo
								? h("span", { className: "ss-badge" }, catalogInfo.count + " · " + (catalogInfo.cachedAt ? new Date(catalogInfo.cachedAt).toLocaleString() : "–") + (catalogInfo.stale ? "  ·  " + tr("pmStale") : ""))
								: h("span", { className: "ss-badge" }, tr("pmCatalogNoCache")),
							Mini({
								children: tr("pmRefreshAll"),
								onClick: async () => {
									try {
										const d = await getJson(API.marketCatalog + "?refresh=1");
										setCatalogInfo({ count: d.catalog?.count ?? 0, cachedAt: d.cachedAt, stale: d.stale === true });
										setToast({ kind: "ok", text: tr("saved") });
									} catch (e) {
										setToast({ kind: "err", text: String(e.message ?? e) });
									}
								},
							}),
						),
					),
				),
				// 提示条放在悬浮保存条之前：保存条 sticky 在底部，
				// 排在它后面的东西滚到底也会被压在下面看不见。
				// 悬浮保存条：吸在滚动容器底部，改到哪都能看见状态，不用滚到底找按钮。
				// 用 sticky 而不是 fixed —— sticky 元素本身还在文档流里，收尾时
				// 自然归位，不会盖住最后一节内容，也就不用给容器补 padding。
				h(
					"div",
					{ className: "ss-savebar" },
					h("span", { className: "ss-savedot", "data-state": saveState }),
					h("span", { className: "ss-savetext" }, SAVE_TEXT[saveState] ?? SAVE_TEXT.clean),
					paths ? h("span", { className: "ss-savepath", title: paths.config }, tr("configPathLabel") + ": " + paths.config) : null,
					h(
						"div",
						{ className: "ss-savebar-btns" },
						Btn({ children: tr("reset"), onClick: resetAll, disabled: busy, danger: true }),
						Btn({
							children: busy ? tr("saving") : tr("saveNow"),
							// 只在真有东西要存（dirty）或上次存败了（error）时可点
							onClick: async () => {
								setSaveState("saving");
								const ok = await save();
								setSaveState(ok ? "clean" : "error");
							},
							disabled: busy || (saveState !== "dirty" && saveState !== "error"),
							primary: true,
						}),
					),
				),
				confirmNode,
			);
		}

		/* ================================================================ *
		 * panel
		 * ================================================================ */

		/** 真正的 React 错误边界：tab 组件抛错时显示错误而不是白屏。
		 *  注意：必须是 class 组件带 getDerivedStateFromError，函数组件里的
		 *  try/catch 包不住子树渲染阶段的错误（h() 只是创建元素，真正渲染由
		 *  React 调度，try 早就结束了）。 */
		class SafeTab extends react.Component {
			constructor(props) {
				super(props);
				this.state = { error: undefined };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error, info) {
				console.warn("[dsh-curator] tab render error:", this.props.tabId, error, info);
			}
			render() {
				if (this.state.error) {
					return h(
						"div",
						{ className: "ss-err" },
						"「" + this.props.tabId + "」" + tr("renderError") + "：\n" + String(this.state.error?.message ?? this.state.error) + "\n\n" + String(this.state.error?.stack ?? "").slice(0, 600),
					);
				}
				return this.props.render();
			}
		}

		/* ================================================================ *
		 * 插件 · 发现（原「插件市场」tab：只留发现；已安装并进「插件 · 已装」，
		 * 高级操作挪去设置）—— 独立实现：直连公开目录 + dsh CLI，不依赖 dshmarket
		 * ================================================================ */
		function PluginMarketTab(props) {
			const config = props.config;
			const [view, setView] = useViewMode("pmarket", "card");
			const [catalog, setCatalog] = react.useState(undefined);
			const [status, setStatus] = react.useState(undefined);
			const [q, setQ] = react.useState("");
			const [cat, setCat] = react.useState("");
			const [catOpen, setCatOpen] = react.useState(false);
			const [filterOpen, setFilterOpen] = react.useState(false);
			const [sortField, setSortField] = react.useState("downloads");
			const [sortDir, setSortDir] = react.useState("desc");
			const [timeRange, setTimeRange] = react.useState("all");
			const [page, setPage] = react.useState(1);
			const [busy, setBusy] = react.useState({});
			const [toast, setToast] = useToast();
			// 详情抽屉。之前这一屏压根没有详情 —— 名称不是链接、也没有「详情」按钮，
			// 卡片上那点信息（描述截断两行 + ★/↓）就是全部。装之前想多看一眼都没地方看。
			const [detail, setDetail] = react.useState(undefined);
			const [confirm, confirmNode] = useConfirm();
			const pageSize = 60;

			const loadCatalog = react.useCallback((refresh) => {
				getJson(API.marketCatalog + (refresh ? "?refresh=1" : ""))
					.then((d) => setCatalog(d))
					.catch((e) => setToast({ kind: "err", text: String(e.message ?? e) }));
			}, []);
			const loadStatus = react.useCallback((refresh) => {
				// refresh=true 让宿主绕过 npm 版本的 10 分钟缓存 —— 「刷新」按钮
				// 必须真的去问一次，否则点了没反应，用户会以为坏了。
				getJson(API.marketStatus + (refresh === true ? "?refresh=1" : ""))
					.then((d) => setStatus(d))
					.catch(() => {});
			}, []);
			react.useEffect(() => {
				loadCatalog(false);
				loadStatus(false);
			}, [loadCatalog, loadStatus]);

			const plugins = catalog?.catalog?.plugins ?? [];
			const cats = catalog?.catalog?.categories ?? [];
			const installedNames = new Set((status?.items ?? []).map((i) => i.name));

			// 分类标签 + 计数：目录给的是 id → 中文名映射，标签顺序按条目数从多到少
			const catStats = (() => {
				const count = new Map();
				for (const p of plugins) for (const c of p.categories) count.set(c, (count.get(c) ?? 0) + 1);
				return cats
					.map((c) => ({ id: c.id, label: c.zh || c.en || c.id, count: count.get(c.id) ?? 0 }))
					.filter((c) => c.count > 0)
					.sort((a, b) => b.count - a.count);
			})();

			const runInstall = async (spec, name, isUpdate, ask) => {
				if (ask) {
					const yes = await confirm((isUpdate ? tr("pmUpdateConfirm") : tr("pmInstallConfirm")) + "\n" + (name || spec));
					if (!yes) return false;
				}
				setBusy((b) => ({ ...b, [spec]: true }));
				try {
					const r = await sendJson(API.pluginInstall, "POST", { spec, name });
					if (r.ok) {
						setToast({ kind: "ok", text: r.hint ?? tr("pmInstallDone") });
						loadStatus();
						return true;
					}
					setToast({ kind: "err", text: String(r.error) });
					return false;
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
					return false;
				} finally {
					setBusy((b) => ({ ...b, [spec]: false }));
				}
			};

			const doRefresh = async () => {
				setBusy((b) => ({ ...b, __refresh: true }));
				try {
					const d = await getJson(API.marketCatalog + "?refresh=1");
					setCatalog(d);
					// 同时强制重查 npm 版本，否则「刷新」只刷新了市场目录，
					// 已安装列表里的「可更新」标记仍是旧判断。
					loadStatus(true);
					setToast({ kind: "ok", text: tr("pmRefreshDone") });
				} catch (e) {
					setToast({ kind: "err", text: String(e.message ?? e) });
				} finally {
					setBusy((b) => ({ ...b, __refresh: false }));
				}
			};

			const ql = q.trim().toLowerCase();
			const timeDays = { all: 0, d7: 7, d30: 30, d90: 90, y1: 365 }[timeRange] ?? 0;
			const filtered = plugins.filter((p) => {
				if (cat !== "" && !p.categories.includes(cat)) return false;
				if (ql !== "" && (p.name + " " + p.owner + " " + p.zh + " " + p.en).toLowerCase().includes(ql) === false) return false;
				if (timeDays > 0) {
					const t = Date.parse(p.added || "");
					if (Number.isFinite(t) && Date.now() - t > timeDays * 86400000) return false;
				}
				return true;
			});
			const sorted = (() => {
				const val = (p) => (sortField === "stars" ? p.stars : sortField === "added" ? Date.parse(p.added || "") || 0 : p.downloads);
				const arr = [...filtered].sort((a, b) => val(b) - val(a));
				return sortDir === "asc" ? arr.reverse() : arr;
			})();
			const shown = sorted.slice(0, page * pageSize);
			const filterActive = timeRange !== "all" || sortField !== "downloads" || sortDir !== "desc";

			// 头像首字母统一走模块级的 avatarLetter（会先剥掉 "@scope/" 的 @）

			const catMap = new Map(cats.map((c) => [c.id, c.zh || c.en || c.id]));
			const catLabel = (id) => catMap.get(id) ?? id;

			// 已装时不再给按钮：卡片标题行/行首都已经有一个「已安装」徽章了，
			// 之前同名徽章会在同一张卡上出现两次
			const installBtn = (p) => {
				if (busy[p.spec] === true) return h("span", { className: "ss-stat" }, tr("pmInstalling"));
				if (p.npm !== "" && installedNames.has(p.npm)) return null;
				return Btn({ children: tr("pmInstall"), onClick: () => runInstall(p.spec, p.npm || p.name, false, true), primary: true });
			};
			const installedChip = (p) => (p.npm !== "" && installedNames.has(p.npm) ? h("span", { className: "ss-chip2 accent" }, tr("pmInstalledChip")) : null);
			const metaLine = (p) =>
				h(
					"div",
					{
						className: "ss-path",
						title: [p.added ? tr("pmSortAdded") + ": " + p.added : "", p.window ? tr("pmSortDownloads") + ": " + p.window : "", p.npm || p.spec].filter(Boolean).join("\n"),
					},
					(p.owner ? "@" + p.owner + " · " : "") + "★ " + (p.stars ?? 0) + " · ↓ " + (p.downloads ?? 0).toLocaleString(),
				);
			const catChips = (p) => [
				...p.categories.slice(0, 2).map((c) => h("span", { className: "ss-chip2", key: "c" + c }, catLabel(c))),
				p.redLines.length > 0 ? h("span", { className: "ss-chip2", key: "rl", style: { color: "var(--ss-warn)", borderColor: "color-mix(in srgb,var(--ss-warn) 45%,transparent)" }, title: p.redLines.join(", ") }, "⚠ " + tr("pmRedLines") + " " + p.redLines.length) : null,
			];

			const openDetail = (p) => setDetail({ item: p });

			/**
			 * 详情抽屉。
			 *
			 * 内容边界要说清楚：目录里**没有正文**（normalizeMarketCatalog 只给结构化字段，
			 * 没有 README），所以这里不假装能显示说明文档 —— 照实展示能拿到的：
			 * 能力、高危项、统计、分类、安装标识、外链，并且把"主页"和"npm 页面"都摆出来，
			 * 让人自己去原站看。承诺一个空的 README 区才是真的坑。
			 */
			const detailNode =
				detail === undefined
					? null
					: (() => {
							const p = detail.item;
							const isInstalled = p.npm !== "" && installedNames.has(p.npm);
							return h(DetailDrawer, {
								onClose: () => setDetail(undefined),
								head: [
									h("div", { key: "icon", className: "ss-avatar" }, avatarLetter(p.owner || p.name)),
									h(
										"div",
										{ key: "title", style: { minWidth: 0, flex: 1 } },
										h("div", { className: "ss-drawer-title" }, p.name),
										h(
											"div",
											{ className: "ss-drawer-handle" },
											(p.owner ? "@" + p.owner : "") + (p.version ? (p.owner ? " · " : "") + "v" + p.version : ""),
										),
									),
								],
								body: [
									h(
										"div",
										{ key: "chips", className: "ss-chips ss-drawer-tags" },
										isInstalled ? h("span", { className: "ss-chip2 accent" }, tr("pmInstalledChip")) : null,
										p.categories.map((c) => h("span", { key: "c" + c, className: "ss-tag" }, catLabel(c))),
									),
									h(
										"div",
										{ key: "stats", className: "ss-stat-row" },
										h("div", { className: "ss-stat-cell" }, h("b", null, (p.stars ?? 0).toLocaleString()), h("span", null, tr("pmSortStars"))),
										h("div", { className: "ss-stat-cell" }, h("b", null, (p.downloads ?? 0).toLocaleString()), h("span", null, tr("pmSortDownloads"))),
										h("div", { className: "ss-stat-cell" }, h("b", null, p.added || "–"), h("span", null, tr("pmSortAdded"))),
										h("div", { className: "ss-stat-cell" }, h("b", null, p.categories.length), h("span", null, tr("pmCatCount"))),
									),
									// 高危项排在正文之前：这是"装之前最该知道的一条"
									p.redLines.length > 0
										? h(
												"div",
												{ key: "rl", className: "ss-warnbox" },
												h("b", null, "⚠ " + tr("pmRedLines") + "：" + p.redLines.join("、")),
												h("div", { style: { marginTop: 4 } }, tr("pmRedLinesHint")),
											)
										: null,
									(p.capabilities ?? []).length > 0
										? h(
												"div",
												{ key: "cap" },
												h("div", { className: "ss-drawer-label" }, tr("pmCapabilities")),
												h(
													"div",
													{ className: "ss-chips", style: { marginBottom: 0 } },
													p.capabilities.map((c) => h("span", { key: c, className: "ss-chip2" }, c)),
												),
											)
										: null,
									h("div", { key: "intro", className: "ss-drawer-label" }, tr("pmDetailIntro")),
									h(Markdown, { key: "text", text: p.zh || p.en || "–" }),
									p.en && p.en !== p.zh ? h(Markdown, { key: "en", text: p.en }) : null,
									h(
										"div",
										{ key: "spec", className: "ss-origin" },
										h(
											"div",
											{ className: "ss-origin-row" },
											h("span", { className: "ss-tag", "data-apikey": "" }, tr("pmSpecLabel")),
											h("span", { className: "ss-origin-label", title: p.spec }, p.spec),
										),
										p.window
											? h(
													"div",
													{ className: "ss-origin-row" },
													h("span", { className: "ss-origin-label" }, tr("pmSortDownloads") + "：" + p.window),
												)
											: null,
									),
								],
								foot: [
									// 外链摆到底部：详情看完了，下一步多半是"去原站看看"或"直接装"
									p.url
										? h(
												"a",
												{ key: "home", className: "ss-link", href: safeHref(p.url), target: "_blank", rel: "noreferrer noopener" },
												tr("pmOpenPage"),
											)
										: null,
									p.page
										? h(
												"a",
												{ key: "npm", className: "ss-link", href: safeHref(p.page), target: "_blank", rel: "noreferrer noopener" },
												tr("pmOpenNpm"),
											)
										: null,
									h("span", { key: "spacer", style: { flex: 1 } }),
									busy[p.spec] === true
										? h("span", { key: "installing", className: "ss-stat" }, tr("pmInstalling"))
										: isInstalled
											? h("span", { key: "done", className: "ss-stat" }, tr("pmInstalledChip"))
											: Btn({ key: "install", primary: true, children: tr("pmInstall"), onClick: () => runInstall(p.spec, p.npm || p.name, false, true) }),
								],
							});
						})();

			const marketCard = (p) =>
				h(
					"div",
					{ className: "ss-card", key: p.spec + " " + p.name },
					h(
						"div",
						{ className: "ss-card-head" },
						h("div", { className: "ss-avatar" }, avatarLetter(p.owner || p.name)),
						h(
							"div",
							{ style: { minWidth: 0, flex: 1 } },
							h(
								"div",
								{ className: "ss-card-title" },
								// 名称可点开详情 —— 和技能库、其他 Agent、已装插件一个手势
								h("span", { className: "ss-name", "data-link": "", title: p.name, onClick: () => openDetail(p) }, p.name),
								p.version ? h("span", { className: "ss-chip2" }, "v" + p.version) : null,
							),
							metaLine(p),
						),
						installedChip(p),
					),
					h("div", { className: "ss-card-desc ss-clamp2", "data-zh": "" }, p.zh || p.en || "–"),
					h("div", { className: "ss-chips" }, catChips(p)),
					h(
						"div",
						{ className: "ss-foot" },
						safeHref(p.url) !== ""
							? h("a", { className: "ss-link", href: safeHref(p.url), target: "_blank", rel: "noreferrer noopener" }, tr("pmOpenPage"))
							: h("span", null, String(p.url ?? "")),
						Mini({ children: tr("viewDetail"), onClick: () => openDetail(p) }),
						installBtn(p),
					),
				);

			const marketRow = (p) =>
				h(
					"div",
					{ className: "ss-item", key: p.spec + " " + p.name },
					h("div", { className: "ss-icon", "data-letter": "" }, avatarLetter(p.owner || p.name)),
					h(
						"div",
						{ className: "ss-main" },
						h(
							"div",
							{ className: "ss-name-row" },
							h("span", { className: "ss-name", "data-link": "", title: p.name, onClick: () => openDetail(p) }, p.name),
							p.version ? h("span", { className: "ss-chip2" }, "v" + p.version) : null,
							installedChip(p),
							// ★/↓ 两个符号不带说明看不出来是什么，各挂一个 title
							h("span", { className: "ss-chip2", title: tr("pmSortStars") }, "★ " + (p.stars ?? 0)),
							h("span", { className: "ss-chip2", title: tr("pmSortDownloads") }, "↓ " + (p.downloads ?? 0).toLocaleString()),
							...p.categories.slice(0, 1).map((c) => h("span", { className: "ss-chip2", key: "c" + c }, catLabel(c))),
							p.redLines.length > 0 ? h("span", { className: "ss-chip2", style: { color: "var(--ss-warn)", borderColor: "color-mix(in srgb,var(--ss-warn) 45%,transparent)" }, title: p.redLines.join(", ") }, "⚠ " + p.redLines.length) : null,
						),
						h("div", { className: "ss-desc ss-clamp1", "data-zh": "" }, p.zh || p.en || "–"),
					),
					h(
						"div",
						{ className: "ss-side" },
						Mini({ children: tr("viewDetail"), onClick: () => openDetail(p) }),
						p.url ? Mini({ children: tr("pmOpenPage"), onClick: () => window.open(p.url, "_blank", "noreferrer") }) : null,
						installBtn(p),
					),
				);

			return h(
				"div",
				{ className: "ss-body" },
				h(
					"div",
					{ className: "ss-pop-wrap" },
					Input({ value: q, onChange: (v) => { setQ(v); setPage(1); }, placeholder: tr("pmSearchHint"), clearable: true, clearLabel: tr("clearInput") }),
					h(
						"button",
						{ type: "button", className: "ss-btn" + (filterActive ? " ss-btn-on" : ""), onClick: () => setFilterOpen((v) => !v) },
						"⚙ " + tr("pmFilter") + (filterActive ? " •" : ""),
					),
					ViewSwitch({ mode: view, onChange: setView }),
					Btn({ children: busy.__refresh ? tr("pmRefreshing") : tr("pmRefresh"), onClick: doRefresh, disabled: busy.__refresh === true }),
					filterOpen ? h("div", { className: "ss-pop-mask", onClick: () => setFilterOpen(false) }) : null,
					filterOpen
						? h(
								"div",
								{ className: "ss-pop" },
								h(
									"div",
									{ className: "ss-pop-row" },
									h("span", { className: "ss-pop-label" }, tr("pmSortBy")),
									[
										["downloads", tr("pmSortDownloads")],
										["stars", tr("pmSortStars")],
										["added", tr("pmSortAdded")],
									].map(([k, label]) =>
										h(
											"button",
											{ key: k, type: "button", className: "ss-pop-chip" + (sortField === k ? " on" : ""), onClick: () => setSortField(k) },
											label,
										),
									),
								),
								h(
									"div",
									{ className: "ss-pop-row" },
									h("span", { className: "ss-pop-label" }, tr("pmSortDir")),
									[
										["desc", tr("pmSortDesc")],
										["asc", tr("pmSortAsc")],
									].map(([k, label]) =>
										h(
											"button",
											{ key: k, type: "button", className: "ss-pop-chip" + (sortDir === k ? " on" : ""), onClick: () => setSortDir(k) },
											label,
										),
									),
								),
								h(
									"div",
									{ className: "ss-pop-row" },
									h("span", { className: "ss-pop-label" }, tr("pmTime")),
									[
										["all", tr("pmTimeAll")],
										["d7", tr("pmTime7")],
										["d30", tr("pmTime30")],
										["d90", tr("pmTime90")],
										["y1", tr("pmTime365")],
									].map(([k, label]) =>
										h(
											"button",
											{ key: k, type: "button", className: "ss-pop-chip" + (timeRange === k ? " on" : ""), onClick: () => { setTimeRange(k); setPage(1); } },
											label,
										),
									),
								),
								h(
									"div",
									{ className: "ss-pop-foot" },
									Mini({
										children: tr("pmReset"),
										onClick: () => { setSortField("downloads"); setSortDir("desc"); setTimeRange("all"); setCat(""); setQ(""); setPage(1); },
									}),
								),
							)
						: null,
				),
				confirmNode,
				h(
					"div",
					{ className: "ss-catbar" },
					h(
						"button",
						{ type: "button", className: "ss-pop-chip" + (cat === "" ? " on" : ""), onClick: () => { setCat(""); setPage(1); } },
						tr("tabAll") + " (" + plugins.length + ")",
					),
					(catOpen ? catStats : catStats.slice(0, 9)).map((c) =>
						h(
							"button",
							{
								key: c.id,
								type: "button",
								className: "ss-pop-chip" + (cat === c.id ? " on" : ""),
								onClick: () => { setCat(cat === c.id ? "" : c.id); setPage(1); },
							},
							c.label + " (" + c.count + ")",
						),
					),
					catStats.length > 9
						? h(
								"button",
								{ type: "button", className: "ss-pop-chip", onClick: () => setCatOpen((v) => !v), title: catOpen ? tr("pmLessCats") : tr("pmMoreCats") },
								catOpen ? "▴" : "▾ " + (catStats.length - 9) + "+",
							)
						: null,
				),
				// 这行原先把二级页签的名字又念了一遍（"发现 4500 / 4500"）。
				// 页签名就在上面一行，重复只会让"改成插件市场"这种改动出现两处口径。
				// 只报"匹配了多少 / 一共多少"，缓存时间跟在旁边。
				h(
					"div",
					{ className: "ss-group-title" },
					tr("pmResultCount"),
					h(
						"span",
						{ className: "ss-group-hint" },
						sorted.length + " / " + plugins.length + (catalog?.catalog?.updated ? " · " + catalog.catalog.updated : "") + (catalog?.stale ? " · cache" : ""),
					),
				),
				catalog === undefined
					? h("div", { className: "ss-center" }, tr("pmLoading"))
					: sorted.length === 0
						? h("div", { className: "ss-center" }, tr("pmNoMatch"))
						: view === "list"
							? h("div", { className: "ss-list" }, shown.map(marketRow))
							: h("div", { className: "ss-grid" }, shown.map(marketCard)),
				sorted.length > shown.length
					? h("div", { className: "ss-pager" }, Btn({ children: tr("pmMore") + " (" + (sorted.length - shown.length) + ")", onClick: () => setPage(page + 1) }))
					: null,
				detailNode,
			);
		}

		/* ================================================================ *
		 * 一级导航 3 个：技能 / 插件 / 设置
		 * 二级由分段控件承载：技能 = Harness 技能 + 其他 Agent + 技能市场 + 回收站；
		 * 插件 = 已装 + 插件市场
		 *
		 * 「技能市场」原来是一级页签，现在并进「技能」当二级 —— 顶层四个页签里
		 * 三个是"管我本机有什么"、一个是"去外面找"，并列会让人以为市场是另一类东西。
		 * 挪进二级后，技能和插件两边结构对称：一边一个市场。
		 * ================================================================ */
		function SkillsHubTab(props) {
			const [sub, setSub] = useViewMode("skills-sub", "harness");
			const subs = [
				{ id: "harness", label: () => tr("tabHarness") },
				{ id: "agents", label: () => tr("tabAgents") },
				// 技能市场原来是顶层页签，收进这里后和插件的「插件市场」正好对称。
				{ id: "market", label: () => tr("tabMarket") },
				// 回收站排最后：另外三项都是"在用的 / 去找的"，只有它是"扔掉的"。
				{ id: "trash", label: () => tr("tabTrash") },
			];
			// 查表代替嵌套三元：项数从 3 涨到 4 之后 a?x:b?y:c?z:w 已经读不动了，
			// 顺带把"本地存的 sub 指向已删页签"兜回第一项，不至于渲染成空白。
			const panels = {
				harness: () => h(SafeTab, { tabId: "harness", render: () => h(HarnessTab, { config: props.config }) }),
				agents: () => h(SafeTab, { tabId: "agents", render: () => h(AgentsTab, { config: props.config }) }),
				market: () => h(SafeTab, { tabId: "market", render: () => h(MarketTab, { config: props.config }) }),
				trash: () => h(SafeTab, { tabId: "trash", render: () => h(TrashTab, {}) }),
			};
			return h(
				"div",
				{ className: "ss-hub" },
				h(
					"div",
					{ className: "ss-subbar" },
					h(
						"div",
						{ className: "ss-seg" },
						subs.map((s) =>
							h(
								"button",
								{ key: s.id, type: "button", className: "ss-seg-btn" + (sub === s.id ? " on" : ""), onClick: () => setSub(s.id) },
								s.label(),
							),
						),
					),
				),
				(panels[sub] ?? panels.harness)(),
			);
		}

		function PluginsHubTab(props) {
			const [sub, setSub] = useViewMode("plugins-hub", "installed");
			const subs = [
				{ id: "installed", label: () => tr("pmSubInstalled") },
				// 「发现」改叫「插件市场」，和技能那边的「技能市场」对上。
				// id 也一起改：老用户本地存的是 "discover"，这里匹配不上时会落到
				// 下面的 else 分支，而 else 渲染的正是这一页，所以不会白屏。
				{ id: "market", label: () => tr("pmSubMarket") },
			];
			return h(
				"div",
				{ className: "ss-hub" },
				h(
					"div",
					{ className: "ss-subbar" },
					h(
						"div",
						{ className: "ss-seg" },
						subs.map((s) =>
							h(
								"button",
								{ key: s.id, type: "button", className: "ss-seg-btn" + (sub === s.id ? " on" : ""), onClick: () => setSub(s.id) },
								s.label(),
							),
						),
					),
				),
				sub === "installed"
					? h(SafeTab, { tabId: "plugins", render: () => h(PluginsTab, { config: props.config }) })
					: h(SafeTab, { tabId: "pmarket", render: () => h(PluginMarketTab, { config: props.config }) }),
			);
		}

		function Panel() {
			// 一级页签。定义在最前面，是因为下面的 useState 初始化要靠它的 id 表做校验。
			const tabs = [
				{ id: "skills", label: () => tr("tabSkills") },
				{ id: "plugins", label: () => tr("tabPlugins") },
				{ id: "settings", label: () => tr("tabSettings") },
			];
			const [tab, setTab] = react.useState(() => {
				// 记住上次看的是哪个一级页签。视图模式/二级页签早就持久化了，
				// 只有这个写死 "skills"，每次打开都跳回技能页。
				// 存的值必须在 tabs 里还在：页签集合是会变的（技能市场并进技能那次），
				// 老值指向已删页签时匹配不上任何渲染分支，面板会空白一片。
				try {
					const saved = localStorage.getItem("ss-tab");
					return tabs.some((t) => t.id === saved) ? saved : "skills";
				} catch {
					return "skills";
				}
			});
			const bucket = useWidthBucket();
			const [config, setConfig] = react.useState(undefined);
			const [error, setError] = react.useState(undefined);
			const [toast, setToast] = useToast();
			const [, confirmNode] = useConfirm();

			react.useEffect(() => {
				getJson(API.config)
					.then((data) => {
						setConfig(data.config);
						setError(undefined);
					})
					.catch((e) => setError(String(e.message ?? e)));
			}, []);

			const goto = (id) => {
				setTab(id);
				try { localStorage.setItem("ss-tab", id); } catch { /* 无痕模式 */ }
			};
			const tabIndex = Math.max(0, tabs.findIndex((t) => t.id === tab));

			return h(
				"div",
				{ className: "ss-root", "data-dsh-plugin": "dsh-curator", "data-ss-w": bucket },
				// 页签行：三个一级页签本身就是一个角色完整的 tablist。
				// （原来这一行右侧还挂着一个全局「重启」动作，功能已移除，多出来的布局层一并撤掉。）
				h(
					"div",
					{ className: "ss-tabs", role: "tablist", "aria-label": tr("panelTitle"), "data-dsh-part": "tab-bar" },
					tabs.map((item, i) =>
						h(
							"button",
							{
								key: item.id,
								type: "button",
								role: "tab",
								className: "ss-tab",
								"data-active": tab === item.id ? "" : undefined,
								"aria-selected": tab === item.id,
								// roving tabindex：一组 tab 在 Tab 序列里只占一格，
								// 组内切换用左右方向键（ARIA tabs 的标准做法）
								tabIndex: i === tabIndex ? 0 : -1,
								onClick: () => goto(item.id),
								onKeyDown: (e) => {
									const n = tabs.length;
									const next =
										e.key === "ArrowRight" ? (i + 1) % n
											: e.key === "ArrowLeft" ? (i - 1 + n) % n
												: e.key === "Home" ? 0
													: e.key === "End" ? n - 1
														: -1;
									if (next < 0) return;
									e.preventDefault();
									goto(tabs[next].id);
									const el = document.getElementById("ss-tab-" + tabs[next].id);
									if (el) el.focus();
								},
								id: "ss-tab-" + item.id,
							},
							item.label(),
						),
					),
				),
				h(Toast, { toast }),
				confirmNode,
				error !== undefined ? h("div", { className: "ss-err" }, tr("loadFail") + ": " + error) : null,
				config === undefined && error === undefined ? h("div", { className: "ss-center" }, "…") : null,
				config !== undefined && tab === "skills" ? h(SafeTab, { tabId: "skills", render: () => h(SkillsHubTab, { config }) }) : null,
				config !== undefined && tab === "plugins" ? h(SafeTab, { tabId: "plugins-hub", render: () => h(PluginsHubTab, { config }) }) : null,
				config !== undefined && tab === "settings" ? h(SafeTab, { tabId: "settings", render: () => h(SettingsTab, { config, onSaved: setConfig }) }) : null,
			);
		}

		/* ================================================================ *
		 * composer skill button（输入框左侧「+ 技能」）
		 *
		 * 为什么不复用 skills-management 那个浮层：那个插件已经从 profile
		 * 的 bundles 列表里掉出去了（`dsh plugin` 装别的插件时重写了 profile
		 * package.json），它的 composer 按钮随之消失。curator 自己已经有
		 * 完整的技能清单（/api/dsh-curator/harness）和中文分析（/lookup），
		 * 只需要一个入口把技能名插进草稿 —— 所以在这里自带一个，不再依赖它。
		 *
		 * 插入通道（dsh 0.2.x）：
		 *   slot 拿不到 input.draft 快照（那份快照的 draftRev 永远是 0，
		 *   编辑器按 span.draftRev !== this.rev 做 CAS，会静默丢弃）。
		 *   正确做法是拿到 slot 注入的 inputActions 面：
		 *   插入瞬间调 captureInsertion() 取带 rev 的当前光标，再 insertText()。
		 * ================================================================ */

		const SKILL_BTN_CSS = `
.ss-skillbtn{
  display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  border-radius:8px;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#5D6169);
  font:inherit;font-size:12px;font-weight:520;line-height:1;
  white-space:nowrap;transition:background .13s ease,color .13s ease,border-color .13s ease;
}
.ss-skillbtn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#1F2329);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}
.ss-skillbtn:active{transform:scale(.97)}
.ss-skillbtn[data-narrow="1"]{width:28px;padding:0;justify-content:center}
.ss-skillbtn[data-narrow="1"] .ss-skillbtn-label{display:none}
.ss-skillpop{
  position:fixed;z-index:2147482000;width:340px;max-height:380px;
  box-sizing:border-box;
  display:flex;flex-direction:column;
  /* 用 bg-layer-1 而不是 bg-overlay：overlay 在本主题是 #e9ecf2 的灰蓝，
     浮层铺灰底会和白输入卡割裂，看着像一整块禁用的区域。 */
  background:var(--dsw-alias-bg-layer-1,#fff);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));
  border-radius:16px;
  box-shadow:0 18px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.06);
  overflow:hidden;
}
.ss-skillpop-searchwrap{position:relative;flex:0 0 auto;margin:10px 10px 6px}
.ss-skillpop-searchwrap svg{
  position:absolute;left:11px;top:50%;translate:0 -50%;
  width:14px;height:14px;color:var(--dsw-alias-label-tertiary,#8A8F99);pointer-events:none;
}
.ss-skillpop-search{
  width:100%;box-sizing:border-box;margin:0;padding:9px 12px 9px 32px;
  border:1px solid transparent;border-radius:10px;
  /* 用 label 的 6% 混出底色：亮色下是浅灰、暗色下自动变浅白，不用分主题写两套 */
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 6%,transparent);
  color:inherit;font:inherit;font-size:13.5px;outline:none;
  -webkit-appearance:none;
}
.ss-skillpop-search:focus{
  border-color:var(--dsw-alias-brand-primary,#2E4FC7);
  background:var(--dsw-alias-bg-layer-1,#fff);
}
.ss-skillpop-list{
  flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  padding:2px 8px 10px;margin:0;list-style:none;
  scrollbar-width:thin;
}
.ss-skillpop-row{
  display:block;width:100%;text-align:left;padding:8px 10px;
  border:none;border-radius:10px;background:transparent;cursor:pointer;
  color:inherit;font:inherit;
}
.ss-skillpop-row:hover,.ss-skillpop-row[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 5%,transparent)}
/* 触屏没有键盘上下选，首项的"当前项"底色会被当成已选中/禁用，去掉 */
@media (pointer:coarse){
  .ss-skillpop-row[data-active="true"]{background:transparent}
  .ss-skillpop-row:active{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 7%,transparent)}
  /* coarse 触区 44：技能按钮/搜索框/技能行至少 44 高，手指点得中 */
  .ss-skillbtn,.ss-skillpop-search,.ss-skillpop-row{min-height:44px}
}
.ss-skillpop-name{display:block;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1F2329);margin-bottom:2px}
/* 描述给两行：这些技能的中文说明就是"这技能是干什么的"，只留一行等于没说 */
.ss-skillpop-desc{
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden;white-space:normal;
  font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5D6169);
}
.ss-skillpop-empty{padding:22px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8A8F99)}
`;

		/** 把技能名插进输入框（`/name ` 形式，触发 DSH 的技能调用解析）。 */
		function insertSkillIntoDraft(inputActions, name) {
			const text = "/" + name + " ";
			// 首选：inputActions 面（dsh 0.2.x 唯一可靠的通道）
			if (inputActions && typeof inputActions.captureInsertion === "function" && typeof inputActions.insertText === "function") {
				try {
					const span = inputActions.captureInsertion();
					if (span && typeof span.draftRev === "number") {
						if (inputActions.insertText(text, span) === true) return true;
					}
				} catch { /* 落到下面的降级 */ }
			}
			return false;
		}

		function SkillPickerButton(props) {
			const [open, setOpen] = react.useState(false);
			const [query, setQuery] = react.useState("");
			const [rows, setRows] = react.useState([]);
			const [loading, setLoading] = react.useState(false);
			const [active, setActive] = react.useState(0);
			const [anchor, setAnchor] = react.useState(null);
			const btnRef = react.useRef(null);
			const popRef = react.useRef(null);
			const inputActions = props && props.inputActions;

			// 打开时拉一次技能清单
			react.useEffect(() => {
				if (!open) return undefined;
				let alive = true;
				setLoading(true);
				fetch(API.harness, { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((data) => {
						if (!alive) return;
						const out = [];
						for (const g of (data && data.groups) || []) {
							for (const s of g.skills || []) {
								if (!s || !s.name) continue;
								const analysis = s.aiAnalysis && s.aiAnalysis.summary;
								out.push({
									name: s.name,
									desc: analysis || s.description || "",
									group: g.title || "",
								});
							}
						}
						out.sort((a, b) => a.name.localeCompare(b.name));
						setRows(out);
						setActive(0);
					})
					.catch(() => { if (alive) setRows([]); })
					.finally(() => { if (alive) setLoading(false); });
				return () => { alive = false; };
			}, [open]);

			// 定位：桌面贴按钮上方，手机贴输入卡上方（底部对齐）。
			//
			// 旧算法只夹了左右/顶部：340 宽按按钮左边摆，手机上按钮靠右 →
			// 左边 42、右边 6，整块是歪的；高度又死按 380 往上顶，
			// 底边直接压进输入卡 55px（实测 pop 771 / 输入卡 716），
			// 最后一屏技能被输入框盖住。这里统一改成：
			//   1) 手机用 bottom 定位，底边贴"输入卡顶 - 8"，不压输入框；
			//      内容不足时自动向上收，不会留一截悬空。
			//   2) 高度上限 = 可用高度（视口顶 8 到输入卡顶 8），手机再收到 460。
			//   3) 桌面维持按钮上方，越界时翻到下方并夹进可用区。
			react.useEffect(() => {
				if (!open) return undefined;
				const place = () => {
					const el = btnRef.current;
					if (!el) return;
					const r = el.getBoundingClientRect();
					const vw = window.innerWidth;
					const vh = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
					// 输入卡是 composer 的外层白卡；类名是构建产物、随时会变，这里按多选择器兜底：
					// 谁先命中且可见就用谁，都找不到就当视口底（贴底、不压输入框）。
					const composerSelectors = ['[class~="RlGAzG_card"]', '[data-dsh-composer]', '[data-testid="composer"]', 'form', 'footer'];
					let composer = null;
					for (const sel of composerSelectors) {
						try {
							const el = document.querySelector(sel);
							if (el) {
								const r0 = el.getBoundingClientRect();
								if (r0 && r0.width > 0 && r0.height > 0) { composer = el; break; }
							}
						} catch { /* 选择器不支持就试下一个 */ }
					}
					const composerTop = composer ? composer.getBoundingClientRect().top : vh;
					const limitBottom = Math.min(vh, composerTop) - 8; // 下界：不许压输入框
					const room = Math.max(160, limitBottom - 8); // 可用高度
					const phone = vw <= 480;
					const W = phone ? Math.max(240, vw - 24) : 340;
					// 手机居中（左右各 12），桌面优先贴按钮左边、越界再夹进来
					const left = phone ? Math.max(8, (vw - W) / 2) : Math.max(8, Math.min(r.left, vw - W - 8));
					if (phone) {
						setAnchor({ left, width: W, bottom: Math.max(0, vh - limitBottom), maxH: Math.min(460, room) });
						return;
					}
					let top = r.top - 380 - 8;
					if (top < 8) top = r.bottom + 8;
					top = Math.max(8, Math.min(top, limitBottom - 380));
					setAnchor({ left, width: W, top, maxH: Math.min(380, room) });
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				const vv = window.visualViewport;
				if (vv) {
					vv.addEventListener("resize", place);
					vv.addEventListener("scroll", place);
				}
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
					if (vv) {
						vv.removeEventListener("resize", place);
						vv.removeEventListener("scroll", place);
					}
				};
			}, [open]);

			// 点外面关掉
			react.useEffect(() => {
				if (!open) return undefined;
				const onDown = (e) => {
					const t = e.target;
					if (popRef.current && popRef.current.contains(t)) return;
					if (btnRef.current && btnRef.current.contains(t)) return;
					setOpen(false);
				};
				document.addEventListener("mousedown", onDown, true);
				return () => document.removeEventListener("mousedown", onDown, true);
			}, [open]);

			const filtered = react.useMemo(() => {
				const q = query.trim().toLowerCase();
				if (!q) return rows;
				return rows.filter((r) => r.name.toLowerCase().includes(q) || String(r.desc).toLowerCase().includes(q));
			}, [rows, query]);

			react.useEffect(() => { setActive(0); }, [query]);

			const pick = react.useCallback((row) => {
				if (!row) return;
				const ok = insertSkillIntoDraft(inputActions, row.name);
				setOpen(false);
				setQuery("");
				if (!ok) {
					// 插入通道不可用时，至少把名字给到用户，不至于白点
					try { console.warn("[dsh-curator] 无法插入技能名，inputActions 不可用"); } catch { /* noop */ }
				}
			}, [inputActions]);

			const onKeyDown = (e) => {
				if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
				if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)); return; }
				if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
				if (e.key === "Enter") { e.preventDefault(); pick(filtered[active]); }
			};

			const label = props && props.label ? props.label : "技能";

			return h(
				react.Fragment,
				null,
				h("style", { dangerouslySetInnerHTML: { __html: SKILL_BTN_CSS } }),
				h(
					"button",
					{
						ref: btnRef,
						type: "button",
						className: "ss-skillbtn",
						title: "插入技能",
						"aria-label": "插入技能",
						"aria-expanded": open ? "true" : "false",
						onClick: () => setOpen((v) => !v),
					},
					h(
						"svg",
						{ width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
						h("path", { d: "M8 2.5 9.6 6 13 7.6 9.6 9.2 8 12.7 6.4 9.2 3 7.6 6.4 6z" }),
					),
					h("span", { className: "ss-skillbtn-label" }, label),
				),
				open && anchor
					? h(
						"div",
						{
							ref: popRef,
							className: "ss-skillpop",
							"data-ss-skillpop": "",
							style: {
								left: anchor.left + "px",
								width: anchor.width + "px",
								maxHeight: anchor.maxH + "px",
								// 手机走 bottom 定位（底边贴输入卡），桌面走 top
								...(anchor.bottom != null ? { bottom: anchor.bottom + "px" } : { top: anchor.top + "px" }),
							},
							onKeyDown: onKeyDown,
						},
						h(
							"div",
							{ className: "ss-skillpop-searchwrap" },
							h(
								"svg",
								{ viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", "aria-hidden": "true" },
								h("circle", { cx: 7, cy: 7, r: 4.3 }),
								h("path", { d: "M10.2 10.2 13.6 13.6" }),
							),
							h("input", {
								className: "ss-skillpop-search",
								type: "text",
								placeholder: "搜索技能…",
								value: query,
								autoFocus: true,
								onChange: (e) => setQuery(e.target.value),
							}),
						),
						loading
							? h("div", { className: "ss-skillpop-empty" }, "加载中…")
							: filtered.length === 0
								? h("div", { className: "ss-skillpop-empty" }, rows.length === 0 ? "没有可用技能" : "没有匹配的技能")
								: h(
									"ul",
									{ className: "ss-skillpop-list" },
									filtered.slice(0, 200).map((row, i) =>
										h(
											"li",
											{ key: row.name },
											h(
												"button",
												{
													type: "button",
													className: "ss-skillpop-row",
													"data-active": i === active ? "true" : undefined,
													onMouseEnter: () => setActive(i),
													onClick: () => pick(row),
												},
												h("span", { className: "ss-skillpop-name" }, row.name),
												row.desc ? h("span", { className: "ss-skillpop-desc" }, row.desc) : null,
											),
										),
									),
								),
					)
					: null,
			);
		}

		/* ================================================================ *
		 * registration
		 * ================================================================ */

		const PANEL_ID = "dsh-curator";
		/* inject 里加 remote + remote.pluginManager：
		 * 官方插件页的「运行中/已关闭/异常」状态来自
		 *   remote.pluginManager.listPlugins() 的 fiberPhase 字段（entry 级运行时相位）
		 * 与 listBundles() 的 rows[].entryId 的关联。curator 要在详情抽屉里
		 * 显示同样的状态、并渲染插件注册的原生组件，就必须拿同一份数据源。
		 * 这些 inject 名单在宿主处按名字解析，官方页可用即 curator 可用。
		 * ⚠️ "remote" 本身也必须写进 inject：宿主的 ctx 是带 inject 守卫的代理，
		 * 访问任何未注入的属性会当场 throw（`cannot get property "remote" without
		 * inject`），可选链 `ctx.remote?.x` 拦不住这个 throw。官方插件页
		 * （dsh-client-ui-plugin-manager）同样是 "remote" 与 "remote.pluginManager"
		 * 都写。只写后者 → apply() 抛错 → fiber failed → 整个 web boot 挂掉。 */
		const inject = ["slots", "locale", "remote", "remote.pluginManager"];
		/** 宿主注入的共享服务引用（apply 时赋值）。slots = 全宿主共享的槽位注册表。 */
		let hostSlots = undefined;
		let hostRemote = undefined;
		/** 宿主 locale 服务：渲染作者组件时按 entry.options.locale 生成 t 注入 props */
		let hostLocale = undefined;

		function apply(ctx) {
			/* 启动自检（2026-10-17 事故后加）：apply 里任何一步抛错 = fiber FAILED =
			 * 整个 web boot 挂掉（用户看到 "1 entry did not activate"）。所以把
			 * 「访问 ctx 上可能未注入的服务」全部收进守卫 —— 守卫返回 undefined
			 * 而不是抛错，功能降级（对应区块隐藏），绝不再拖垮启动。
			 * 验证方式：宿主守卫抛 `cannot get property "x" without inject`，
			 * 这里用 try/catch 主动探测一次，把结果缓存下来。 */
			const can = {};
			for (const key of ["slots", "locale", "remote", "remote.pluginManager"]) {
				try {
					const segs = key.split(".");
					let v = ctx;
					for (const seg of segs) { v = v?.[seg]; }
					can[key] = v !== undefined;
				} catch {
					can[key] = false; // inject 守卫抛错 = 未注入 → 走降级
				}
			}
			hostSlots = can.slots ? ctx.slots : undefined;
			hostRemote = can["remote.pluginManager"] ? ctx.remote?.pluginManager : undefined;
			hostLocale = can.locale ? ctx.locale : undefined;
			if (!can.slots || !can.locale) {
				// 连 slots/locale 都拿不到 = inject 名单与宿主不匹配（以后有人改名单时保护）
				console.warn(
					"[dsh-curator] ctx 注入自检失败 slots=" + can.slots + " locale=" + can.locale +
					" remote=" + can.remote + " remote.pluginManager=" + can["remote.pluginManager"] +
					" —— 面板不注册，避免拖垮启动",
				);
				return; // 主动放弃注册：面板缺失远好于 DSH 全崩
			}
			ensureStyle();
			installPickerSkin(ctx);
			ctx.effect(() => {
				try {
					ctx.locale.register(NS, { zh, en });
				} catch {
					/* locale 不可用就用内置中文 */
				}
				try {
					tr = ctx.locale.bind(NS);
				} catch {
					tr = (key) => zh[key] ?? key;
				}
				const disposers = [];
				try {
					disposers.push(
						ctx.slots.inject("sidebar.panellist", () =>
							ctx.slots.register(
								{ name: "sidebar.panellist", id: PANEL_ID, order: 40, label: () => tr("panelTitle") },
								function StationIcon(iconProps) {
									return h(
										"svg",
										{
											"data-dsh-panel-entry": PANEL_ID,
											viewBox: "0 0 16 16",
											width: (iconProps && iconProps.size) || 16,
											height: (iconProps && iconProps.size) || 16,
											fill: "none",
											stroke: "currentColor",
											strokeWidth: 1.3,
											strokeLinecap: "round",
											strokeLinejoin: "round",
											"aria-hidden": "true",
										},
										h("path", { d: "M4 13.5A1.5 1.5 0 0 1 5.5 12H13" }),
										h("path", { d: "M5.5 2H13v12H5.5A1.5 1.5 0 0 1 4 12.5v-9A1.5 1.5 0 0 1 5.5 2z" }),
										h("path", { d: "M6.5 5.5h4M6.5 8h4" }),
									);
								},
							),
						),
					);
					disposers.push(
						ctx.slots.inject("main", () =>
							ctx.slots.register({ name: "main", key: PANEL_ID }, function StationPage() {
								return h(Panel);
							}),
						),
					);
					/* 输入框左侧「+ 技能」：curator 自带的技能入口。
					 * 原先这个位置由 @weibaohui/skills-management 提供，但它已从
					 * profile 的 bundles 列表掉出（装别的插件时被重写），按钮随之消失。
					 * conversation.input.left 是 list 槽位，可以和别人共存，
					 * 所以即便那个插件以后回来，两个入口也不会互相顶掉。 */
					disposers.push(
						ctx.slots.inject("conversation.input.left", () =>
							ctx.slots.register(
								{
									name: "conversation.input.left",
									id: "dsh-curator-skill",
									order: 60,
								},
								function CuratorSkillSlot(slotProps) {
									return h(SkillPickerButton, {
										inputActions: slotProps && slotProps.inputActions,
										label: "技能",
									});
								},
							),
						),
					);
				} catch (error) {
					console.warn("[dsh-curator] panel registration failed:", error);
				}
				return () => {
					for (const dispose of disposers.splice(0)) dispose();
				};
			}, "dsh-curator: ui mounts");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

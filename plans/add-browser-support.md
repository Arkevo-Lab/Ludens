# 内置浏览器 Baseware、通用设备视口（Viewport）与三态右侧工作台实施方案

## 1. 背景与目标

为降低新用户上手门槛（无需配置模拟器、CUA 权限或硬件桥即可直接打开网页/Three.js 游戏开玩），同时对齐 Ludens 四层正交架构，引入**运行态动态注入的内置浏览器 Baseware** 与**统一设备视口（Viewport）双模架构**：

1. **运行态探测与一等公民模型**：
   - 当 Ludens 以桌面端（`ludens-app` Electron）运行时，Electron 主进程启动本地零端口 UDS `BrowserHost`（`browser-host.sock` + `browser-host.json`），`ludens-server` 自动探测并动态注入可用的内置浏览器驱动（`builtin:browser`）与内置节点（`builtin-browser`）。
   - 协议与前端预留两类一等公民接口：**`browser`（内置浏览器）** 与 **`computer`（受控计算机 / CUA 远程虚拟机，不假定已连接，未提供实时视口流时平滑回退观测态）**，并将传统设备的采样快照统一收编为基础态 **`observe`**。
2. **每工作区独立隔离 Browser Space**：
   - 使用内置浏览器的工作区按 `sessionId = workspaceId` 在 `BrowserHost` 中拥有独立的 `WebContentsView` 与 `persist:ludens-browser-<sessionId>` 存储隔离，支持多工作区后台并行（`backgroundThrottling: false` + 后台保活）、切换工作区秒切对应页面。
   - 默认提供零外部依赖的内置 3D WebGL 互动起始页（用户未填初始 URL 时开箱即玩）。
3. **单帧源 + 双模 `<DeviceViewport />`（Electron 原生贴槽 + Web `/viewport` 二进制串流兼容口）**：
   - Electron 本地（`electron-local` 且 `nativeHostId` 匹配本机）：原生 `WebContentsView` 贴合右侧栏槽位（0ms WebGL + 原生音频）；主窗口弹出 Modal 遮挡时自动用最新帧静态占位。
   - Web Console / 手机端 / 远程连桌面宿主：经 `ludens-server` `/viewport` WebSocket（HMAC ticket 鉴权）接收裸 JPEG/WebP 二进制帧流（`createImageBitmap` 渲染），并在 `Manual` 模式下回传鼠标、滚轮、键盘与 Pointer Lock 相对位移。
4. **右侧栏（`codex-right-dock`）进化为可拖拽调宽的三态设备工作台**：
   - 统一承载 `browser` | `computer` | `observe` 三种形态，与左侧对话流历史证据检视（`inspectedTurn`）无缝切换。

---

## 2. 模块边界与任务拆分

### Phase 0: `@ludens/protocol` 共享契约（前置锁定）
- `protocol/src/viewport.ts`（纯浏览器安全）：定义 `DeviceStageKind` (`"browser" | "computer" | "observe"`)、`ViewportState`、`ViewportCapabilities`、`ViewportHumanInput`、`ViewportControlAction`、`/viewport` 二进制帧编解码（`encodeViewportFrame` / `decodeViewportFrame`）以及 `BrowserHost` UDS 请求/响应/事件类型与内置起始页 URL 常量。
- `protocol/src/browser-host-paths.ts`（Node 路径解析）：`resolveBrowserHostSocketPath`、`browserHostRuntimeFilePath`、`BrowserHostRuntimeInfo`。
- `protocol/src/drivers.ts` & `protocol/src/machines.ts`：`BUILTIN_BROWSER_DRIVER_SPEC` (`"builtin:browser"`)、`BUILTIN_BROWSER_DRIVER`、`BUILTIN_LOCAL_BROWSER_MACHINE` (`id: "builtin-browser"`)、`stageKind` 元数据支持。
- `protocol/src/workspaces.ts` & `protocol/src/app-rpc.ts`：支持工作区初始 `url` 配置、`viewport/describe`、`viewport/action`、`viewport/input`、`browserHost/notify` RPC 与 `"viewport"` 事件主题。

### Phase 1A: `baseware/` 内置 `browser` 驱动与通用 `Viewport` 扩展
- `baseware/src/contracts.ts` & `protocol.ts` & `core.ts`：为 `DriverProvider` 增加可选 `viewport` 接口（`describe`、`performAction`、`sendHumanInput`、`subscribe`）；`BasewareCore` 支持 `viewport.describe` / `viewport.action` / `viewport.input`（严格门禁：仅 `mode === "manual"` 时放行人工透传输入）与 `viewport.subscribe`。
- `baseware/src/drivers/browser/`：连接 `BrowserHost` UDS，暴露游戏级视觉控制器：
  - `screen.capture`（零等待读最新 Screencast 帧或即时抓帧，直入 `ObservationStreamSpool` 喂 30Hz `perception.py`）；
  - `page.open` / `page.reload` / `page.back` / `page.forward` / `page.state` / `viewport.resize`；
  - `keyboard.down` / `keyboard.up` / `keyboard.press` / `keyboard.type`；
  - `mouse.move` / `mouse.moveRelative`（支持 Pointer Lock 3D 视角）/ `mouse.down` / `mouse.up` / `mouse.click` / `mouse.wheel`；
  - `input.play`（毫秒级批量输入序列，支持取消）；
  - `release(epoch)` 撤权/断联时强制取消序列并触发 `releaseAll` 抬起全部按键与鼠标键。
- `baseware/src/main.ts`：透传 `--session-id`、`--initial-url`、`--browser-socket`。

### Phase 1B: `desktop/` Electron `BrowserHost` 与本地原生贴槽桥接
- `desktop/src/browser-host.ts`：
  - 维护按 `sessionId` 隔离的 `WebContentsView` 实例池（`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`backgroundThrottling: false`、`persist:ludens-browser-<sessionId>`、安全 URL 守卫阻止跳 `ludens-app:`/`ludens-media:`/`file:`）；
  - 内置零网络依赖的 3D WebGL 互动起始页（Canvas/WebGL 实时 3D 躲避/旋转小游戏 + 快捷入口），默认开箱即有 60fps 画面可玩可测；
  - 进程内 `webContents.debugger` 驱动 CDP `Page.startScreencast` + `Input.dispatch*` + 按键状态追踪与 `releaseAll`；
  - 后台保活：未贴合前台槽位时挂入隐藏保活宿主容器并维持Screencast / 定时捕帧兜底，确保切工作区/切页签/最小化时 30Hz 帧流不断；
  - 监听 `browser-host.sock` 并原子写入 `browser-host.json`，启动/关闭时通知本地 `app-server`。
- `desktop/src/preload.ts` & `desktop/src/main.ts`：向受信任 Console 暴露 `window.ludens.viewport`（`attach` / `updateBounds` / `detach` / `getHostInfo`），支持 `Auto` 模式禁人工穿透与 Modal 遮挡隐藏。

### Phase 1C: `server/` 运行态注入、`/viewport` 二进制串流口与工作区模板
- 运行态探测 `probeBrowserHost(home)`：桌面端 `BrowserHost` 在线时，在 `InitializeResult.capabilities`、`baseware/overview`、机器解析与 `launcher.ts` 中自动注入 `builtin-browser` 与 `builtin:browser`（离线时不凭空注入，已创建工作区给出清晰离线状态并在桌面端上线后自动恢复）。
- `workspace-init.ts`：支持 `driver: "browser"` 与可选 `url`，生成开箱即用的 30Hz `screen.capture` `perception.py` 模板。
- `viewport/describe`、`viewport/action`、`viewport/input` RPC 与 `GET /viewport` WebSocket（复用 `/media` HMAC ticket 鉴权）：
  - 若工作区 Baseware 已运行则经 Baseware 转发（受 `epoch` 控制权门禁保护）；若工作区尚处于待命态且目标为 `browser` 且 `BrowserHost` 在线，则以 `manual` 模式直连同一 `sessionId = workspaceId` 预热浏览，使工作区启动前后共享同一页面状态；
  - 单槽丢旧帧（drop-oldest）向 Web 客户端推送二进制帧，不阻塞感知采样与 JSON-RPC。

### Phase 2: `client/` `useDeviceViewport`、`<DeviceViewport />` 与三态右侧工作台
- `client/features/live/use-device-viewport.ts`：统一封装视口状态订阅、`/viewport` 二进制 WS 帧解码（`createImageBitmap`）、`electron-local` 原生槽位同步（`ResizeObserver` + Modal/Dialog 遮挡自动降级静态帧）、`Manual` 模式键鼠/滚轮/Pointer Lock 归一化回传。
- `client/features/live/device-viewport.tsx`：统一渲染 `browser`（含地址栏、前进后退刷新、尺寸、控制权胶囊与一键收回控制权）与 `computer`（无地址栏的主机视口头）双一等公民 UI。
- `client/features/live/shiori-cockpit.tsx`：右侧栏升级为支持拖拽调宽的三态设备工作台（`browser | computer | observe`），保留 `inspectedTurn` 历史调用帧检视切换。
- `client/features/workspaces/workspace-create-form.tsx`：突出一等公民目标卡片（桌面端在线时点亮「内置浏览器」并支持填写初始网页/Three.js 游戏 URL，并列「计算机 CUA」与「扩展驱动/设备」），同步 `en.json` / `zh.json`。

### Phase 3: 联调测试、多语种文档同步、浏览器真机验收与收尾
- 全仓 `bun run typecheck` 与 `bun run test` 全绿；
- 同步 `README.md` / `README.zh.md` 及 `docs/en/` / `docs/zh/` 相关设备与架构文档；
- 启动服务并亲自打开浏览器进行交互式视觉与功能验收（新建内置浏览器工作区、Three.js/WebGL 实时画面串流、地址栏跳转、Manual 键鼠操作、Auto/Reclaim Control 切换、三态右侧栏拖拽与历史帧检视）；
- 验收通过后删除 `plans/add-browser-support.md` 并清空 `PLANS.md` 与 `plans/index.md` 索引，在 `add_browser_support` 分支整理提交。

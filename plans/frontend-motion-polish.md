# 前端动效体系与全站过渡优化施工计划（M1–M6）

- **状态**: 进行中（Branch: `feat/frontend-motion-polish`，基于 `origin/main`）
- **目标**: 为 `@ludens/app` 建立双层机械感动效体系（品牌像素/状态灯/预算格保留 `60ms steps()`；空间容器、弹窗、抽屉、折叠面板、胶囊统一采用 `cubic-bezier(0.16, 1, 0.3, 1)` `140–220ms` 利落指数缓动），并完成 M1–M6 全模块优化与桌面伴侣挂件 Bug 修复。

## 已锁定设计契约
1. **双层机械感动效语言**：保留 `app/app/pixel-motion.css` `--step: 60ms` 像素节拍；空间层统一 `--ease-out-expo` (`140–220ms`)。
2. **全量覆盖 (M1–M6)**：M1 动效底座与无障碍性能 + M2 弹窗/抽屉/浮层 + M3 壳层/视图/右坞 + M4 全站 `<details>` 与 Tab 指示器 + M5 Live/Replay 微动效 + M6 Desktop Pet 修复与润色。
3. **主舞台轻过渡 & Live 保活换仓**：`main.page-content` 使用局部淡入 / `document.startViewTransition`；Live 切换工作区保持 `ShioriWorkbench` 挂载并柔化刷新，消除 `Loading run...` 整屏闪白。
4. **侧栏与右坞收折**：窄屏（`<= 680px` / `< 1100px`）补齐 `180ms` 抽屉滑入滑出与遮罩淡变；桌面宽屏采用 `160ms` 定宽裁切快收折 + Live/Replay 右坞 DOM 保活。

## 并行 Swarm 分片（零文件冲突）
- **Coordinator 共享底座**: `app/components/use-motion-preferences.ts`, `app/app/globals.css` (`:root` motion tokens)
- **Worker 1 (`shell-overlays`)**: `globals.css`（动效底座/reduced-motion/shell/docs/details）、`shell/`（`console-shell`, `console-sidebar`, `use-dashboard-controller`, `desktop-chrome`, `desktop-quick-switcher`, `active-cores`, `loop-lab`）、`components/ui/*`、`components/device-contention-dialog.*`
- **Worker 2 (`live-cockpit`)**: `features/live/*`（`shiori-cockpit`, `activity-feed*`, `use-live-auto-scroll`, `event-pool-panel*`, `observation-media*`）、`components/model-picker-dialog.*`
- **Worker 3 (`replay-views`)**: `features/replay/*`（合成层 `cqi` 播放头/右坞/popover/search）、`features/baseware/*`（原生 `<dialog>` 居中窗与右抽屉 `@starting-style` + `translateX`）、`features/capabilities/*`、`features/workspaces/*`、`features/docs/docs-view.tsx`
- **Worker 4 (`pet-and-companion`)**: `features/pet/*`（桌面通知卡片与刷新状态）、`public/companion/pet.css` & `pet.js`（修复 `#body.pressed` 死代码按压形变、`#bubble.activity` 关闭闪缩、`#activity-actions` / `#effect` 淡入淡出）
- **Verifier (`verifier`)**: 集成审查 + `typecheck` + `test` + `build` + `pet:smoke` + 真实浏览器视觉操作验收

# Plan: OMP 18.22.2 Upgrade, Shiori Model Stickiness & GPT-6.2 Presets

## 背景与目标

将 Ludens 底层的 `@oh-my-pi/*` 运行时依赖从 `18.18.8` 升级至 `18.22.2`（基线 `origin/main` `649ef53`），完整移植三份本地补丁，利用 OMP `18.22.2` 新增会话开关锁死 Shiori 多模态模型运行期粘性，并将默认模型与前端预设切换至 `6.2` 系列（`openai-codex/gpt-6.2-sol`、`openai/gpt-6.2-sol`、`anthropic/claude-sonnet-5-5`、`opencode-go/deepseek-v4.1-flash`）。

## 施工清单

1. **依赖升级与三份补丁重建（`18.18.8` -> `18.22.2`）**
   - 更新 `core/package.json` 中 7 个 `@oh-my-pi/*` 包至 `18.22.2`。
   - 清理旧 `@18.18.8.patch`，执行 `bun install` 获取干净 `18.22.2` 源码，通过 `bun patch` + `bun patch --commit --patches-dir=core/patches` 重建：
     - `@oh-my-pi/pi-agent-core@18.22.2`：`parentSessionId` 透传与 `.d.ts` 对齐。
     - `@oh-my-pi/pi-ai@18.22.2`：Codex WebSocket 60s 冷却恢复、15 MiB 本地帧预算、`sizeBlockedUntilCompaction` 与协议拒绝 `closeCode` 硬禁用。
     - `@oh-my-pi/pi-coding-agent@18.22.2`：预测压缩改造（移除 `refresh-on-growth`、`pendingSpec` `untilAborted` 等待、`:spec:` 隔离会话 + `parentSessionId`、`omp.compaction.speculation` 诊断通道，合并 `withLoopPhase` + `untilAborted` 导入）。

2. **收紧 Shiori 宿主模型粘性不变量**
   - 在 `core/src/core/agent-omp/session.ts` 的 `createOmpSession` 中默认注入 `disableModelFallback: true`、`disableServerSideFallback: true`、`suppressAutoPrewalk: true`（调用方未显式覆盖时生效），配合 `"retry.modelFallback": false` 与 `imageCountBudget: Infinity` 阻断运行期模型隐式漂移。
   - 补充单测锁死 `createOmpSession` 对三重模型粘性保护的传递与生效行为。

3. **版本号、后端默认模型与前端 UI 预设刷新**
   - 运行时 OMP 版本号更新为 `18.22.2`（`core/src/cli/main.ts`、`core/src/core/agent-omp/shiori.ts` 等）。
   - 后端与向导默认模型从 `openai-codex/gpt-6.1-sol` 切换至 `openai-codex/gpt-6.2-sol`（`core/src/cli/main.ts`、`core/src/daemon/launcher.ts`、`core/src/core/agent-omp/models.ts`、`core/src/core/query/workspaces.ts`、`core/src/perf/run-context.ts`、`app/features/workspaces/use-workspace-creation-catalog.ts` 等）。
   - 前端 Studio 预设（`app/features/workspaces/workspace-studio-view.tsx`）更新为 `openai-codex/gpt-6.2-sol`、`openai/gpt-6.2-sol`、`anthropic/claude-sonnet-5-5`、`opencode-go/deepseek-v4.1-flash`，同步更新 `settings-view.tsx` 占位符与 `app/messages/{en,zh}.json` 的 `searchPlaceholder`。
   - 同步刷新 `core/tests/**` 与 `app/tests/**` 相关单测夹具与断言。

4. **全量测试与真机浏览器操作验收**
   - 跑通 `protocol`、`baseware`、`core`（TS + Python + transport/ws-recovery/speculation/background-compaction）、`app`（tsc + vitest）全套离线检查与单测。
   - 启动本地 Ludens Console 临时实例并通过浏览器核验全局设置、Studio 模型预设按钮、`gpt-6.2` 占位符以及 `ModelPickerDialog` 中 `18.22.2` 模型目录（`gpt-6.2-sol`、`gpt-6.2-astra`）与 Effort / Speed 内联抽屉交互。

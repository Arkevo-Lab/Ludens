# 开发与生产脚本体系重构施工计划

## 目标
建立「根目录总控编排 + 各包自治 `dist/`」的开发与生产脚本架构，消除跨包越界编译、统一产物目录、隔离开发态数据目录至 `~/.ludens-dev`，并同步更新全仓双语文档。

## 核心改动

1. **各包标准产物统一为 `dist/`**
   - `client/dist`（纯静态 SPA，Electron 打包态 `Resources/client`）
   - `server/dist`、`core/dist`、`baseware/dist`、`desktop/dist/electron`
   - 各子包仅保留纯单包原子脚本，`desktop/scripts/build-electron.mjs` 不再越界编译其他子包。

2. **根目录开发阶段 4 模式**（默认隔离 `~/.ludens-dev`，支持 `--real-home` / `:real` 挂载真实 `~/.ludens`）
   - `bun run dev` / `bun run dev:web`（`dev:web:real`）：受管 `ludens-server --dev` + Vite HMR
   - `bun run dev:desktop`（`dev:desktop:real`）：纯 Vite HMR + Electron 原生 UDS 自管本地 server（不双起 TCP server）
   - `bun run dev:client`：纯异源 Vite 前端（零本地后端，连远程/云端 server）
   - `bun run dev:server`（`dev:server:real`）：独立前台启动开发态 `ludens-server`

3. **根目录生产阶段产线与全仓质检**
   - `bun run build`（及分产线 `build:client` / `build:server` / `build:sandbox` / `build:desktop`）
   - `bun run pack:desktop` / `bun run dist:desktop` / `bun run start:selfhost`
   - `bun run typecheck` / `bun run test`

4. **全仓文档同步**
   - 同步 `docs/zh/**` 与 `docs/en/**`（保持 1:1 对称及链接有效）
   - 同步根 `README*`、`CONTRIBUTING*` 等说明文档

## 验收清单
- [ ] 全仓无残留 `client/out`、`desktop:build/dev/pack/dist`、`vite.config.ts` `/api` 代理、`client/` 跨包拉 `server`/`desktop` 代码
- [ ] `desktop/scripts/build-electron.mjs` 不再越界编译 `../server`、`../core`、`../baseware`
- [ ] `dev:web`、`dev:desktop`、`dev:server` 默认隔离 `~/.ludens-dev` 且 `dev:desktop` 不双起 TCP server
- [ ] `bun run build`、`bun run typecheck`、`bun run test` 全量通过
- [ ] 清理本施工计划并提交 PR

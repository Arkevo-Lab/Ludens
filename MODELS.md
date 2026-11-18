# 模型梯队与分工

## 模型画像

- **大而慢**
  - **Gemini 4 Carbon**：架构设计、前端审美与统筹指挥能力最好，适合做主控与前端。
  - **Gemini 4 Argon**：统筹拆解、契约对齐与验收把关稳健，适合做统筹负责人与 Verifier。
  - **Gemini 4 Hydrogen**：运行巡检与双语长文档撰写同步性价比高，适合做监控与文档同步。
  - **GPT Astra**（`openai-codex/gpt-6.2-astra`）：风格挑剔刻薄，不适合直接干活，适合做代码审计。
- **中等均衡**
  - **GLM 5.3**（`zhipu-coding-plan/glm-5.3`）：中等尺寸里综合性能最强，速度比 Muse Spark 慢，适合稍复杂的后端实现。
  - **Kimi 3.1**（`kimi-code/k3.1-pro`）：后端水平与 `glm-5.3` 接近，前端审美比 `glm-5.3` 好一些。

- **小而快**
  - **Muse Spark 1.3**（`opencode-go/muse-spark-1.3-contributor`）：能力略低于`glm-5.3`、速度略大于 `glm-5.3` ，实际按小而快模型用。
  - **DeepSeek v4.1 Flash**（`opencode-go/deepseek-v4.1-flash`）：吐字极快、输出上限高，适合高吞吐搬砖与跑腿。
  - **GLM 5.3 Flash**（`zhipu-coding-plan/glm-5.3-flash`）：速度不错、能力尚可，适合日常后端杂活与快速检索。

## 分工思路

- **顶层统筹与前端/架构**：由 Gemini 4 三档协同把关——**Carbon** 负责主控调度、架构设计与前端实现（并开浏览器验收），**Argon** 负责任务拆解、契约对齐与最终验收（Verifier），**Hydrogen** 负责运行巡检（Monitor）与双语长文档撰写同步。
- **后端**：后端在契约与测试明确的前提下，指挥中小模型（`glm-5.3`、`k3.1-pro`、`muse-spark-1.3`、`glm-5.3-flash`）即可胜任。
- **杂活**：代码检索、批量改夹具、跑测试等高吞吐体力活优先派给小而快模型（`deepseek-v4.1-flash`、`glm-5.3-flash`、`muse-spark-1.3`）。
- **审计**：需要挑刺排查边界问题时，按需拉 `gpt-6.2-astra` 做只读审查。

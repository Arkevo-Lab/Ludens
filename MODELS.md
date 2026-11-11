# 模型梯队与分工

开发时可结合本机 `omp` 等工具按模型特性分工协作：

## 梯队画像

- **大而慢**
  - **Gemini 4 Carbon**：架构设计、前端审美与统筹指挥能力最好，适合做主控与前端。
  - **Kimi 3.1**（`kimi-code/k3.1-pro`）：后端水平与 `glm-5.3` 接近，前端审美比 `glm-5.3` 好一些。
  - **GPT Astra**（`openai-codex/gpt-6-astra`）：风格挑剔刻薄，不适合直接干活，适合做代码审计。
- **中等均衡**
  - **GLM 5.3**（`zhipu-coding-plan/glm-5.3`）：中等尺寸里综合性能最强，速度比 Muse Spark 慢，适合稍复杂的后端实现。
- **小而快**
  - **Muse Spark 1.3**（`opencode-go/muse-spark-1.3-contributor`）：体积虽大但上限不如 `glm-5.3`、速度又比 `glm-5.3` 快，实际按小而快模型用。
  - **DeepSeek v4.1 Flash**（`opencode-go/deepseek-v4.1-flash`）：吐字极快、输出上限高，适合高吞吐搬砖与跑腿。
  - **GLM 5.3 Flash**（`zhipu-coding-plan/glm-5.3-flash`）：速度不错、响应稳，适合日常后端杂活与快速检索。

## 分工思路

- **前端与架构**：前端看重设计与审美直觉，优先由 Carbon 这类强设计模型亲自写并开浏览器验收；整体架构拆解与接口契约也由主控模型把关。
- **后端与杂活**：后端在契约与测试明确的前提下，指挥中小模型（`glm-5.3`、`muse-spark-1.3`、`deepseek-v4.1-flash`、`glm-5.3-flash`）即可胜任；双语文档同步、补测试、代码检索等体力活也优先派给小而快模型。
- **审计**：需要挑刺排查边界问题时，可按需拉 `gpt-6-astra` 做只读审查。

# 模型梯队与分工

## 模型画像

- **中等均衡**
  - **GLM 5.3**（`zhipu-coding-plan/glm-5.3`）：中等尺寸里综合性能最强，速度比 Muse Spark 慢，适合稍复杂的后端实现。
  - **Kimi 3.1**（`kimi-code/k3.1-pro`）：后端水平与 `glm-5.3` 接近，前端审美比 `glm-5.3` 好一些。
- **小而快**
  - **Muse Spark 1.3**（`opencode-go/muse-spark-1.3-contributor`）：能力略低于`glm-5.3`、速度略大于 `glm-5.3` ，实际按小而快模型用。
  - **GLM 5.3 Flash**（`zhipu-coding-plan/glm-5.3-flash`）：速度不错、能力尚可，适合日常后端杂活与快速检索。
  - **DeepSeek v4.1 Flash**（`opencode-go/deepseek-v4.1-flash`）：吐字极快，适合高吞吐搬砖与跑腿。

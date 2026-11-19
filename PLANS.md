# Plans

施工前在 `plans/` 写计划，`[[plans/<name>]]` 双链到对应文件。完成施工后删除计划文件并清除本索引，防止 plans 无限增长。

- [[plans/six-package-architecture]] — 六包四层正交架构重构（`protocol` / `baseware` / `core` / `server` / `client` / `desktop` 拆分、4 个正交 CLI、纯 RPC 客户端与全套双语文档同步）

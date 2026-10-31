import { require as tsxRequire } from "tsx/cjs/api";
// The backend lives in @ludens/core core; only the loader entry stays here.
tsxRequire("../../core/src/core/query/worker.ts", import.meta.url);

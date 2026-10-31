import { require as tsxRequire } from "tsx/cjs/api";
// The backend lives in @ludens/rsa core; only the loader entry stays here.
tsxRequire("../../rsa/src/core/query/worker.ts", import.meta.url);

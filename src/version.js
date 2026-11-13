// Worker 入口模块只能有 default 导出：其余具名导出会被 workerd 当作
// named entrypoint，必须是 ExportedHandler，普通常量会直接让 runtime 起不来。
export const VERSION = "0.1.0";

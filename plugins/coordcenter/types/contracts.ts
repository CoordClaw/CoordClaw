/**
 * OpenClaw hook 契约的本地 mirror。
 *
 * 为什么需要：openclaw 的 `OpenClawPluginApi` 在我们这侧被 stub 成 `any`
 * （见 openclaw.d.ts），导致插件与框架之间的 hook 返回值契约在编译期不可见。
 * 一旦插件侧把某字段写成错误类型（例如 `appendSystemContext` 写成 `string[]`
 * 而框架要求 `string`），tsc 无法拦截，只能运行时静默丢弃。
 *
 * 此处把用到的高频契约字段手抄成一份强类型，供插件侧 `extends` / 复用，
 * 让契约错配在构建期暴露。字段来源必须对齐 openclaw 官方契约：
 *   openclaw/dist/hook-types-*.d.ts :: PluginHookBeforePromptBuildResult
 * （docs/plugins/hooks.md:285 也确认 appendSystemContext 是合法返回字段）
 *
 * 维护约束：openclaw 升级后，需核对此处字段与官方 hook-types 是否仍一致。
 */
export interface BeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  /** 框架要求 string（非 string[]）。见 openclaw hook-types PluginHookBeforePromptBuildResult。 */
  appendSystemContext?: string;
}

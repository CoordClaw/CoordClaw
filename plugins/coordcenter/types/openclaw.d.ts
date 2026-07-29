// Ambient module declarations for the external `openclaw` runtime.
// esbuild marks `openclaw` / `@openclaw/*` as --external; tsc ships no type
// info for them. We declare the *exact* symbols the code imports so that:
//   - value imports (emptyPluginConfigSchema) become `any`
//   - type imports used as generics (ChannelPlugin<T>, OpenClawPluginApi)
//     become real type aliases, otherwise `ChannelPlugin<X>` errors with
//     "cannot use namespace as a type" (TS2709).
// Add a new `declare module "openclaw/..."` block if typecheck reports a
// previously-unseen `openclaw/...` specifier.
declare module "openclaw/plugin-sdk" {
  export type OpenClawPluginApi = any;
  export const emptyPluginConfigSchema: any;
}

declare module "openclaw/plugin-sdk/core" {
  export type ChannelPlugin<T = any> = any;
}

declare module "@openclaw/*";

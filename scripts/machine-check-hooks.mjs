// Node type stripping resolves relative imports without extensions, while the
// sources use bare sibling specifiers. This resolve hook retries those with
// ".ts". Imported first by check-machine.mjs, before any dynamic import.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(specifier + ".ts", context);
      }
      throw error;
    }
  },
});

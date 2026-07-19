// ─────────────────────────────────────────────────────────────────────────────
// Optional "pro" feature seam.
//
// The FB-Syndication cluster lives in ./pro/. In the private build that folder
// exists and everything works as before. In the public (open-core) build the
// folder is simply absent: loadPro() returns null, the feature is off, and the
// rest of the server starts unchanged.
//
// We must NOT swallow real errors raised from *inside* pro (a genuine bug in a
// pro module would also throw ERR_MODULE_NOT_FOUND if it imported something
// missing). We only treat "./pro/index.js itself is missing" as "feature off";
// anything else is rethrown.
// ─────────────────────────────────────────────────────────────────────────────

export async function loadPro() {
  try {
    const mod = await import('./pro/index.js');
    return mod.default;
  } catch (e) {
    const isMissingModule = e && e.code === 'ERR_MODULE_NOT_FOUND';
    const ref = String((e && (e.message || e.url)) || '');
    // Only the top-level pro entrypoint being absent means "public build".
    // A missing module *nested under* pro is a real error — rethrow it.
    const isProEntrypointMissing =
      isMissingModule && /[\\/]pro[\\/]index\.js/.test(ref);
    if (isProEntrypointMissing) return null;
    throw e; // real errors inside pro must not be silently hidden
  }
}

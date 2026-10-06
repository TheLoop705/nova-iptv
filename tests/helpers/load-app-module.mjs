import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';

// Exercise the real application TypeScript in Node without bundling a native runtime.
// Native/platform boundaries can be replaced with small explicit ES-module fixtures.
const fixtures = new Map();
registerHooks({
  resolve(specifier, context, nextResolve) {
    let absolute;
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      absolute = fileURLToPath(new URL(specifier, context.parentURL));
    }
    const fixture = fixtures.get(absolute) ?? fixtures.get(specifier);
    if (fixture !== undefined) return { url: 'data:text/javascript,' + encodeURIComponent(fixture), shortCircuit: true };
    if (absolute && !existsSync(absolute)) {
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(absolute + suffix)) return { url: pathToFileURL(absolute + suffix).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('data:text/javascript,')) {
      return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
    }
    if (/\.tsx?(?:\?|$)/.test(url) && url.startsWith('file:')) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

export function appModule(path, mocks = {}, instance) {
  for (const [specifier, source] of Object.entries(mocks)) {
    fixtures.set(specifier.startsWith('src/') ? resolve(specifier) : specifier, source);
  }
  return import(pathToFileURL(resolve(path)).href + (instance ? '?test=' + encodeURIComponent(instance) : ''));
}

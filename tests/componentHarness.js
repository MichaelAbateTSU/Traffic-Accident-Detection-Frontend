import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { transformWithEsbuild } from 'vite';

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

export async function componentHarness(path, dependencies = {}, globals = {}, env = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { code } = await transformWithEsbuild(source, path, { jsx: 'automatic' });
  const slots = [];
  const timers = new Map();
  const timeouts = new Map();
  const effects = [];
  let cursor = 0;
  let dirty = false;
  let props = {};
  let elements = [];
  let nextTimer = 1;
  const context = createContext({
    AbortController,
    console,
    setInterval(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    ...globals,
  });
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) dirty = true;
        slots[index] = next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !equalDeps(previous.deps, deps)) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: callback() };
        });
      }
    },
    useMemo(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) {
        slots[index] = { deps, value: callback() };
      }
      return slots[index].value;
    },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
  };
  const jsx = (type, props) => ({ type, props });
  const exportsBySpecifier = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    ...dependencies,
  };
  const module = new SourceTextModule(code, {
    context,
    initializeImportMeta(meta) { meta.env = env; },
  });
  await module.link(async (specifier) => {
    if (specifier.endsWith('/boundedRefresh.js')) {
      return new SourceTextModule(await readFile(new URL('../src/utils/boundedRefresh.js', import.meta.url), 'utf8'), { context });
    }
    const exports = exportsBySpecifier[specifier] ?? {
      default: specifier.endsWith('.css') ? {} : specifier.split('/').at(-1).replace('.jsx', ''),
    };
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();

  function render(nextProps = props, runEffects = true) {
    props = nextProps;
    cursor = 0;
    dirty = false;
    elements = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object' || !node.props) return;
      elements.push(node);
      visit(node.props.children);
    }
    visit(module.namespace.default(props));
    if (runEffects) effects.splice(0).forEach((effect) => effect());
    return elements;
  }
  return {
    render,
    timers,
    timeouts,
    get elements() { return elements; },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
      for (let count = 0; dirty && count < 20; count++) {
        render();
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (dirty) throw new Error('Component did not settle');
      return elements;
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

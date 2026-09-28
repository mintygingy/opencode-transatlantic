// node_modules/solid-js/dist/server.js
var ERROR = /* @__PURE__ */ Symbol("error");
function castError(err) {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : "Unknown error", {
    cause: err
  });
}
function handleError(err, owner = Owner) {
  const fns = owner && owner.context && owner.context[ERROR];
  const error = castError(err);
  if (!fns) throw error;
  try {
    for (const f2 of fns) f2(error);
  } catch (e) {
    handleError(e, owner && owner.owner || null);
  }
}
var Owner = null;
function createOwner() {
  const o3 = {
    owner: Owner,
    context: Owner ? Owner.context : null,
    owned: null,
    cleanups: null
  };
  if (Owner) {
    if (!Owner.owned) Owner.owned = [o3];
    else Owner.owned.push(o3);
  }
  return o3;
}
function createMemo(fn, value) {
  Owner = createOwner();
  let v3;
  try {
    v3 = fn(value);
  } catch (err) {
    handleError(err);
  } finally {
    Owner = Owner.owner;
  }
  return () => v3;
}
function createContext(defaultValue) {
  const id = /* @__PURE__ */ Symbol("context");
  return {
    id,
    Provider: createProvider(id),
    defaultValue
  };
}
function useContext(context) {
  return Owner && Owner.context && Owner.context[context.id] !== void 0 ? Owner.context[context.id] : context.defaultValue;
}
function children(fn) {
  const memo = createMemo(() => resolveChildren(fn()));
  memo.toArray = () => {
    const c3 = memo();
    return Array.isArray(c3) ? c3 : c3 != null ? [c3] : [];
  };
  return memo;
}
function resolveChildren(children2) {
  if (typeof children2 === "function" && !children2.length) return resolveChildren(children2());
  if (Array.isArray(children2)) {
    const results = [];
    for (let i2 = 0; i2 < children2.length; i2++) {
      const result = resolveChildren(children2[i2]);
      Array.isArray(result) ? results.push.apply(results, result) : results.push(result);
    }
    return results;
  }
  return children2;
}
function createProvider(id) {
  return function provider(props) {
    return createMemo(() => {
      Owner.context = {
        ...Owner.context,
        [id]: props.value
      };
      return children(() => props.children);
    });
  };
}
var sharedConfig = {
  context: void 0,
  getContextId() {
    if (!this.context) throw new Error(`getContextId cannot be used under non-hydrating context`);
    return getContextId(this.context.count);
  },
  getNextContextId() {
    if (!this.context) throw new Error(`getNextContextId cannot be used under non-hydrating context`);
    return getContextId(this.context.count++);
  }
};
function getContextId(count) {
  const num = String(count), len = num.length - 1;
  return sharedConfig.context.id + (len ? String.fromCharCode(96 + len) : "") + num;
}
function setHydrateContext(context) {
  sharedConfig.context = context;
}
function nextHydrateContext() {
  return sharedConfig.context ? {
    ...sharedConfig.context,
    id: sharedConfig.getNextContextId(),
    count: 0
  } : void 0;
}
function createComponent(Comp, props) {
  if (sharedConfig.context && !sharedConfig.context.noHydrate) {
    const c3 = sharedConfig.context;
    setHydrateContext(nextHydrateContext());
    const r = Comp(props || {});
    setHydrateContext(c3);
    return r;
  }
  return Comp(props || {});
}
function Show(props) {
  let c3;
  return props.when ? typeof (c3 = props.children) === "function" ? c3(props.keyed ? props.when : () => props.when) : c3 : props.fallback || "";
}
var SuspenseContext = createContext();
var resourceContext = null;
function createResource(source, fetcher, options = {}) {
  if (typeof fetcher !== "function") {
    options = fetcher || {};
    fetcher = source;
    source = true;
  }
  const contexts = /* @__PURE__ */ new Set();
  const id = sharedConfig.getNextContextId();
  let resource = {};
  let value = options.storage ? options.storage(options.initialValue)[0]() : options.initialValue;
  let p;
  let error;
  if (sharedConfig.context.async && options.ssrLoadFrom !== "initial") {
    resource = sharedConfig.context.resources[id] || (sharedConfig.context.resources[id] = {});
    if (resource.ref) {
      if (!resource.data && !resource.ref[0]._loading && !resource.ref[0].error) resource.ref[1].refetch();
      return resource.ref;
    }
  }
  const prepareResource = () => {
    if (error) throw error;
    const resolved = options.ssrLoadFrom !== "initial" && sharedConfig.context.async && "data" in sharedConfig.context.resources[id];
    if (!resolved && resourceContext) resourceContext.push(id);
    if (!resolved && read._loading) {
      const ctx = useContext(SuspenseContext);
      if (ctx) {
        ctx.resources.set(id, read);
        contexts.add(ctx);
      }
    }
    return resolved;
  };
  const read = () => {
    return prepareResource() ? sharedConfig.context.resources[id].data : value;
  };
  const loading = () => {
    prepareResource();
    return read._loading;
  };
  read._loading = false;
  read.error = void 0;
  read.state = "initialValue" in options ? "ready" : "unresolved";
  Object.defineProperties(read, {
    latest: {
      get() {
        return read();
      }
    },
    loading: {
      get() {
        return loading();
      }
    }
  });
  function load() {
    const ctx = sharedConfig.context;
    if (!ctx.async) return read._loading = !!(typeof source === "function" ? source() : source);
    if (ctx.resources && id in ctx.resources && "data" in ctx.resources[id]) {
      value = ctx.resources[id].data;
      return;
    }
    let lookup;
    try {
      resourceContext = [];
      lookup = typeof source === "function" ? source() : source;
      if (resourceContext.length) return;
    } finally {
      resourceContext = null;
    }
    if (!p) {
      if (lookup == null || lookup === false) return;
      p = fetcher(lookup, {
        value
      });
    }
    if (p != void 0 && typeof p === "object" && "then" in p) {
      read._loading = true;
      read.state = "pending";
      p = p.then((res) => {
        read._loading = false;
        read.state = "ready";
        ctx.resources[id].data = res;
        p = null;
        notifySuspense(contexts);
        return res;
      }).catch((err) => {
        read._loading = false;
        read.state = "errored";
        read.error = error = castError(err);
        p = null;
        notifySuspense(contexts);
        throw error;
      });
      if (ctx.serialize) ctx.serialize(id, p, options.deferStream);
      return p;
    }
    ctx.resources[id].data = p;
    if (ctx.serialize) ctx.serialize(id, p);
    p = null;
    return ctx.resources[id].data;
  }
  if (options.ssrLoadFrom !== "initial") load();
  const ref = [read, {
    refetch: load,
    mutate: (v3) => value = v3
  }];
  if (p) resource.ref = ref;
  return ref;
}
function suspenseComplete(c3) {
  for (const r of c3.resources.values()) {
    if (r._loading) return false;
  }
  return true;
}
function notifySuspense(contexts) {
  for (const c3 of contexts) {
    if (!suspenseComplete(c3)) {
      continue;
    }
    c3.completed();
    contexts.delete(c3);
  }
}

// src/tui.tsx
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { Transatlantic } from "opencode-transatlantic";

// node_modules/seroval/dist/esm/production/index.mjs
var L = ((i2) => (i2[i2.AggregateError = 1] = "AggregateError", i2[i2.ArrowFunction = 2] = "ArrowFunction", i2[i2.ErrorPrototypeStack = 4] = "ErrorPrototypeStack", i2[i2.ObjectAssign = 8] = "ObjectAssign", i2[i2.BigIntTypedArray = 16] = "BigIntTypedArray", i2[i2.RegExp = 32] = "RegExp", i2))(L || {});
var v = Symbol.asyncIterator;
var dr = Symbol.hasInstance;
var R = Symbol.isConcatSpreadable;
var C = Symbol.iterator;
var gr = Symbol.match;
var yr = Symbol.matchAll;
var Nr = Symbol.replace;
var br = Symbol.search;
var vr = Symbol.species;
var Cr = Symbol.split;
var Ar = Symbol.toPrimitive;
var P = Symbol.toStringTag;
var Er = Symbol.unscopables;
var Ce = { [v]: 0, [dr]: 1, [R]: 2, [C]: 3, [gr]: 4, [yr]: 5, [Nr]: 6, [br]: 7, [vr]: 8, [Cr]: 9, [Ar]: 10, [P]: 11, [Er]: 12 };
var o = void 0;
var st = { 2: true, 3: false, 1: o, 0: null, 4: -0, 5: Number.POSITIVE_INFINITY, 6: Number.NEGATIVE_INFINITY, 7: Number.NaN };
function c(e, r, t, n2, a, s2, i2, u2, l2, g2, S, d2) {
  return { t: e, i: r, s: t, c: n2, m: a, p: s2, e: i2, a: u2, f: l2, b: g2, o: S, l: d2 };
}
function B(e) {
  return c(2, o, e, o, o, o, o, o, o, o, o, o);
}
var J = B(2);
var Z = B(3);
var Ee = B(1);
var Ie = B(0);
var ut = B(4);
var lt = B(5);
var ct = B(6);
var ft = B(7);
var U = "__SEROVAL_REFS__";
var le = "$R";
var Re = `self.${le}`;
var j = /* @__PURE__ */ new Map();
typeof globalThis != "undefined" ? Object.defineProperty(globalThis, U, { value: j, configurable: true, writable: false, enumerable: false }) : typeof window != "undefined" ? Object.defineProperty(window, U, { value: j, configurable: true, writable: false, enumerable: false }) : typeof self != "undefined" ? Object.defineProperty(self, U, { value: j, configurable: true, writable: false, enumerable: false }) : typeof global != "undefined" && Object.defineProperty(global, U, { value: j, configurable: true, writable: false, enumerable: false });
var { toString: bs } = Object.prototype;
var ee = () => {
  let e = { p: 0, s: 0, f: 0 };
  return e.p = new Promise((r, t) => {
    e.s = r, e.f = t;
  }), e;
};
var In = (e, r) => {
  e.s(r), e.p.s = 1, e.p.v = r;
};
var Rn = (e, r) => {
  e.f(r), e.p.s = 2, e.p.v = r;
};
var bt = ee.toString();
var vt = In.toString();
var Ct = Rn.toString();
var xr = () => {
  let e = [], r = [], t = true, n2 = false, a = 0, s2 = (l2, g2, S) => {
    for (S = 0; S < a; S++) r[S] && r[S][g2](l2);
  }, i2 = (l2, g2, S, d2) => {
    for (g2 = 0, S = e.length; g2 < S; g2++) d2 = e[g2], !t && g2 === S - 1 ? l2[n2 ? "return" : "throw"](d2) : l2.next(d2);
  }, u2 = (l2, g2) => (t && (g2 = a++, r[g2] = l2), i2(l2), () => {
    t && (r[g2] = r[a], r[a--] = void 0);
  });
  return { __SEROVAL_STREAM__: true, on: (l2) => u2(l2), next: (l2) => {
    t && (e.push(l2), s2(l2, "next"));
  }, throw: (l2) => {
    t && (e.push(l2), s2(l2, "throw"), t = false, n2 = false, r.length = 0);
  }, return: (l2) => {
    t && (e.push(l2), s2(l2, "return"), t = false, n2 = true, r.length = 0);
  } };
};
var At = xr.toString();
var Tr = (e) => (r) => () => {
  let t = 0, n2 = { [e]: () => n2, next: () => {
    if (t > r.d) return { done: true, value: void 0 };
    let a = t++, s2 = r.v[a];
    if (a === r.t) throw s2;
    return { done: a === r.d, value: s2 };
  } };
  return n2;
};
var Et = Tr.toString();
var Or = (e, r) => (t) => () => {
  let n2 = 0, a = -1, s2 = false, i2 = [], u2 = [], l2 = (S = 0, d2 = u2.length) => {
    for (; S < d2; S++) u2[S].s({ done: true, value: void 0 });
  };
  t.on({ next: (S) => {
    let d2 = u2.shift();
    d2 && d2.s({ done: false, value: S }), i2.push(S);
  }, throw: (S) => {
    let d2 = u2.shift();
    d2 && d2.f(S), l2(), a = i2.length, s2 = true, i2.push(S);
  }, return: (S) => {
    let d2 = u2.shift();
    d2 && d2.s({ done: true, value: S }), l2(), a = i2.length, i2.push(S);
  } });
  let g2 = { [e]: () => g2, next: () => {
    if (a === -1) {
      let G2 = n2++;
      if (G2 >= i2.length) {
        let tt = r();
        return u2.push(tt), tt.p;
      }
      return { done: false, value: i2[G2] };
    }
    if (n2 > a) return { done: true, value: void 0 };
    let S = n2++, d2 = i2[S];
    if (S !== a) return { done: false, value: d2 };
    if (s2) throw d2;
    return { done: true, value: d2 };
  } };
  return g2;
};
var It = Or.toString();
var wr = (e) => {
  let r = atob(e), t = r.length, n2 = new Uint8Array(t);
  for (let a = 0; a < t; a++) n2[a] = r.charCodeAt(a);
  return n2.buffer;
};
var Rt = wr.toString();
var Pn = Tr(C);
function re() {
  return xr();
}
var xn = Or(v, ee);
var oe = ((t) => (t[t.Vanilla = 1] = "Vanilla", t[t.Cross = 2] = "Cross", t))(oe || {});
function ai(e) {
  return e;
}
var Ro = () => T;
var Po = Ro.toString();
var Ht = /=>/.test(Po);
var Xt = "hjkmoquxzABCDEFGHIJKLNPQRTUVWXYZ$_";
var Zt = Xt.length;
var Qt = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$_";
var $t = Qt.length;

// node_modules/seroval-plugins/dist/esm/production/web.mjs
var u = (e) => {
  let r = new AbortController(), a = r.abort.bind(r);
  return e.then(a, a), r;
};
function D(e) {
  e(this.reason);
}
function F(e) {
  this.addEventListener("abort", D.bind(this, e), { once: true });
}
function g(e) {
  return new Promise(F.bind(e));
}
var n = {};
var A = ai({ tag: "seroval-plugins/web/AbortControllerFactoryPlugin", test(e) {
  return e === n;
}, parse: { sync() {
  return n;
}, async async() {
  return await Promise.resolve(n);
}, stream() {
  return n;
} }, serialize() {
  return u.toString();
}, deserialize() {
  return u;
} });
var C2 = ai({ tag: "seroval-plugins/web/AbortSignal", extends: [A], test(e) {
  return typeof AbortSignal == "undefined" ? false : e instanceof AbortSignal;
}, parse: { sync(e, r) {
  return e.aborted ? { reason: r.parse(e.reason) } : {};
}, async async(e, r) {
  if (e.aborted) return { reason: await r.parse(e.reason) };
  let a = await g(e);
  return { reason: await r.parse(a) };
}, stream(e, r) {
  if (e.aborted) return { reason: r.parse(e.reason) };
  let a = g(e);
  return { factory: r.parse(n), controller: r.parse(a) };
} }, serialize(e, r) {
  return e.reason ? "AbortSignal.abort(" + r.serialize(e.reason) + ")" : e.controller && e.factory ? "(" + r.serialize(e.factory) + ")(" + r.serialize(e.controller) + ").signal" : "(new AbortController).signal";
}, deserialize(e, r) {
  return e.reason ? AbortSignal.abort(r.deserialize(e.reason)) : e.controller ? u(r.deserialize(e.controller)).signal : new AbortController().signal;
} });
var T2 = ai({ tag: "seroval-plugins/web/Blob", test(e) {
  return typeof Blob == "undefined" ? false : e instanceof Blob;
}, parse: { async async(e, r) {
  return { type: await r.parse(e.type), buffer: await r.parse(await e.arrayBuffer()) };
} }, serialize(e, r) {
  return "new Blob([" + r.serialize(e.buffer) + "],{type:" + r.serialize(e.type) + "})";
}, deserialize(e, r) {
  return new Blob([r.deserialize(e.buffer)], { type: r.deserialize(e.type) });
} });
function d(e) {
  return { detail: e.detail, bubbles: e.bubbles, cancelable: e.cancelable, composed: e.composed };
}
var U2 = ai({ tag: "seroval-plugins/web/CustomEvent", test(e) {
  return typeof CustomEvent == "undefined" ? false : e instanceof CustomEvent;
}, parse: { sync(e, r) {
  return { type: r.parse(e.type), options: r.parse(d(e)) };
}, async async(e, r) {
  return { type: await r.parse(e.type), options: await r.parse(d(e)) };
}, stream(e, r) {
  return { type: r.parse(e.type), options: r.parse(d(e)) };
} }, serialize(e, r) {
  return "new CustomEvent(" + r.serialize(e.type) + "," + r.serialize(e.options) + ")";
}, deserialize(e, r) {
  return new CustomEvent(r.deserialize(e.type), r.deserialize(e.options));
} });
var q = ai({ tag: "seroval-plugins/web/DOMException", test(e) {
  return typeof DOMException == "undefined" ? false : e instanceof DOMException;
}, parse: { sync(e, r) {
  return { name: r.parse(e.name), message: r.parse(e.message) };
}, async async(e, r) {
  return { name: await r.parse(e.name), message: await r.parse(e.message) };
}, stream(e, r) {
  return { name: r.parse(e.name), message: r.parse(e.message) };
} }, serialize(e, r) {
  return "new DOMException(" + r.serialize(e.message) + "," + r.serialize(e.name) + ")";
}, deserialize(e, r) {
  return new DOMException(r.deserialize(e.message), r.deserialize(e.name));
} });
function f(e) {
  return { bubbles: e.bubbles, cancelable: e.cancelable, composed: e.composed };
}
var Y = ai({ tag: "seroval-plugins/web/Event", test(e) {
  return typeof Event == "undefined" ? false : e instanceof Event;
}, parse: { sync(e, r) {
  return { type: r.parse(e.type), options: r.parse(f(e)) };
}, async async(e, r) {
  return { type: await r.parse(e.type), options: await r.parse(f(e)) };
}, stream(e, r) {
  return { type: r.parse(e.type), options: r.parse(f(e)) };
} }, serialize(e, r) {
  return "new Event(" + r.serialize(e.type) + "," + r.serialize(e.options) + ")";
}, deserialize(e, r) {
  return new Event(r.deserialize(e.type), r.deserialize(e.options));
} });
var G = ai({ tag: "seroval-plugins/web/File", test(e) {
  return typeof File == "undefined" ? false : e instanceof File;
}, parse: { async async(e, r) {
  return { name: await r.parse(e.name), options: await r.parse({ type: e.type, lastModified: e.lastModified }), buffer: await r.parse(await e.arrayBuffer()) };
} }, serialize(e, r) {
  return "new File([" + r.serialize(e.buffer) + "]," + r.serialize(e.name) + "," + r.serialize(e.options) + ")";
}, deserialize(e, r) {
  return new File([r.deserialize(e.buffer)], r.deserialize(e.name), r.deserialize(e.options));
} });
var m = G;
function y(e) {
  let r = [];
  return e.forEach((a, t) => {
    r.push([t, a]);
  }), r;
}
var s = {};
var v2 = (e, r = new FormData(), a = 0, t = e.length, p) => {
  for (; a < t; a++) p = e[a], r.append(p[0], p[1]);
  return r;
};
var J2 = ai({ tag: "seroval-plugins/web/FormDataFactory", test(e) {
  return e === s;
}, parse: { sync() {
  return s;
}, async async() {
  return await Promise.resolve(s);
}, stream() {
  return s;
} }, serialize() {
  return v2.toString();
}, deserialize() {
  return s;
} });
var K = ai({ tag: "seroval-plugins/web/FormData", extends: [m, J2], test(e) {
  return typeof FormData == "undefined" ? false : e instanceof FormData;
}, parse: { sync(e, r) {
  return { factory: r.parse(s), entries: r.parse(y(e)) };
}, async async(e, r) {
  return { factory: await r.parse(s), entries: await r.parse(y(e)) };
}, stream(e, r) {
  return { factory: r.parse(s), entries: r.parse(y(e)) };
} }, serialize(e, r) {
  return "(" + r.serialize(e.factory) + ")(" + r.serialize(e.entries) + ")";
}, deserialize(e, r) {
  return v2(r.deserialize(e.entries));
} });
function c2(e) {
  let r = [];
  return e.forEach((a, t) => {
    r.push([t, a]);
  }), r;
}
var X = ai({ tag: "seroval-plugins/web/Headers", test(e) {
  return typeof Headers == "undefined" ? false : e instanceof Headers;
}, parse: { sync(e, r) {
  return { value: r.parse(c2(e)) };
}, async async(e, r) {
  return { value: await r.parse(c2(e)) };
}, stream(e, r) {
  return { value: r.parse(c2(e)) };
} }, serialize(e, r) {
  return "new Headers(" + r.serialize(e.value) + ")";
}, deserialize(e, r) {
  return new Headers(r.deserialize(e.value));
} });
var i = X;
var $ = ai({ tag: "seroval-plugins/web/ImageData", test(e) {
  return typeof ImageData == "undefined" ? false : e instanceof ImageData;
}, parse: { sync(e, r) {
  return { data: r.parse(e.data), width: r.parse(e.width), height: r.parse(e.height), options: r.parse({ colorSpace: e.colorSpace }) };
}, async async(e, r) {
  return { data: await r.parse(e.data), width: await r.parse(e.width), height: await r.parse(e.height), options: await r.parse({ colorSpace: e.colorSpace }) };
}, stream(e, r) {
  return { data: r.parse(e.data), width: r.parse(e.width), height: r.parse(e.height), options: r.parse({ colorSpace: e.colorSpace }) };
} }, serialize(e, r) {
  return "new ImageData(" + r.serialize(e.data) + "," + r.serialize(e.width) + "," + r.serialize(e.height) + "," + r.serialize(e.options) + ")";
}, deserialize(e, r) {
  return new ImageData(r.deserialize(e.data), r.deserialize(e.width), r.deserialize(e.height), r.deserialize(e.options));
} });
var o2 = {};
var P2 = (e) => new ReadableStream({ start: (r) => {
  e.on({ next: (a) => {
    try {
      r.enqueue(a);
    } catch (t) {
    }
  }, throw: (a) => {
    r.error(a);
  }, return: () => {
    try {
      r.close();
    } catch (a) {
    }
  } });
} });
var ee2 = ai({ tag: "seroval-plugins/web/ReadableStreamFactory", test(e) {
  return e === o2;
}, parse: { sync() {
  return o2;
}, async async() {
  return await Promise.resolve(o2);
}, stream() {
  return o2;
} }, serialize() {
  return P2.toString();
}, deserialize() {
  return o2;
} });
async function N(e, r) {
  try {
    let a = await r.read();
    a.done ? (e.return(a.value), r.releaseLock()) : (e.next(a.value), await N(e, r));
  } catch (a) {
    e.throw(a);
  }
}
function re2(e) {
  e.cancel().catch(() => {
  }), e.releaseLock();
}
function w(e) {
  let r = re(), a = e.getReader(), t = re2.bind(null, a);
  return N(r, a).catch(t), [r, t];
}
var ae = ai({ tag: "seroval/plugins/web/ReadableStream", extends: [ee2], test(e) {
  return typeof ReadableStream == "undefined" ? false : e instanceof ReadableStream;
}, parse: { sync(e, r) {
  return { factory: r.parse(o2), stream: r.parse(re()) };
}, async async(e, r) {
  return { factory: await r.parse(o2), stream: await r.parse(w(e)[0]) };
}, stream(e, r) {
  let [a, t] = w(e);
  return r.addCleanup(t), { factory: r.parse(o2), stream: r.parse(a) };
} }, serialize(e, r) {
  return "(" + r.serialize(e.factory) + ")(" + r.serialize(e.stream) + ")";
}, deserialize(e, r) {
  let a = r.deserialize(e.stream);
  return P2(a);
} });
var l = ae;
function h(e, r) {
  return { body: r, cache: e.cache, credentials: e.credentials, headers: e.headers, integrity: e.integrity, keepalive: e.keepalive, method: e.method, mode: e.mode, redirect: e.redirect, referrer: e.referrer, referrerPolicy: e.referrerPolicy };
}
var se = ai({ tag: "seroval-plugins/web/Request", extends: [l, i], test(e) {
  return typeof Request == "undefined" ? false : e instanceof Request;
}, parse: { async async(e, r) {
  return { url: await r.parse(e.url), options: await r.parse(h(e, e.body && !e.bodyUsed ? await e.clone().arrayBuffer() : null)) };
}, stream(e, r) {
  return { url: r.parse(e.url), options: r.parse(h(e, e.body && !e.bodyUsed ? e.clone().body : null)) };
} }, serialize(e, r) {
  return "new Request(" + r.serialize(e.url) + "," + r.serialize(e.options) + ")";
}, deserialize(e, r) {
  return new Request(r.deserialize(e.url), r.deserialize(e.options));
} });
function E(e) {
  return { headers: e.headers, status: e.status, statusText: e.statusText };
}
var ie = ai({ tag: "seroval-plugins/web/Response", extends: [l, i], test(e) {
  return typeof Response == "undefined" ? false : e instanceof Response;
}, parse: { async async(e, r) {
  return { body: await r.parse(e.body && !e.bodyUsed ? await e.clone().arrayBuffer() : null), options: await r.parse(E(e)) };
}, stream(e, r) {
  return { body: r.parse(e.body && !e.bodyUsed ? e.clone().body : null), options: r.parse(E(e)) };
} }, serialize(e, r) {
  return "new Response(" + r.serialize(e.body) + "," + r.serialize(e.options) + ")";
}, deserialize(e, r) {
  return new Response(r.deserialize(e.body), r.deserialize(e.options));
} });
var ue = ai({ tag: "seroval-plugins/web/URL", test(e) {
  return typeof URL == "undefined" ? false : e instanceof URL;
}, parse: { sync(e, r) {
  return { value: r.parse(e.href) };
}, async async(e, r) {
  return { value: await r.parse(e.href) };
}, stream(e, r) {
  return { value: r.parse(e.href) };
} }, serialize(e, r) {
  return "new URL(" + r.serialize(e.value) + ")";
}, deserialize(e, r) {
  return new URL(r.deserialize(e.value));
} });
var me = ai({ tag: "seroval-plugins/web/URLSearchParams", test(e) {
  return typeof URLSearchParams == "undefined" ? false : e instanceof URLSearchParams;
}, parse: { sync(e, r) {
  return { value: r.parse(e.toString()) };
}, async async(e, r) {
  return { value: await r.parse(e.toString()) };
}, stream(e, r) {
  return { value: r.parse(e.toString()) };
} }, serialize(e, r) {
  return "new URLSearchParams(" + r.serialize(e.value) + ")";
}, deserialize(e, r) {
  return new URLSearchParams(r.deserialize(e.value));
} });

// node_modules/solid-js/web/dist/server.js
var booleans = [
  "allowfullscreen",
  "async",
  "alpha",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "disabled",
  "formnovalidate",
  "hidden",
  "indeterminate",
  "inert",
  "ismap",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "seamless",
  "selected",
  "adauctionheaders",
  "browsingtopics",
  "credentialless",
  "defaultchecked",
  "defaultmuted",
  "defaultselected",
  "defer",
  "disablepictureinpicture",
  "disableremoteplayback",
  "preservespitch",
  "shadowrootclonable",
  "shadowrootcustomelementregistry",
  "shadowrootdelegatesfocus",
  "shadowrootserializable",
  "sharedstoragewritable"
];
var Properties = /* @__PURE__ */ new Set([
  "className",
  "value",
  "readOnly",
  "noValidate",
  "formNoValidate",
  "isMap",
  "noModule",
  "playsInline",
  "adAuctionHeaders",
  "allowFullscreen",
  "browsingTopics",
  "defaultChecked",
  "defaultMuted",
  "defaultSelected",
  "disablePictureInPicture",
  "disableRemotePlayback",
  "preservesPitch",
  "shadowRootClonable",
  "shadowRootCustomElementRegistry",
  "shadowRootDelegatesFocus",
  "shadowRootSerializable",
  "sharedStorageWritable",
  ...booleans
]);
var SVGElements = /* @__PURE__ */ new Set([
  "altGlyph",
  "altGlyphDef",
  "altGlyphItem",
  "animate",
  "animateColor",
  "animateMotion",
  "animateTransform",
  "circle",
  "clipPath",
  "color-profile",
  "cursor",
  "defs",
  "desc",
  "ellipse",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "filter",
  "font",
  "font-face",
  "font-face-format",
  "font-face-name",
  "font-face-src",
  "font-face-uri",
  "foreignObject",
  "g",
  "glyph",
  "glyphRef",
  "hkern",
  "image",
  "line",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "missing-glyph",
  "mpath",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialGradient",
  "rect",
  "set",
  "stop",
  "svg",
  "switch",
  "symbol",
  "text",
  "textPath",
  "tref",
  "tspan",
  "use",
  "view",
  "vkern"
]);
var ES2017FLAG = L.AggregateError | L.BigIntTypedArray;
function notSup() {
  throw new Error("Client-only API called on the server side. Run client-only code in onMount, or conditionally run client-only component with <Show>.");
}

// node_modules/solid-js/h/dist/h.js
var $ELEMENT = /* @__PURE__ */ Symbol("hyper-element");
function createHyperScript(r) {
  function h3() {
    let args = [].slice.call(arguments), e, classes = [], multiExpression = false;
    while (Array.isArray(args[0])) args = args[0];
    if (args[0][$ELEMENT]) args.unshift(h3.Fragment);
    typeof args[0] === "string" && detectMultiExpression(args);
    const ret = () => {
      while (args.length) item(args.shift());
      if (e instanceof Element && classes.length) e.classList.add(...classes);
      return e;
    };
    ret[$ELEMENT] = true;
    return ret;
    function item(l2) {
      const type = typeof l2;
      if (l2 == null) ;
      else if ("string" === type) {
        if (!e) parseClass(l2);
        else e.appendChild(document.createTextNode(l2));
      } else if ("number" === type || "boolean" === type || "bigint" === type || "symbol" === type || l2 instanceof Date || l2 instanceof RegExp) {
        e.appendChild(document.createTextNode(l2.toString()));
      } else if (Array.isArray(l2)) {
        for (let i2 = 0; i2 < l2.length; i2++) item(l2[i2]);
      } else if (l2 instanceof Element) {
        r.insert(e, l2, multiExpression ? null : void 0);
      } else if ("object" === type) {
        let dynamic = false;
        const d2 = Object.getOwnPropertyDescriptors(l2);
        for (const k in d2) {
          if (k === "class" && classes.length !== 0) {
            const fixedClasses = classes.join(" "), value = typeof d2["class"].value === "function" ? () => fixedClasses + " " + d2["class"].value() : fixedClasses + " " + l2["class"];
            Object.defineProperty(l2, "class", {
              ...d2[k],
              value
            });
            classes = [];
          }
          if (k !== "ref" && k.slice(0, 2) !== "on" && typeof d2[k].value === "function") {
            r.dynamicProperty(l2, k);
            dynamic = true;
          } else if (d2[k].get) dynamic = true;
        }
        dynamic ? r.spread(e, l2, e instanceof SVGElement, !!args.length) : r.assign(e, l2, e instanceof SVGElement, !!args.length);
      } else if ("function" === type) {
        if (!e) {
          let props, next = args[0];
          if (next == null || typeof next === "object" && !Array.isArray(next) && !(next instanceof Element)) props = args.shift();
          props || (props = {});
          if (args.length) {
            props.children = args.length > 1 ? args : args[0];
          }
          const d2 = Object.getOwnPropertyDescriptors(props);
          for (const k in d2) {
            if (Array.isArray(d2[k].value)) {
              const list = d2[k].value;
              props[k] = () => {
                for (let i2 = 0; i2 < list.length; i2++) {
                  while (list[i2][$ELEMENT]) list[i2] = list[i2]();
                }
                return list;
              };
              r.dynamicProperty(props, k);
            } else if (typeof d2[k].value === "function" && !d2[k].value.length) r.dynamicProperty(props, k);
          }
          e = r.createComponent(l2, props);
          args = [];
        } else {
          while (l2[$ELEMENT]) l2 = l2();
          r.insert(e, l2, multiExpression ? null : void 0);
        }
      }
    }
    function parseClass(string) {
      const m2 = string.split(/([\.#]?[^\s#.]+)/);
      if (/^\.|#/.test(m2[1])) e = document.createElement("div");
      for (let i2 = 0; i2 < m2.length; i2++) {
        const v3 = m2[i2], s2 = v3.substring(1, v3.length);
        if (!v3) continue;
        if (!e) e = r.SVGElements.has(v3) ? document.createElementNS("http://www.w3.org/2000/svg", v3) : document.createElement(v3);
        else if (v3[0] === ".") classes.push(s2);
        else if (v3[0] === "#") e.setAttribute("id", s2);
      }
    }
    function detectMultiExpression(list) {
      for (let i2 = 1; i2 < list.length; i2++) {
        if (typeof list[i2] === "function") {
          multiExpression = true;
          return;
        } else if (Array.isArray(list[i2])) {
          detectMultiExpression(list[i2]);
        }
      }
    }
  }
  h3.Fragment = (props) => props.children;
  return h3;
}
var h2 = createHyperScript({
  spread: notSup,
  assign: notSup,
  insert: notSup,
  createComponent,
  dynamicProperty: notSup,
  SVGElements
});

// node_modules/solid-js/h/jsx-runtime/dist/jsx.js
function jsx(type, props) {
  return h2(type, props);
}

// src/tui.tsx
function currentSessionID() {
  try {
    const context = usePlugin();
    const r = context.ui.router.current();
    return r?.type === "session" && typeof r.sessionID === "string" ? r.sessionID : void 0;
  } catch {
    return void 0;
  }
}
function rpc() {
  return usePlugin().client.rpc(Transatlantic);
}
function AliasBadge(props) {
  const sid = () => props.sessionID ?? currentSessionID();
  const [alias] = createResource(sid, async (id) => {
    if (!id) return null;
    try {
      const r = await rpc().lookup({ sessionID: id });
      return typeof r?.alias === "string" ? r.alias : null;
    } catch {
      return null;
    }
  });
  return /* @__PURE__ */ jsx(Show, { when: alias(), children: /* @__PURE__ */ jsx("text", { children: [
    "ta:",
    alias()
  ] }) });
}
var tui_default = Plugin.define({
  id: "transatlantic.cli",
  setup(context) {
    const disposers = [];
    const keep = (d2) => {
      if (typeof d2 === "function") disposers.push(d2);
    };
    try {
      keep(
        context.ui.slot({
          append: "sidebar.footer",
          render: (props) => /* @__PURE__ */ jsx(AliasBadge, { sessionID: props?.sessionID })
        })
      );
    } catch (e) {
      console.error("[transatlantic] sidebar slot failed", e);
    }
    try {
      keep(
        context.ui.slot({
          append: "prompt.footer.status",
          render: (props) => /* @__PURE__ */ jsx(AliasBadge, { sessionID: props?.sessionID })
        })
      );
    } catch (e) {
      console.error("[transatlantic] status slot failed", e);
    }
    try {
      keep(
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "transatlantic.peers",
              title: "Transatlantic: peers",
              group: "Transatlantic",
              palette: true,
              slash: { name: "ta_peers" },
              run: async () => {
                const ta = context.client.rpc(Transatlantic);
                const { peers } = await ta.peers({});
                if (!peers?.length) {
                  context.ui.toast.show({ message: "no peers. claim a name: /ta_register <alias>" });
                  return;
                }
                const picked = await context.ui.dialog.select({
                  title: "peers",
                  options: peers.map((p) => ({
                    title: p.alias,
                    value: p.alias,
                    description: `${p.pwd} \xB7 ${p.session.slice(0, 6)}\u2026${p.session.slice(-3)}${p.alive ? "" : " \xB7 GONE"}`
                  }))
                });
                if (!picked) return;
                const peer = peers.find((p) => p.alias === picked);
                if (!peer) return;
                const me2 = context.ui.router.current();
                const mySession = me2?.type === "session" ? me2.sessionID : void 0;
                if (!peer.alive) {
                  context.ui.toast.show({
                    message: `owner of ${peer.alias} is gone. claim it: /ta_register ${peer.alias}`
                  });
                  return;
                }
                if (!mySession || peer.session !== mySession) {
                  context.ui.toast.show({ message: `${peer.alias} belongs to another live session.` });
                  return;
                }
                const yes = await context.ui.dialog.confirm({
                  title: `release ${peer.alias}?`,
                  message: "other sessions will no longer reach you by this name.",
                  label: { confirm: "release", cancel: "keep" }
                });
                if (!yes) return;
                const r = await ta.releaseAlias({ alias: peer.alias, sessionID: mySession });
                context.ui.toast.show({ message: r.message, variant: r.ok ? "success" : "error" });
              }
            },
            {
              id: "transatlantic.whoami",
              title: "Transatlantic: whoami",
              group: "Transatlantic",
              palette: true,
              slash: { name: "ta_whoami" },
              run: async () => {
                const me2 = context.ui.router.current();
                if (me2?.type !== "session") {
                  context.ui.toast.show({ message: "open a session first." });
                  return;
                }
                const ta = context.client.rpc(Transatlantic);
                const r = await ta.lookup({ sessionID: me2.sessionID });
                context.ui.toast.show({
                  message: r?.alias ? `alias: ${r.alias}` : "no alias. claim one: /ta_register <alias>"
                });
              }
            },
            {
              id: "transatlantic.register",
              title: "Transatlantic: register",
              group: "Transatlantic",
              palette: true,
              slash: { name: "ta_register", arguments: true },
              run: async (input) => {
                const me2 = context.ui.router.current();
                if (me2?.type !== "session") {
                  context.ui.toast.show({ message: "open a session first." });
                  return;
                }
                const typed = typeof input === "string" ? input.trim().toLowerCase() : "";
                const alias = typed || (await context.ui.dialog.prompt({ title: "alias", placeholder: "backend" }))?.trim().toLowerCase();
                if (!alias) return;
                const ta = context.client.rpc(Transatlantic);
                const r = await ta.claim({ alias, sessionID: me2.sessionID });
                context.ui.toast.show({ message: r.message, variant: r.ok ? "success" : "error" });
              }
            },
            {
              id: "transatlantic.unregister",
              title: "Transatlantic: unregister",
              group: "Transatlantic",
              palette: true,
              slash: { name: "ta_unregister" },
              run: async () => {
                const me2 = context.ui.router.current();
                if (me2?.type !== "session") {
                  context.ui.toast.show({ message: "open a session first." });
                  return;
                }
                const ta = context.client.rpc(Transatlantic);
                const mine = await ta.lookup({ sessionID: me2.sessionID });
                if (!mine?.alias) {
                  context.ui.toast.show({ message: "this session has no alias." });
                  return;
                }
                const yes = await context.ui.dialog.confirm({
                  title: `release ${mine.alias}?`,
                  message: "other sessions will no longer reach you by this name.",
                  label: { confirm: "release", cancel: "keep" }
                });
                if (!yes) return;
                const r = await ta.releaseAlias({ alias: mine.alias, sessionID: me2.sessionID });
                context.ui.toast.show({ message: r.message, variant: r.ok ? "success" : "error" });
              }
            }
          ]
        }))
      );
    } catch (e) {
      console.error("[transatlantic] keymap layer failed", e);
    }
    return () => disposers.forEach((d2) => {
      try {
        d2();
      } catch {
      }
    });
  }
});
export {
  tui_default as default
};

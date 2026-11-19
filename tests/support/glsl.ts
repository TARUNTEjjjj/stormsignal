/**
 * A small GLSL interpreter for the tests: enough of the language to run a fragment shader of the
 * globe (src/globe-shaders.ts) on the CPU, one fragment at a time, so a test can ask what colour a
 * point of the globe gets rather than search the source for a line. It reads declarations,
 * functions, local variables, assignments (swizzles too), if/else, return and discard, the usual
 * operators and the built-ins those shaders use. Preprocessor lines such as three.js's
 * `#include <colorspace_fragment>` are left out, so colours come back in linear light. fwidth has
 * no neighbouring fragments here: it returns `options.fwidth` (a small screen-space step).
 */
export type Value = number | boolean | number[];
/** A texture: the RGBA colour (0 to 1) at texture coordinates u, v. */
export type Sampler = (u: number, v: number) => number[];
type Input = Value | Sampler;

type Token = { kind: 'number' | 'name' | 'symbol'; text: string };
type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'call'; callee: string; args: Expr[] }
  | { kind: 'member'; object: Expr; field: string }
  | { kind: 'index'; object: Expr; index: Expr }
  | { kind: 'unary'; op: string; operand: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'ternary'; test: Expr; then: Expr; otherwise: Expr };
type Stmt =
  | { kind: 'declare'; type: string; names: { name: string; init: Expr | null }[] }
  | { kind: 'assign'; target: Expr; op: string; value: Expr }
  | { kind: 'expression'; expr: Expr }
  | { kind: 'return'; value: Expr | null }
  | { kind: 'discard' }
  | { kind: 'if'; test: Expr; then: Stmt; otherwise: Stmt | null }
  | { kind: 'block'; body: Stmt[] };
type Fn = { params: { type: string; name: string }[]; body: Stmt[] };

const TYPES = new Set([
  'void',
  'float',
  'int',
  'bool',
  'vec2',
  'vec3',
  'vec4',
  'mat2',
  'mat3',
  'mat4',
  'sampler2D',
]);
const QUALIFIERS = new Set([
  'uniform',
  'varying',
  'attribute',
  'in',
  'out',
  'inout',
  'const',
  'highp',
  'mediump',
  'lowp',
  'flat',
]);
const SIZES: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };

function tokenize(source: string): Token[] {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/^[ \t]*#[^\n]*$/gm, ' ');
  const pattern =
    /\s*(?:((?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?)|([A-Za-z_]\w*)|(&&|\|\||==|!=|<=|>=|\+=|-=|\*=|\/=|[-+*/(){},;=.<>!?:[\]]))/y;
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    if (!text.slice(at).trim()) break;
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) throw new Error(`GLSL: cannot read "${text.slice(at, at + 20)}"`);
    at = pattern.lastIndex;
    if (match[1]) tokens.push({ kind: 'number', text: match[1] });
    else if (match[2]) tokens.push({ kind: 'name', text: match[2] });
    else tokens.push({ kind: 'symbol', text: match[3] });
  }
  return tokens;
}

function parse(source: string) {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset]?.text;
  const next = () => {
    const token = tokens[at++];
    if (!token) throw new Error('GLSL: unexpected end');
    return token.text;
  };
  const expect = (text: string) => {
    const got = next();
    if (got !== text) throw new Error(`GLSL: expected "${text}", found "${got}"`);
  };
  const globals: { type: string; name: string; init: Expr | null }[] = [];
  const functions = new Map<string, Fn>();

  function expression(): Expr {
    const test = binary(0);
    if (peek() !== '?') return test;
    next();
    const then = expression();
    expect(':');
    return { kind: 'ternary', test, then, otherwise: expression() };
  }
  const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/']];
  function binary(level: number): Expr {
    if (level === LEVELS.length) return unary();
    let left = binary(level + 1);
    while (LEVELS[level].includes(peek() ?? '')) {
      const op = next();
      left = { kind: 'binary', op, left, right: binary(level + 1) };
    }
    return left;
  }
  function unary(): Expr {
    if (['-', '+', '!'].includes(peek() ?? ''))
      return { kind: 'unary', op: next(), operand: unary() };
    return postfix();
  }
  function postfix(): Expr {
    let expr = primary();
    for (;;) {
      if (peek() === '.') {
        next();
        expr = { kind: 'member', object: expr, field: next() };
      } else if (peek() === '[') {
        next();
        const index = expression();
        expect(']');
        expr = { kind: 'index', object: expr, index };
      } else return expr;
    }
  }
  function primary(): Expr {
    const token = tokens[at];
    if (!token) throw new Error('GLSL: unexpected end');
    if (token.kind === 'number') {
      next();
      return { kind: 'number', value: Number(token.text) };
    }
    if (token.text === '(') {
      next();
      const inner = expression();
      expect(')');
      return inner;
    }
    if (token.kind !== 'name') throw new Error(`GLSL: unexpected "${token.text}"`);
    next();
    if (token.text === 'true' || token.text === 'false')
      return { kind: 'number', value: token.text === 'true' ? 1 : 0 };
    if (peek() !== '(') return { kind: 'name', name: token.text };
    next();
    const args: Expr[] = [];
    while (peek() !== ')') {
      args.push(expression());
      if (peek() === ',') next();
    }
    expect(')');
    return { kind: 'call', callee: token.text, args };
  }
  function declaration(type: string): Stmt {
    const names: { name: string; init: Expr | null }[] = [];
    do {
      const name = next();
      names.push({ name, init: peek() === '=' ? (next(), expression()) : null });
    } while (peek() === ',' && next());
    expect(';');
    return { kind: 'declare', type, names };
  }
  function statement(): Stmt {
    const word = peek();
    if (word === '{') return { kind: 'block', body: block() };
    if (word === 'return') {
      next();
      const value = peek() === ';' ? null : expression();
      expect(';');
      return { kind: 'return', value };
    }
    if (word === 'discard') {
      next();
      expect(';');
      return { kind: 'discard' };
    }
    if (word === 'if') {
      next();
      expect('(');
      const test = expression();
      expect(')');
      const then = statement();
      const otherwise = peek() === 'else' ? (next(), statement()) : null;
      return { kind: 'if', test, then, otherwise };
    }
    while (QUALIFIERS.has(peek() ?? '')) next();
    if (TYPES.has(peek() ?? '') && tokens[at + 1]?.kind === 'name') return declaration(next());
    const target = expression();
    if (['=', '+=', '-=', '*=', '/='].includes(peek() ?? '')) {
      const op = next();
      const value = expression();
      expect(';');
      return { kind: 'assign', target, op, value };
    }
    expect(';');
    return { kind: 'expression', expr: target };
  }
  function block(): Stmt[] {
    expect('{');
    const body: Stmt[] = [];
    while (peek() !== '}') body.push(statement());
    expect('}');
    return body;
  }

  while (at < tokens.length) {
    if (peek() === 'precision') {
      while (next() !== ';');
      continue;
    }
    while (QUALIFIERS.has(peek() ?? '')) next();
    const type = next();
    const name = next();
    if (peek() === '(') {
      next();
      const params: { type: string; name: string }[] = [];
      while (peek() !== ')') {
        while (QUALIFIERS.has(peek() ?? '')) next();
        const paramType = next();
        if (paramType === 'void' && peek() === ')') break;
        params.push({ type: paramType, name: next() });
        if (peek() === ',') next();
      }
      expect(')');
      functions.set(name, { params, body: block() });
      continue;
    }
    at -= 1;
    const declared = declaration(type);
    if (declared.kind === 'declare')
      for (const entry of declared.names) globals.push({ type, ...entry });
  }
  return { globals, functions };
}

class Returned {
  constructor(readonly value: Value | undefined) {}
}
class Discarded {}

const copy = (value: Value): Value => (Array.isArray(value) ? [...value] : value);
const zero = (type: string): Value =>
  type in SIZES ? new Array(SIZES[type]).fill(0) : type === 'bool' ? false : 0;
const num = (value: Value) => {
  if (Array.isArray(value)) throw new Error('GLSL: expected a scalar');
  return Number(value);
};
const vec = (value: Value) => {
  if (!Array.isArray(value)) throw new Error('GLSL: expected a vector');
  return value;
};
/** A function applied per component; scalars meet every component. */
const each =
  (fn: (...values: number[]) => number) =>
  (...args: Value[]): Value => {
    const size = Math.max(...args.map((arg) => (Array.isArray(arg) ? arg.length : 1)));
    if (args.every((arg) => !Array.isArray(arg))) return fn(...args.map(num));
    return Array.from({ length: size }, (_, index) =>
      fn(...args.map((arg) => (Array.isArray(arg) ? arg[index] : num(arg)))),
    );
  };
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const dot = (a: Value, b: Value) =>
  vec(a).reduce((total, value, index) => total + value * vec(b)[index], 0);
const SWIZZLE: Record<string, number> = {
  x: 0,
  y: 1,
  z: 2,
  w: 3,
  r: 0,
  g: 1,
  b: 2,
  a: 3,
  s: 0,
  t: 1,
  p: 2,
  q: 3,
};
const swizzle = (field: string) =>
  [...field].map((letter) => {
    if (!(letter in SWIZZLE)) throw new Error(`GLSL: no component "${letter}"`);
    return SWIZZLE[letter];
  });

class Scope {
  private readonly values = new Map<string, Input>();
  constructor(private readonly parent: Scope | null) {}
  define(name: string, value: Input) {
    this.values.set(name, typeof value === 'function' ? value : copy(value));
  }
  get(name: string): Input {
    if (this.values.has(name)) return this.values.get(name)!;
    if (this.parent) return this.parent.get(name);
    throw new Error(`GLSL: "${name}" is not declared`);
  }
  set(name: string, value: Value) {
    if (this.values.has(name)) this.values.set(name, copy(value));
    else if (this.parent) this.parent.set(name, value);
    else throw new Error(`GLSL: "${name}" is not declared`);
  }
}

/** A compiled shader: `run` executes `main` for one fragment with these uniforms and varyings. */
export function glsl(source: string, { fwidth = 0.01 }: { fwidth?: number } = {}) {
  const { globals, functions } = parse(source);
  const builtins: Record<string, (...args: Value[]) => Value> = {
    abs: each(Math.abs),
    sign: each(Math.sign),
    floor: each(Math.floor),
    ceil: each(Math.ceil),
    fract: each((x) => x - Math.floor(x)),
    sqrt: each(Math.sqrt),
    inversesqrt: each((x) => 1 / Math.sqrt(x)),
    exp: each(Math.exp),
    exp2: each((x) => 2 ** x),
    log: each(Math.log),
    log2: each(Math.log2),
    sin: each(Math.sin),
    cos: each(Math.cos),
    tan: each(Math.tan),
    asin: each(Math.asin),
    acos: each(Math.acos),
    atan: (...args) => (args.length === 2 ? each(Math.atan2)(...args) : each(Math.atan)(...args)),
    pow: each(Math.pow),
    mod: each((x, y) => x - y * Math.floor(x / y)),
    min: each(Math.min),
    max: each(Math.max),
    clamp: each((x, low, high) => Math.min(high, Math.max(low, x))),
    mix: each((a, b, t) => a * (1 - t) + b * t),
    step: each((edge, x) => (x < edge ? 0 : 1)),
    smoothstep: each(smoothstep),
    fwidth: each(() => fwidth),
    dFdx: each(() => 0),
    dFdy: each(() => 0),
    dot: (a, b) => dot(a, b),
    length: (a) => (Array.isArray(a) ? Math.hypot(...a) : Math.abs(num(a))),
    distance: (a, b) => Math.hypot(...vec(each((x, y) => x - y)(a, b))),
    normalize: (a) => {
      const length = Math.hypot(...vec(a));
      return vec(a).map((value) => value / length);
    },
    cross: (a, b) => {
      const [x0, y0, z0] = vec(a);
      const [x1, y1, z1] = vec(b);
      return [y0 * z1 - z0 * y1, z0 * x1 - x0 * z1, x0 * y1 - y0 * x1];
    },
    float: (a) => num(a),
    int: (a) => Math.trunc(num(a)),
    bool: (a) => !!num(a),
  };
  for (const type of Object.keys(SIZES))
    builtins[type] = (...args) => {
      const flat = args.flatMap((arg) => (Array.isArray(arg) ? arg : [num(arg)]));
      return flat.length === 1 ? new Array(SIZES[type]).fill(flat[0]) : flat.slice(0, SIZES[type]);
    };

  const value = (input: Input): Value => {
    if (typeof input === 'function') throw new Error('GLSL: a sampler is not a value');
    return input;
  };
  function evaluate(expr: Expr, scope: Scope): Value {
    switch (expr.kind) {
      case 'number':
        return expr.value;
      case 'name':
        return value(scope.get(expr.name));
      case 'member': {
        const indices = swizzle(expr.field);
        const object = vec(evaluate(expr.object, scope));
        return indices.length === 1 ? object[indices[0]] : indices.map((index) => object[index]);
      }
      case 'index':
        return vec(evaluate(expr.object, scope))[num(evaluate(expr.index, scope))];
      case 'unary': {
        const operand = evaluate(expr.operand, scope);
        if (expr.op === '!') return !operand;
        return expr.op === '-' ? each((x) => -x)(operand) : operand;
      }
      case 'ternary':
        return evaluate(expr.test, scope)
          ? evaluate(expr.then, scope)
          : evaluate(expr.otherwise, scope);
      case 'binary': {
        if (expr.op === '&&') return !!evaluate(expr.left, scope) && !!evaluate(expr.right, scope);
        if (expr.op === '||') return !!evaluate(expr.left, scope) || !!evaluate(expr.right, scope);
        const left = evaluate(expr.left, scope);
        const right = evaluate(expr.right, scope);
        return operate(expr.op, left, right);
      }
      case 'call':
        return call(expr.callee, expr.args, scope);
    }
  }
  function operate(op: string, left: Value, right: Value): Value {
    switch (op) {
      case '+':
        return each((a, b) => a + b)(left, right);
      case '-':
        return each((a, b) => a - b)(left, right);
      case '*':
        return each((a, b) => a * b)(left, right);
      case '/':
        return each((a, b) => a / b)(left, right);
      case '<':
        return num(left) < num(right);
      case '>':
        return num(left) > num(right);
      case '<=':
        return num(left) <= num(right);
      case '>=':
        return num(left) >= num(right);
      case '==':
        return JSON.stringify(left) === JSON.stringify(right);
      case '!=':
        return JSON.stringify(left) !== JSON.stringify(right);
      default:
        throw new Error(`GLSL: no operator ${op}`);
    }
  }
  function call(callee: string, args: Expr[], scope: Scope): Value {
    if (callee === 'texture2D' || callee === 'texture') {
      const sampler = scope.get((args[0] as { name: string }).name);
      if (typeof sampler !== 'function') throw new Error('GLSL: texture2D needs a sampler');
      const [u, v] = vec(evaluate(args[1], scope));
      return [...sampler(u, v)];
    }
    const fn = functions.get(callee);
    const values = args.map((arg) => evaluate(arg, scope));
    if (!fn) {
      if (!(callee in builtins)) throw new Error(`GLSL: no function ${callee}`);
      return builtins[callee](...values);
    }
    const local = new Scope(globalScope);
    fn.params.forEach(({ name }, index) => local.define(name, values[index]));
    try {
      execute(fn.body, local);
    } catch (signal) {
      if (signal instanceof Returned) return signal.value ?? 0;
      throw signal;
    }
    return 0;
  }
  function assign(target: Expr, value: Value, scope: Scope) {
    if (target.kind === 'name') return scope.set(target.name, value);
    if (target.kind === 'member' && target.object.kind === 'name') {
      const whole = [...vec(evaluate(target.object, scope))];
      const indices = swizzle(target.field);
      const parts = Array.isArray(value) ? value : [value];
      indices.forEach((index, at) => (whole[index] = num(parts[at])));
      return scope.set(target.object.name, whole);
    }
    throw new Error('GLSL: cannot assign to this');
  }
  function execute(body: Stmt[], scope: Scope) {
    for (const statement of body) {
      switch (statement.kind) {
        case 'declare':
          for (const { name, init } of statement.names)
            scope.define(name, init ? evaluate(init, scope) : zero(statement.type));
          break;
        case 'assign': {
          let result = evaluate(statement.value, scope);
          if (statement.op !== '=')
            result = operate(statement.op[0], evaluate(statement.target, scope), result);
          assign(statement.target, result, scope);
          break;
        }
        case 'expression':
          evaluate(statement.expr, scope);
          break;
        case 'return':
          throw new Returned(statement.value ? evaluate(statement.value, scope) : undefined);
        case 'discard':
          throw new Discarded();
        case 'if':
          if (evaluate(statement.test, scope)) execute([statement.then], new Scope(scope));
          else if (statement.otherwise) execute([statement.otherwise], new Scope(scope));
          break;
        case 'block':
          execute(statement.body, new Scope(scope));
          break;
      }
    }
  }

  let globalScope = new Scope(null);
  return {
    /** Runs main() with these uniforms and varyings: gl_FragColor, or null for a discard. */
    run(inputs: Record<string, Input>): number[] | null {
      globalScope = new Scope(null);
      globalScope.define('gl_FragColor', [0, 0, 0, 0]);
      for (const { type, name, init } of globals) {
        const given = inputs[name];
        if (given !== undefined) globalScope.define(name, given);
        else if (init) globalScope.define(name, evaluate(init, globalScope));
        else if (type !== 'sampler2D') globalScope.define(name, zero(type));
      }
      const main = functions.get('main');
      if (!main) throw new Error('GLSL: no main()');
      try {
        execute(main.body, new Scope(globalScope));
      } catch (signal) {
        if (signal instanceof Discarded) return null;
        if (!(signal instanceof Returned)) throw signal;
      }
      return vec(value(globalScope.get('gl_FragColor')));
    },
  };
}

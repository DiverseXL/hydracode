/**
 * TypeScript extraction using the compiler API (ts.createProgram — no
 * ts-morph or other wrappers, to keep dependencies minimal).
 *
 * Pure extraction: returns in-memory data shaped like graph/schema.ts. No
 * HydraDB calls happen here; call resolution happens in the writer's
 * graph-linking step, not here.
 *
 * KNOWN LIMITATIONS (deliberate for MVP):
 * - Anonymous functions with no assignable name (inline callbacks, IIFEs,
 *   object-literal method shorthand) are skipped — no synthesized names.
 * - `extends` is captured only for a plain Identifier parent (`class Foo
 *   extends Bar`); complex expressions (mixins, `extends getBase()`) are
 *   skipped.
 * - Tests: only leaf cases with a string-literal name (`it`/`test`/`it.only`
 *   /`it.skip`/`test.only`/`test.skip`). Nested describe context is NOT
 *   captured in the test name.
 * - Call edges: captured via a heuristic, single-file, no-type-checker AST
 *   pass:
 *   - Plain identifier calls (`foo()`), kind "plain".
 *   - `this.foo()` calls, kind "this".
 *   - `obj.method()` cross-object calls, kind "member", with in-file
 *     calleeClassHint extracted syntactically when `obj` is an Identifier
 *     declared via `new ClassName(...)` or with an explicit type annotation
 *     `(param: ClassName)`.
 *   - Calls on common global/builtin namespaces (Math, JSON, console, Object,
 *     Array, Promise, process, Buffer) are skipped to avoid noise.
 *   - Calls through untyped parameters, destructured objects, dynamically
 *     returned instances, and complex expressions (e.g. `getObj().method()`,
 *     `a.b.c()`) have no hint and will rely on name matching or stay unresolved.
 *   - Computed calls (`obj[key]()`) are skipped.
 * - Re-exports (`export ... from`) and dynamic `import()` are not tracked.
 * - .gitignore is not parsed yet; extraction uses hardcoded excludes
 *   (node_modules, dist, .git, .hydracode).
 * - One compiler program is created per file (simple, correct; could be
 *   batched into a single program for large repos later).
 */

import path from "node:path";
import fg from "fast-glob";
import ora from "ora";
import ts from "typescript";
import type {
  ClassNode,
  FileNode,
  FunctionNode,
  Language,
  TestNode,
} from "../graph/schema.js";

export interface ExtractedImport {
  modulePath: string;
  isExternal: boolean;
  /** For relative imports: how the module path was resolved. */
  resolvedBy?: "compiler" | "fallback";
}

export interface ExtractedCall {
  callerId: string;
  calleeName: string;
  /**
   * "plain" for plain foo() calls;
   * "this" for this.foo() calls;
   * "member" for obj.method() calls.
   */
  kind?: "plain" | "this" | "member";
  /** In-file syntactic class name hint (e.g. "HydraClient" from `const c = new HydraClient()` or `(c: HydraClient)`). */
  calleeClassHint?: string;
}

export interface ExtractedMethodOf {
  functionId: string;
  classId: string;
}

export interface ExtractedExtends {
  classId: string;
  parentClassName: string;
}

export interface ExtractedFile {
  file: FileNode;
  functions: FunctionNode[];
  classes: ClassNode[];
  tests: TestNode[];
  imports: ExtractedImport[];
  /** Unresolved callee name; resolution happens in the writer, not here. */
  calls: ExtractedCall[];
  methodOf: ExtractedMethodOf[];
  /** Unresolved parent name; same reasoning as calls. */
  extends: ExtractedExtends[];
}

const DEFAULT_PATTERNS = ["**/*.{ts,tsx,js,jsx}"];

/** Hardcoded excludes — .gitignore parsing is not implemented yet. */
const EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/.hydracode/**",
];

export async function extractFile(
  filePath: string,
  repoRoot: string,
): Promise<ExtractedFile> {
  const filePathAbs = path.resolve(repoRoot, filePath);
  const relPath = repoRelative(repoRoot, filePathAbs);

  const program = ts.createProgram([filePathAbs], {
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });

  // Force the binder to run so the AST has parent/sourceFile links (needed
  // by node.parent lookups and getStart()). Without this, files returned by
  // getSourceFile are parsed but not bound, and getStart() crashes.
  program.getTypeChecker();

  const sourceFile = program.getSourceFile(filePathAbs);
  if (!sourceFile) {
    throw new Error(`extractFile: could not load source file ${filePathAbs}`);
  }

  const functions: FunctionNode[] = [];
  const classes: ClassNode[] = [];
  const tests: TestNode[] = [];
  const imports: ExtractedImport[] = [];
  const calls: ExtractedCall[] = [];
  const methodOf: ExtractedMethodOf[] = [];
  const extendsList: ExtractedExtends[] = [];

  // Stack of enclosing function ids; innermost is the caller of any call.
  const funcStack: string[] = [];

  const lineAt = (pos: number): number =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const isExported = (node: ts.HasModifiers): boolean =>
    ts.getModifiers(node)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;

  const isAsync = (node: ts.HasModifiers): boolean =>
    ts.getModifiers(node)?.some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
    ) ?? false;

  const classIdOf = (className: string): string => `${relPath}#${className}`;

  const pushFunction = (f: {
    name: string;
    qualifiedName: string;
    exported: boolean;
    async: boolean;
    startLine: number;
    endLine: number;
  }): string => {
    const id = `${relPath}#${f.qualifiedName}#${f.startLine}`;
    functions.push({ id, ...f });
    return id;
  };

  const findEnclosingClass = (
    node: ts.Node,
  ): ts.ClassDeclaration | undefined => {
    let cur = node.parent;
    while (cur) {
      if (ts.isClassDeclaration(cur)) return cur;
      cur = cur.parent;
    }
    return undefined;
  };

  const methodName = (method: ts.MethodDeclaration): string | undefined => {
    const name = method.name;
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
    return undefined; // computed method names: skip
  };

  const visit = (node: ts.Node): void => {
    let frameId: string | undefined;

    if (ts.isFunctionDeclaration(node) && node.name) {
      frameId = pushFunction({
        name: node.name.text,
        qualifiedName: node.name.text,
        exported: isExported(node),
        async: isAsync(node),
        startLine: lineAt(node.getStart()),
        endLine: lineAt(node.getEnd()),
      });
    } else if (ts.isMethodDeclaration(node)) {
      const classDecl = findEnclosingClass(node);
      const name = classDecl?.name ? methodName(node) : undefined;
      if (classDecl?.name && name) {
        frameId = pushFunction({
          name,
          qualifiedName: `${classDecl.name.text}.${name}`,
          exported: isExported(node),
          async: isAsync(node),
          startLine: lineAt(node.getStart()),
          endLine: lineAt(node.getEnd()),
        });
        methodOf.push({
          functionId: frameId,
          classId: classIdOf(classDecl.name.text),
        });
      }
    } else if (ts.isVariableDeclaration(node)) {
      // const foo = function () {} | const foo = () => {}
      const init = node.initializer;
      if (
        node.name &&
        ts.isIdentifier(node.name) &&
        init &&
        (ts.isFunctionExpression(init) || ts.isArrowFunction(init))
      ) {
        const statement = node.parent.parent;
        frameId = pushFunction({
          name: node.name.text,
          qualifiedName: node.name.text,
          exported:
            ts.isVariableStatement(statement) && isExported(statement),
          async: isAsync(init),
          startLine: lineAt(node.getStart()),
          endLine: lineAt(init.getEnd()),
        });
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const cls: ClassNode = {
        id: classIdOf(node.name.text),
        name: node.name.text,
        exported: isExported(node),
        startLine: lineAt(node.getStart()),
        endLine: lineAt(node.getEnd()),
      };
      classes.push(cls);
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const heritageType of clause.types) {
          // Only plain `extends Bar`; mixins / `extends getBase()` skipped.
          if (ts.isIdentifier(heritageType.expression)) {
            extendsList.push({
              classId: cls.id,
              parentClassName: heritageType.expression.text,
            });
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const testName = testCaseName(node);
      if (testName !== undefined) {
        tests.push({
          id: `${relPath}#${testName}#${lineAt(node.getStart())}`,
          name: testName,
          filePath: relPath,
          startLine: lineAt(node.getStart()),
        });
      }
      const callee = callCallee(node);
      if (callee && funcStack.length > 0) {
        calls.push({
          callerId: funcStack[funcStack.length - 1],
          calleeName: callee.name,
          kind: callee.kind,
          calleeClassHint: callee.calleeClassHint,
        });
      }
    }

    if (frameId !== undefined) funcStack.push(frameId);
    ts.forEachChild(node, visit);
    if (frameId !== undefined) funcStack.pop();
  };

  visit(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const moduleSpecifier = specifier.text;
    if (isExternalSpecifier(moduleSpecifier)) {
      imports.push({ modulePath: moduleSpecifier, isExternal: true });
    } else {
      const resolved = resolveRelativeImport(
        program,
        repoRoot,
        filePathAbs,
        moduleSpecifier,
      );
      imports.push({
        modulePath: resolved.modulePath,
        isExternal: false,
        resolvedBy: resolved.resolvedBy,
      });
    }
  }

  return {
    file: {
      path: relPath,
      language: detectLanguage(filePathAbs),
      lastIndexedAt: new Date().toISOString(),
    },
    functions,
    classes,
    tests,
    imports,
    calls,
    methodOf,
    extends: extendsList,
  };
}

export async function extractRepo(
  repoRoot: string,
  patterns?: string[],
  opts?: { quiet?: boolean },
): Promise<ExtractedFile[]> {
  const pats = patterns && patterns.length > 0 ? patterns : DEFAULT_PATTERNS;
  const files = (
    await fg(pats, {
      cwd: repoRoot,
      ignore: EXCLUDE_PATTERNS,
      absolute: true,
      onlyFiles: true,
      suppressErrors: true,
    })
  ).filter((f) => !f.endsWith(".d.ts"));

  const total = files.length;
  const spinner = opts?.quiet
    ? undefined
    : ora(`Indexing 0/${total} files`).start();

  const results: ExtractedFile[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      results.push(await extractFile(files[i], repoRoot));
      if (spinner) {
        spinner.text = `Indexing ${i + 1}/${total}: ${repoRelative(repoRoot, files[i])}`;
      }
    }
  } finally {
    spinner?.stop();
  }
  return results;
}

/* ------------------------------ helpers ----------------------------- */

/** Repo-relative path with forward slashes, even on Windows. */
function repoRelative(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";
}

/** External if the specifier doesn't start with "." or "/". */
function isExternalSpecifier(specifier: string): boolean {
  return !/^(\.|\/)/.test(specifier);
}

/**
 * Resolve a relative import to a repo-relative module path.
 *
 * Prefers the compiler's own resolution (ts.resolveModuleName), which
 * handles extensionless specifiers, .tsx, index files, etc. If the compiler
 * can't resolve it or resolves it outside the repo (e.g. missing file),
 * fall back to plain path.resolve + path.relative math — which may point at
 * a file that doesn't exist, but keeps the graph's module paths stable.
 * The caller records which path was taken via `resolvedBy`.
 */
function resolveRelativeImport(
  program: ts.Program,
  repoRoot: string,
  filePath: string,
  specifier: string,
): { modulePath: string; resolvedBy: "compiler" | "fallback" } {
  const resolved = ts.resolveModuleName(
    specifier,
    filePath,
    program.getCompilerOptions(),
    ts.sys,
  );
  const target = resolved.resolvedModule?.resolvedFileName;
  if (target) {
    const rel = path.relative(repoRoot, target);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return {
        modulePath: rel.split(path.sep).join("/"),
        resolvedBy: "compiler",
      };
    }
  }
  const fallback = path.relative(
    repoRoot,
    path.resolve(path.dirname(filePath), specifier),
  );
  return {
    modulePath: fallback.split(path.sep).join("/"),
    resolvedBy: "fallback",
  };
}

/**
 * Test callee detection: `it`, `test`, `it.only`, `it.skip`, `test.only`,
 * `test.skip` — with a string-literal first argument (the test name).
 * describe blocks are NOT treated as tests; nested describe context is not
 * captured in the name (known limitation).
 */
function testCaseName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  let isTestCallee = false;
  if (ts.isIdentifier(callee)) {
    isTestCallee = callee.text === "it" || callee.text === "test";
  } else if (ts.isPropertyAccessExpression(callee)) {
    const base = callee.expression;
    const prop = callee.name;
    isTestCallee =
      ts.isIdentifier(base) &&
      (base.text === "it" || base.text === "test") &&
      ts.isIdentifier(prop) &&
      (prop.text === "only" || prop.text === "skip");
  }
  if (!isTestCallee) return undefined;
  const firstArg = call.arguments[0];
  return firstArg !== undefined && ts.isStringLiteral(firstArg)
    ? firstArg.text
    : undefined;
}

const GLOBAL_BUILTIN_NAMESPACES = new Set([
  "Math",
  "JSON",
  "console",
  "Object",
  "Array",
  "Promise",
  "process",
  "Buffer",
]);

function extractTypeNameFromTypeNode(typeNode: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(typeNode)) {
    if (ts.isIdentifier(typeNode.typeName)) {
      return typeNode.typeName.text;
    }
    if (ts.isQualifiedName(typeNode.typeName)) {
      return typeNode.typeName.right.text;
    }
  } else if (ts.isUnionTypeNode(typeNode)) {
    for (const t of typeNode.types) {
      const name = extractTypeNameFromTypeNode(t);
      if (name && name !== "undefined" && name !== "null") {
        return name;
      }
    }
  }
  return undefined;
}

function extractClassNameFromExpression(expr: ts.Expression): string | undefined {
  let cur: ts.Expression = expr;
  while (true) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isAsExpression(cur)) {
      const typeName = extractTypeNameFromTypeNode(cur.type);
      if (typeName) return typeName;
      cur = cur.expression;
    } else if (ts.isTypeAssertionExpression(cur)) {
      const typeName = extractTypeNameFromTypeNode(cur.type);
      if (typeName) return typeName;
      cur = cur.expression;
    } else if (ts.isAwaitExpression(cur)) {
      cur = cur.expression;
    } else {
      break;
    }
  }

  if (ts.isNewExpression(cur)) {
    const callee = cur.expression;
    if (ts.isIdentifier(callee)) {
      return callee.text;
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      return callee.name.text;
    }
  }
  return undefined;
}

function extractClassHintFromDeclaration(decl: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(decl)) {
    if (decl.initializer) {
      const fromInit = extractClassNameFromExpression(decl.initializer);
      if (fromInit) return fromInit;
    }
    if (decl.type) {
      const fromType = extractTypeNameFromTypeNode(decl.type);
      if (fromType) return fromType;
    }
  } else if (ts.isParameter(decl)) {
    if (decl.type) {
      const fromType = extractTypeNameFromTypeNode(decl.type);
      if (fromType) return fromType;
    }
    if (decl.initializer) {
      const fromInit = extractClassNameFromExpression(decl.initializer);
      if (fromInit) return fromInit;
    }
  } else if (ts.isPropertyDeclaration(decl)) {
    if (decl.type) {
      const fromType = extractTypeNameFromTypeNode(decl.type);
      if (fromType) return fromType;
    }
    if (decl.initializer) {
      const fromInit = extractClassNameFromExpression(decl.initializer);
      if (fromInit) return fromInit;
    }
  }
  return undefined;
}

/**
 * Syntactic in-file class hint resolution: looks up the declaration of `obj`
 * within the enclosing AST scopes (parameters, local variable declarations,
 * class properties) in the same file. Returns the plain text name of the
 * constructed class (`new ClassName()`) or annotated type (`(x: ClassName)`),
 * or undefined if not determinable. No type checker or cross-file lookup.
 */
function findClassHint(obj: ts.Identifier): string | undefined {
  const targetName = obj.text;
  let cur: ts.Node | undefined = obj.parent;

  while (cur) {
    // 1. Function / Method / Arrow / Constructor parameters
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur)
    ) {
      for (const param of cur.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === targetName) {
          const hint = extractClassHintFromDeclaration(param);
          if (hint) return hint;
        }
      }
    }

    // 2. Block / SourceFile statements (variable statements)
    if (
      ts.isBlock(cur) ||
      ts.isSourceFile(cur) ||
      ts.isCaseClause(cur) ||
      ts.isDefaultClause(cur)
    ) {
      for (const stmt of cur.statements) {
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === targetName) {
              const hint = extractClassHintFromDeclaration(decl);
              if (hint) return hint;
            }
          }
        }
      }
    }

    // 3. For statements
    if (
      ts.isForStatement(cur) ||
      ts.isForInStatement(cur) ||
      ts.isForOfStatement(cur)
    ) {
      if (cur.initializer && ts.isVariableDeclarationList(cur.initializer)) {
        for (const decl of cur.initializer.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === targetName) {
            const hint = extractClassHintFromDeclaration(decl);
            if (hint) return hint;
          }
        }
      }
    }

    // 4. Class declarations / expressions
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) {
      for (const member of cur.members) {
        if (
          ts.isPropertyDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === targetName
        ) {
          const hint = extractClassHintFromDeclaration(member);
          if (hint) return hint;
        }
      }
    }

    cur = cur.parent;
  }

  return undefined;
}

/**
 * Call callee detection.
 *
 * Captures:
 * - plain-Identifier callees (`foo()`), kind "plain";
 * - `this.foo()`, kind "this" (writer resolves against the caller's class);
 * - `obj.method()` calls, kind "member", with syntactic in-file calleeClassHint
 *   when obj is an Identifier (`new ClassName(...)` or `(x: ClassName)`).
 *   Common global/builtin namespaces (Math, JSON, console, Object, Array,
 *   Promise, process, Buffer) are skipped.
 * Computed calls (`obj[key]()`) and complex expressions without hints are
 * handled as documented.
 */
function callCallee(
  call: ts.CallExpression,
): { name: string; kind: "plain" | "this" | "member"; calleeClassHint?: string } | undefined {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) {
    return { name: expr.text, kind: "plain" };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return { name: expr.name.text, kind: "this" };
    }
    if (ts.isIdentifier(expr.expression)) {
      const objName = expr.expression.text;
      if (GLOBAL_BUILTIN_NAMESPACES.has(objName)) {
        return undefined;
      }
      const hint = findClassHint(expr.expression);
      return {
        name: expr.name.text,
        kind: "member",
        calleeClassHint: hint,
      };
    }
    return {
      name: expr.name.text,
      kind: "member",
      calleeClassHint: undefined,
    };
  }
  return undefined;
}

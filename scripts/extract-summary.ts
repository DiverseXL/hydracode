import pc from "picocolors";
import { extractRepo } from "../src/extract/tsExtractor.js";

type Result = Awaited<ReturnType<typeof extractRepo>>[number];

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const patterns = process.argv.slice(2);
  const results = await extractRepo(repoRoot, patterns.length > 0 ? patterns : undefined);

  const count = (pick: (r: Result) => unknown[]): number =>
    results.reduce((n, r) => n + pick(r).length, 0);

  const fileCount = results.length;
  const functionCount = count((r) => r.functions);
  const classCount = count((r) => r.classes);
  const testCount = count((r) => r.tests);
  const callCount = count((r) => r.calls);
  const thisCallCount = results.reduce(
    (n, r) => n + r.calls.filter((c) => c.kind === "this").length,
    0,
  );
  const importCount = count((r) => r.imports);
  const externalImports = results.reduce(
    (n, r) => n + r.imports.filter((i) => i.isExternal).length,
    0,
  );
  const compilerResolved = results.reduce(
    (n, r) => n + r.imports.filter((i) => i.resolvedBy === "compiler").length,
    0,
  );
  const fallbackResolved = results.reduce(
    (n, r) => n + r.imports.filter((i) => i.resolvedBy === "fallback").length,
    0,
  );
  const methodOfCount = count((r) => r.methodOf);
  const extendsCount = count((r) => r.extends);

  console.log(pc.bold("hydracode extraction summary (dogfood: this repo's src/)"));
  console.log(`files:              ${fileCount}`);
  console.log(`functions:          ${functionCount}`);
  console.log(`classes:            ${classCount}`);
  console.log(`tests:              ${testCount}`);
  console.log(`calls (unresolved): ${callCount}  (of which this.*: ${thisCallCount})`);
  console.log(`imports:            ${importCount}  (external: ${externalImports}, compiler-resolved: ${compilerResolved}, fallback: ${fallbackResolved})`);
  console.log(`methodOf:           ${methodOfCount}`);
  console.log(`extends:            ${extendsCount}`);

  console.log(pc.bold("\nper-file:"));
  for (const r of results) {
    const thisCalls = r.calls.filter((c) => c.kind === "this").length;
    const extImports = r.imports.filter((i) => i.isExternal).length;
    console.log(
      `  ${r.file.path}: fn=${r.functions.length} cls=${r.classes.length} ` +
        `tests=${r.tests.length} calls=${r.calls.length} (this.*=${thisCalls}) ` +
        `imports=${r.imports.length} (ext=${extImports})`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(
    pc.red(`\nerror: ${err instanceof Error ? err.message : String(err)}`),
  );
  process.exitCode = 1;
});

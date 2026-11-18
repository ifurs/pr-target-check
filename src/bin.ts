import { main } from "./cli";

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    process.stderr.write(`pr-target-check: ${(e as Error).stack ?? e}\n`);
    process.exitCode = 2;
  },
);

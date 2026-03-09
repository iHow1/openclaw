import { runXhsCli } from "../src/xhs/cli.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  runXhsCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

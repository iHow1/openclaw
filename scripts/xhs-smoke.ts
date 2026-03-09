import { parseSmokeArgs, runSmoke } from "../src/xhs/smoke.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  runSmoke(parseSmokeArgs(process.argv.slice(2)))
    .then((report) => {
      for (const step of report.steps) {
        console.log(`[${step.status}] ${step.name}: ${step.detail}`);
      }
      for (const artifact of report.artifacts) {
        console.log(`[artifact] ${artifact.label}: ${artifact.summaryPath}`);
      }
      for (const note of report.cleanupNotes) {
        console.log(`[cleanup] ${note}`);
      }
      console.log(`SMOKE_REPORT_DIR: ${report.reportDir}`);
      console.log(`SMOKE_REPORT_PATH: ${report.reportPath}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

import { config, dashboardConfig } from "./config.js";
import { startDashboard, type Dataset } from "./dashboard/server.js";
import { FlagStore } from "./optimizations/flags.js";

const datasets: Dataset[] = [
  {
    id: "agent",
    label: "Telegram agent",
    databasePath: config.metricsDatabase,
    flagStore: new FlagStore(config.featureFlagsFile),
  },
];

if (dashboardConfig.benchmarkDatabase) {
  datasets.push({
    id: "benchmark",
    label: "Benchmark",
    databasePath: dashboardConfig.benchmarkDatabase,
    // The benchmark sets its own flags per run, so they are not editable here.
    flagStore: null,
  });
}

startDashboard({
  datasets,
  host: dashboardConfig.host,
  port: dashboardConfig.port,
});

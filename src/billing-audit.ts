import { closeDb } from './db';
import { runHourlyUsageAudit } from './services/billing';

const hourArg = process.argv[2];
const hourStart = hourArg ? new Date(hourArg) : new Date();

if (Number.isNaN(hourStart.getTime())) {
  console.error('Invalid hour_start argument; pass an ISO timestamp or omit it for the current hour.');
  process.exit(1);
}

runHourlyUsageAudit(hourStart)
  .then(async (audits) => {
    console.log(JSON.stringify({
      ok: true,
      hour_start: hourStart.toISOString(),
      audits_created: audits.length,
    }));
    await closeDb();
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });

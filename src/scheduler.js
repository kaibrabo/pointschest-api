import cron from 'node-cron';
import { runAllScrapers } from './scraper.js';

// Runs every day at 9:00am Eastern Time (UTC-4 summer / UTC-5 winter).
// node-cron uses the server's local timezone unless specified.
// We use America/New_York to always hit 9am ET regardless of DST.
const SCHEDULE = '0 9 * * *';
const TIMEZONE = 'America/New_York';

function startScheduler() {
  if (!cron.validate(SCHEDULE)) {
    console.error('[scheduler] Invalid cron expression:', SCHEDULE);
    return;
  }

  cron.schedule(
    SCHEDULE,
    async () => {
      console.log('[scheduler] Daily 9am ET scrape triggered');
      try {
        await runAllScrapers();
      } catch (err) {
        console.error('[scheduler] Unhandled error during scheduled scrape:', err.message);
      }
    },
    {
      timezone: TIMEZONE,
    }
  );

  console.log(`[scheduler] Daily scrape scheduled for 9:00am ET (${TIMEZONE})`);
}

export { startScheduler };

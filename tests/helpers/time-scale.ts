// Preloaded by `npm test` (node --import). Runs every wait and timeout in the
// KNX layer at a fraction of its real length so tests that sit through real
// protocol delays (restart settling, response timeouts, retry back-offs)
// finish quickly. Production always runs at scale 1.
import { setTimeScale } from '../../server/knx-connection.ts';

setTimeScale(Number(process.env.KNX_TEST_TIME_SCALE) || 0.1);

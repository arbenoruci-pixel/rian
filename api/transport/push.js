import { createBonusEvidenceHandler } from '../base-bonus-evidence.js';
import { authenticatePushActor, pushAction } from '../../lib/transportPushServer.js';

export default createBonusEvidenceHandler({
  authenticate: authenticatePushActor, action: pushAction, maxBodyBytes: 4096,
  errorPrefix: /^(PUSH_|AUTH_|DEVICE_)/,
});

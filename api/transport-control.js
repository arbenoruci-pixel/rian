import { createBonusEvidenceHandler } from './base-bonus-evidence.js';
import { controlAction } from '../lib/transportControlServer.js';
// Shared device authentication, same-origin enforcement and bounded JSON body.
export const config = { maxDuration: 60 };
export default createBonusEvidenceHandler({ action:controlAction, maxBodyBytes:65536, errorPrefix:/^(CONTROL_|BONUS_EVIDENCE_|AUTH_|DEVICE_)/ });

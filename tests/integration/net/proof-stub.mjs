// Transport integration only. The stack's relay scenarios use the real proof worker and chains.
import { proofStub } from '../../unit/core/helpers.mjs';
export const proveLock = async () => proofStub();
export const verifyLock = async () => true;

import loan from './loan.js';
import call from './call.js';
import put from './put.js';

export const products = Object.freeze({ loan, call, put });
export { loan, call, put };
export { deadlineOf, termsOf, assetOf } from './loan.js';
export default products;

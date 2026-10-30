import { shortRef } from './ids.js';

/** Reference shown to the user (e.g. #ABC123) and written next to the real error in the private server log. */
export const errorRef = () => `#${shortRef()}`;

/** Signing in at the till: open with a password, then a PIN per person. POS-CORE-002. */
export { openTill, staffOnTill, switchTo, closeTill, closeAllTills, actorFromStaffToken, actorForStampedSale, readToken, hashPassword, __resetAuthLocks, forgetStaff } from './auth.service';
export { offlineKeyFor, readMakerStamp } from './maker-stamp';

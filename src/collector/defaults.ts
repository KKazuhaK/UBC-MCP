declare const __UBC_DEFAULT_HUB__:string|undefined;
/**
 * The Hub this extension connects to with one click, set at build time from the manifest's page
 * bridge (scripts/default-hub.mjs). Empty in an unconfigured build: then every Hub goes through the popup.
 */
export const DEFAULT_HUB:string=typeof __UBC_DEFAULT_HUB__==='string'?__UBC_DEFAULT_HUB__:'';
/** Workday's UBC tenant, and its read-only View My Courses task. */
export const WORKDAY_ORIGIN='https://wd10.myworkday.com/ubc/';
export const WORKDAY_REGISTRATIONS_URL=WORKDAY_ORIGIN+'d/task/2998$28771.htmld';
/** The UBC connection page on a Hub. */
export const HUB_PAGE_PATH='/ubc/';
/** Page <-> extension messages on the Hub's UBC page use this channel name. */
export const BRIDGE_CHANNEL='ubc-companion';

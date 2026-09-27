/**
 * Devices the till runs on: registered by the device itself, kept fresh by a heartbeat, named and
 * placed by a manager. See devices.service for what a browser can and cannot know.
 */
export { heartbeat, list, update } from './devices.service';
export type { Heartbeat } from './devices.service';

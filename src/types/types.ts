import { ScannerTypes, UrlsCrawled } from '../constants/constants.js';
import { devices } from 'playwright';

export type ViewportSize = {
  width: number;
  height: number;
};

export interface IBboxLocation {
  // page: number;
  location: string;
  isVisible?: boolean;
  groupId?: string;
  bboxTitle?: string;
}

export type StructureTree = {
  name: string;
  children: StructureTree[] | StructureTree;
  ref: { num: number; gen: number };
  mcid?: number;
  pageIndex?: number;
};

export type DeviceDescriptor = typeof devices["any"]

export type viewportSettings = {
  deviceChosen: string;
  customDevice: string;
  viewportWidth: number;
  playwrightDeviceDetailsObject: DeviceDescriptor;
};

export type ScanDetails = {
  startTime: Date;
  endTime: Date;
  crawlType: ScannerTypes;
  requestUrl: URL;
  urlsCrawled: UrlsCrawled;
};

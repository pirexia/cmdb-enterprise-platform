export type TimelineKind = 'ci' | 'contract' | 'license' | 'decommission' | 'os' | 'software' | 'model';
export type MilestoneType = 'eol' | 'eos' | 'lastCheck' | 'end' | 'completed' | 'custom';
export type InheritedFrom = 'os' | 'software' | 'model' | 'contract' | 'license';

export interface TimelineMilestone {
  type: MilestoneType;
  date: string;          // yyyy-mm-dd
  label: string;
  inherited?: boolean;
  inheritedFrom?: InheritedFrom;
}

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  name: string;
  subType?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  milestones: TimelineMilestone[];
}

export interface TimelineFiltersData {
  ciTypes: { id: string; name: string }[];
  masterSubtypes: { id: string; name: string; kind: TimelineKind }[];
  dateTypes: { id: string; name: string; category: string }[];
  statuses: { value: string; label: string; kinds: TimelineKind[] }[];
}

export interface TimelineLegacyChild {
  source: InheritedFrom;
  sourceName: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  milestones: TimelineMilestone[];
}

export interface TimelineLegacyDates {
  ciId: string;
  children: TimelineLegacyChild[];
}

export type ZoomLevel = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface TimelineFiltersState {
  types: TimelineKind[];
  ciTypeId?: string;
  status: string[];
  dateTypes: string[];
  search: string;
}

export const DEFAULT_FILTERS: TimelineFiltersState = {
  types: ['ci', 'contract', 'license', 'decommission', 'os', 'software', 'model'],
  ciTypeId: undefined,
  status: [],
  dateTypes: ['eol', 'eos', 'end', 'start', 'completed', 'custom'],
  search: '',
};

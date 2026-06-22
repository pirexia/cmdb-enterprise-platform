export type TimelineKind = 'ci' | 'contract' | 'license' | 'decommission' | 'os' | 'software' | 'model';

export type MilestoneType = 'eol' | 'eos' | 'lastCheck' | 'end' | 'completed' | 'custom';

export type InheritedFrom = 'os' | 'software' | 'model' | 'contract' | 'license';

export interface TimelineMilestone {
  type: MilestoneType;
  date: string;        // ISO date string yyyy-mm-dd
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
  startDate?: string;   // ISO date — present for interval items (contracts, licenses)
  endDate?: string;     // ISO date — present for interval items
  milestones: TimelineMilestone[];
}

export interface TimelineFiltersData {
  ciTypes: { id: string; name: string }[];
  masterSubtypes: { id: string; name: string; kind: 'os' | 'software' | 'model' }[];
  dateTypes: { id: string; name: string; category: string }[];
  statuses: { value: string; label: string; kinds: TimelineKind[] }[];
}

/**
 * One related entity attached to a CI (OS, model, software, contract or license),
 * rendered as an indented child row under the CI in the timeline.
 */
export interface TimelineLegacyChild {
  source: InheritedFrom;
  sourceName: string;
  status?: string;
  startDate?: string;   // ISO — present for interval children (contracts, licenses)
  endDate?: string;     // ISO — present for interval children
  milestones: TimelineMilestone[];
}

export interface TimelineLegacyDates {
  ciId: string;
  children: TimelineLegacyChild[];
}

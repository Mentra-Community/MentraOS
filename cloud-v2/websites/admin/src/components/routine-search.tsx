import {TESTING_FIELD, TestingButton} from "./testing-ui";
import {useState} from "react";

export interface RoutineSearchFilters {search: string; platform: string; glasses: string}
export interface SearchableRoutine {title: string; purpose?: string; platform: string; glassesModels?: string[]}
export const EMPTY_ROUTINE_FILTERS: RoutineSearchFilters = {search: "", platform: "", glasses: ""};
export function hasRoutineFilters(filters: RoutineSearchFilters) {
  return Boolean(filters.search.trim() || filters.platform || filters.glasses);
}
export function matchesRoutineSearch(routine: SearchableRoutine, filters: RoutineSearchFilters) {
  const text = filters.search.trim().toLowerCase();
  return (!text || routine.title.toLowerCase().includes(text) || routine.purpose?.toLowerCase().includes(text) === true)
    && (!filters.platform || routine.platform === filters.platform)
    && (!filters.glasses || (filters.glasses === "no-glasses" ? routine.glassesModels?.length === 0 : routine.glassesModels?.includes(filters.glasses) === true));
}
export function useRoutineSearch() {
  return useState<RoutineSearchFilters>(EMPTY_ROUTINE_FILTERS);
}
export function RoutineSearch({filters, onChange, routines, countLabel}: {
  filters: RoutineSearchFilters; onChange: (filters: RoutineSearchFilters) => void; routines: SearchableRoutine[]; countLabel: string;
}) {
  const platforms = [...new Set([...routines.map(row => row.platform), ...(filters.platform ? [filters.platform] : [])])].sort();
  const glassesModels = [...new Set([...routines.flatMap(row => row.glassesModels ?? []), ...(filters.glasses && filters.glasses !== "no-glasses" ? [filters.glasses] : [])])].sort();
  const field = `mt-1 block ${TESTING_FIELD}`;
  return <>
    <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]" role="search" aria-label="Search routines">
      <label className="text-sm">Search routines<input type="search" className={field} value={filters.search} onChange={event => onChange({...filters, search: event.target.value})} placeholder="Name or description" /></label>
      <label className="text-sm">Platform<select className={field} value={filters.platform} onChange={event => onChange({...filters, platform: event.target.value})}>
        <option value="">All platforms</option>{platforms.map(value => <option key={value} value={value}>{value === "android" ? "Android" : value === "ios-on-mac" ? "iOS on Mac" : value}</option>)}
      </select></label>
      <label className="text-sm">Glasses<select className={field} value={filters.glasses} onChange={event => onChange({...filters, glasses: event.target.value})}>
        <option value="">All glasses</option><option value="no-glasses">No glasses required</option>{glassesModels.map(value => <option key={value} value={value}>{value === "mentra-live" ? "Mentra Live" : value}</option>)}
      </select></label>
    </div>
    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
      <p role="status" aria-live="polite">{countLabel}</p>
      {hasRoutineFilters(filters) && <TestingButton variant="ghost" onClick={() => onChange(EMPTY_ROUTINE_FILTERS)}>Clear filters</TestingButton>}
    </div>
  </>;
}

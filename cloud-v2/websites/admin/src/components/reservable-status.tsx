const styles:Record<string,string>={idle:'bg-[#e6f5ed] text-[#087d50]',running:'bg-blue-50 text-blue-700',active:'bg-blue-50 text-blue-700',reserved:'bg-blue-50 text-blue-700',returning:'bg-amber-50 text-amber-800',checking:'bg-amber-50 text-amber-800','in-repair':'bg-amber-50 text-amber-800','out-of-service':'bg-red-50 text-red-700'};
/** The caller establishes freshness from the authority observation, never from a rerender. */
export function ReservableStatusBadge({status,current}:{status:string;current:boolean}) {
  const value=current && (status in styles || status==='offline')?status:'unknown';
  return <span className={`rounded-md px-2 py-1 text-xs font-semibold ${styles[value]??'bg-[#f0f2ef] text-[#59655e]'}`}>{value[0]!.toUpperCase()+value.slice(1).replaceAll('-',' ')}</span>;
}

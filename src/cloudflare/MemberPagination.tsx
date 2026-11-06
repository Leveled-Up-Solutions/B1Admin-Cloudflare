import type { MemberPageState } from "./useMemberPage";

export const MemberPagination = ({ page, label }: { page: MemberPageState<unknown>; label: string }) => <div className="mp-pagination" aria-label={`${label} pagination`}>
  {page.error && <p role="alert" className="mp-alert">{page.error} <button type="button" onClick={page.reload}>Try again</button></p>}
  <p className="mp-muted" role="status">{page.loading ? `Loading ${label.toLowerCase()}…` : page.pagination ? page.pagination.count ? `Showing ${page.offset + 1}–${page.offset + page.pagination.count}${!page.pagination.hasMore && !page.pagination.truncated ? " · End of results" : ""}` : "No results." : ""}</p>
  {page.pagination?.truncated && <p className="mp-alert">More results exist. Refine the search or date range to continue.</p>}
  <div className="mp-button-row">
    <button className="mp-quiet" disabled={page.loading || page.offset === 0} onClick={page.previous}>Previous {label.toLowerCase()} page</button>
    <button className="mp-quiet" disabled={page.loading || !page.pagination?.hasMore} onClick={page.next}>Next {label.toLowerCase()} page</button>
  </div>
</div>;

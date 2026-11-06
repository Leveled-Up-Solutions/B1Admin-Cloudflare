import { MemberPagination } from "./MemberPagination";
import { ProfileRequestCard, type ProfileChangeRequest } from "./ProfileRequestReview";
import { useMemberPage } from "./useMemberPage";

interface Props { token: string; refresh: number; onChanged: () => void; onExpired: () => void }
export const MemberProfileRequests = ({ token, refresh, onChanged, onExpired }: Props) => {
  const mine = useMemberPage<ProfileChangeRequest>("/api/member/v1/profile-requests/my", token, {}, refresh, onExpired);
  const review = useMemberPage<ProfileChangeRequest>("/api/member/v1/profile-requests/review", token, {}, refresh, onExpired);
  return <section className="mp-profile-requests">
    <div className="mp-section-title"><h2>My profile and household requests</h2><button className="mp-quiet" onClick={onChanged}>Refresh profile requests</button></div>
    {mine.items.map(request => <ProfileRequestCard key={request.id} request={request} token={token} canCancel onChanged={onChanged} onExpired={onExpired} />)}
    <MemberPagination page={mine} label="My requests" />
    {(review.loading || review.error || review.items.length > 0 || review.offset > 0) && <><h2>Profile changes to review</h2><p className="mp-muted">Review the proposed fields before approving. Approval applies these changes to the church directory record.</p>
      {review.items.map(request => <ProfileRequestCard key={request.id} request={request} token={token} onChanged={onChanged} onExpired={onExpired} />)}
      <MemberPagination page={review} label="Review requests" />
    </>}
  </section>;
};

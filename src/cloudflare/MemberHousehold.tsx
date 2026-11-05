import React from "react";
import { memberErrorMessage, memberRequest, memberSessionExpired } from "./memberApi";
import type { MemberHouseholdData } from "./memberProfileTypes";

interface Props {
  token: string;
  disabled: boolean;
  familyAddEnabled: boolean;
  lastName: string;
  onBusy: (busy: boolean) => void;
  onExpired: () => void;
}

export const MemberHousehold = ({ token, disabled, familyAddEnabled, lastName, onBusy, onExpired }: Props) => {
  const [household, setHousehold] = React.useState<MemberHouseholdData | null>(null);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [uncertain, setUncertain] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const [first, setFirst] = React.useState("");
  const [last, setLast] = React.useState(lastName);
  const [phone, setPhone] = React.useState("");
  const [role, setRole] = React.useState("Other");

  React.useEffect(() => {
    let active = true; setLoading(true); setError("");
    memberRequest<MemberHouseholdData>("/api/member/v1/household", token)
      .then(result => { if (active) { setHousehold(result); setUncertain(false); } })
      .catch(problem => { if (active) { if (memberSessionExpired(problem)) onExpired(); setError(memberErrorMessage(problem)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, refresh, onExpired]);

  async function addMember(event: React.FormEvent) {
    event.preventDefault();
    if (saving || disabled || !household?.canAdd || !familyAddEnabled) return;
    setSaving(true); onBusy(true); setError(""); setNotice("");
    try {
      await memberRequest("/api/member/v1/household/members", token, { method: "POST", body: JSON.stringify({ first, last, mobilePhone: phone, householdRole: role }) });
      setAdding(false); setFirst(""); setLast(lastName); setPhone(""); setRole("Other");
      setNotice("Your family member has been added to your household."); setRefresh(value => value + 1);
    } catch (problem) {
      if (memberSessionExpired(problem)) onExpired();
      if (problem instanceof TypeError) { setAdding(false); setUncertain(true); setError("Could not confirm the addition. Refresh your household before adding this person again."); } else setError(memberErrorMessage(problem));
    } finally { setSaving(false); onBusy(false); }
  }

  return <section className="mp-card mp-profile" aria-labelledby="member-household-heading">
    <h2 id="member-household-heading">My household</h2>
    <p className="mp-muted">{household?.household?.name || "Your current household"}</p>
    {error && <p className="mp-alert" role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>Try again</button></p>}
    {notice && <p className="mp-notice" role="status">{notice}</p>}
    {loading ? <p role="status">Loading household…</p> : household && <>
      <ul className="mp-household-list">{household.members.map(member => <li key={member.id}><strong>{member.name.display}</strong>{member.isSelf && <span> · You</span>}<small>{member.householdRole || "Household member"}</small></li>)}</ul>
      {!household.members.length && <p className="mp-muted">No household members are listed.</p>}
      <p className="mp-muted">Only names and household roles are shown here. Contact your church office to move or edit an existing household member.</p>
      {familyAddEnabled && household.canAdd && !adding && <button className="mp-quiet" disabled={disabled || saving || uncertain} onClick={() => setAdding(true)}>Add family member</button>}
    </>}
    {adding && familyAddEnabled && household?.canAdd && <form onSubmit={addMember} aria-label="Add family member">
      <h3>Add family member</h3>
      <p className="mp-muted">Create a new record in your household. This does not create a sign-in account.</p>
      <fieldset className="mp-profile-fields" disabled={disabled || saving}>
        <legend>Family member details</legend>
        <label>Family member first name<input required maxLength={100} value={first} onChange={event => setFirst(event.target.value)} /></label>
        <label>Family member last name<input required maxLength={100} value={last} onChange={event => setLast(event.target.value)} /></label>
        <label>Family member mobile phone<input type="tel" maxLength={40} value={phone} onChange={event => setPhone(event.target.value)} /></label>
        <label>Household role<select value={role} onChange={event => setRole(event.target.value)}>{["Head", "Spouse", "Child", "Other"].map(value => <option key={value}>{value}</option>)}</select></label>
      </fieldset>
      <div className="mp-button-row"><button className="mp-primary" disabled={disabled || saving}>{saving ? "Adding…" : "Save family member"}</button><button className="mp-quiet" type="button" disabled={saving} onClick={() => setAdding(false)}>Cancel</button></div>
    </form>}
  </section>;
};

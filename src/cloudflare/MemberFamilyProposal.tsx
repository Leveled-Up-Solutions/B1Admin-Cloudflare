import React from "react";
import { memberErrorMessage, memberRequest, memberSessionExpired } from "./memberApi";
import { profileFieldLabels } from "./ProfileRequestReview";

interface Props { token: string; person: { id: string; name: { display: string } }; onSubmitted: () => void; onCancel: () => void; onBusy: (value: boolean) => void; onExpired: () => void }
const allowedFields = [
  "firstName", "middleName", "lastName", "nickName", "mobilePhone", "homePhone", "address1", "address2", "city", "state", "zip", "birthDate"
];
export const MemberFamilyProposal = ({ token, person, onSubmitted, onCancel, onBusy, onExpired }: Props) => {
  const [fields, setFields] = React.useState([{ field: "firstName", value: "" }]);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    const changes = Object.fromEntries(fields.map(({ field, value }) => [field, field === "birthDate" && !value ? null : value]));
    setBusy(true); onBusy(true); setError("");
    try {
      await memberRequest("/api/member/v1/profile-requests", token, { method: "POST", body: JSON.stringify({ kind: "family-edit", personId: person.id, changes }) });
      onSubmitted();
    } catch (problem) { if (memberSessionExpired(problem)) onExpired(); setError(memberErrorMessage(problem)); } finally { setBusy(false); onBusy(false); }
  }
  return <form onSubmit={submit} aria-label={`Propose changes for ${person.name.display}`} className="mp-family-proposal">
    <h3>Propose changes for {person.name.display}</h3><p className="mp-muted">Enter only the fields to change. Existing private contact details and birth dates are not shown. A reviewer must approve this proposal.</p>
    {error && <p className="mp-alert" role="alert">{error}</p>}
    <fieldset disabled={busy} className="mp-profile-fields"><legend>Proposed fields</legend>{fields.map((entry, index) => <div className="mp-proposal-field" key={index}>
      <label>Field {index + 1}<select value={entry.field} onChange={event => setFields(previous => previous.map((row, i) => i === index ? { field: event.target.value, value: "" } : row))}>{allowedFields.map(field => <option key={field} value={field} disabled={fields.some((row, i) => i !== index && row.field === field)}>{profileFieldLabels[field]}</option>)}</select></label>
      <label>Proposed {profileFieldLabels[entry.field].toLowerCase()}<input type={entry.field === "birthDate" ? "date" : entry.field.endsWith("Phone") ? "tel" : "text"} max={entry.field === "birthDate" ? new Date().toISOString().slice(0, 10) : undefined} required={entry.field === "firstName" || entry.field === "lastName"} maxLength={entry.field.endsWith("Name") ? 100 : entry.field.endsWith("Phone") ? 40 : 200} value={entry.value} onChange={event => setFields(previous => previous.map((row, i) => i === index ? { ...row, value: event.target.value } : row))} /></label>
      {!["firstName", "lastName"].includes(entry.field) && <p className="mp-muted">An empty value requests clearing this field.</p>}
      {fields.length > 1 && <button className="mp-quiet" type="button" onClick={() => setFields(previous => previous.filter((_, i) => i !== index))}>Remove field {index + 1}</button>}
    </div>)}</fieldset>
    <div className="mp-button-row"><button className="mp-quiet" type="button" disabled={busy || fields.length === allowedFields.length} onClick={() => { const field = allowedFields.find(value => !fields.some(row => row.field === value)); if (field) setFields(previous => [...previous, { field, value: "" }]); }}>Add another field</button><button className="mp-primary" disabled={busy}>Submit family changes</button><button className="mp-quiet" type="button" disabled={busy} onClick={onCancel}>Cancel proposal</button></div>
  </form>;
};
